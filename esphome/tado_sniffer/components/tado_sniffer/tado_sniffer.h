/**
 * @file tado_sniffer.h
 * @brief ESPHome custom component for sniffing Tado RF packets.
 * 
 * This component configures the SX1276 radio module to demodulate the FSK signals
 * used by Tado devices, parses the packets, tracks performance/diagnostic statistics,
 * and streams raw packet bytes over TCP to a remote server.
 */

#pragma once

#include <stdarg.h>
#include "esphome/core/component.h"
#include "esphome/core/hal.h"
#include "esphome/components/spi/spi.h"
#include "esphome/core/preferences.h"
#include <esp_system.h>
#ifdef ESP_IDF_VERSION_MAJOR
#if ESP_IDF_VERSION_MAJOR >= 4
#include <esp_mac.h>
#include <esp_netif.h>
#endif
#endif
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <esp_timer.h>
#include "esphome/components/switch/switch.h"
#include "esphome/components/number/number.h"
#include "esphome/components/text/text.h"
#include <lwip/sockets.h>
#include <lwip/netdb.h>
#include <errno.h>
#include <algorithm>

namespace esphome {
namespace tado_sniffer {

/**
 * @struct TadoSnifferSettings
 * @brief NVRAM-persisted settings for configuring the sniffer component.
 */
struct TadoSnifferSettings {
    uint8_t magic;         // 0xBB = valid settings stored in flash
    uint8_t channel;       // Sniffer radio channel (0-49)
    uint16_t tcp_port;     // Remote TCP socket port to stream logs/packets to
    char tcp_host[40];     // Remote TCP host IP address or domain
    bool print_stats;      // Enable/disable periodic printing of diagnostic stats
    bool sniff_raw;        // Enable/disable raw packet printing/streaming
} __attribute__((packed));

enum SX1276Reg {
    REG_FIFO = 0x00, REG_OP_MODE = 0x01, REG_BITRATE_MSB = 0x02, REG_BITRATE_LSB = 0x03,
    REG_FDEV_MSB = 0x04, REG_FDEV_LSB = 0x05, REG_FRF_MSB = 0x06, REG_FRF_MID = 0x07, REG_FRF_LSB = 0x08,
    REG_PA_CONFIG = 0x09, REG_PARAMP = 0x0A,
    REG_RX_CONFIG = 0x0D, REG_RSSICONFIG = 0x0E, REG_RSSIVALUE = 0x11, REG_RX_BW = 0x12,
    REG_AFC_BW = 0x13, REG_PREAMBLE_DETECT = 0x1F, REG_SYNC_CONFIG = 0x27,
    REG_SYNC_VALUE_1 = 0x28, REG_SYNC_VALUE_2 = 0x29, REG_SYNC_VALUE_3 = 0x2A, REG_SYNC_VALUE_4 = 0x2B,
    REG_SYNC_VALUE_5 = 0x2C, REG_SYNC_VALUE_6 = 0x2D, REG_SYNC_VALUE_7 = 0x2E, REG_SYNC_VALUE_8 = 0x2F,
    REG_PACKET_CONFIG_1 = 0x30, REG_PACKET_CONFIG_2 = 0x31, REG_PAYLOAD_LENGTH = 0x32,
    REG_FIFO_THRESH = 0x35,
    REG_SEQ_CONFIG_1 = 0x36, REG_IRQ_FLAGS_1 = 0x3E, REG_IRQ_FLAGS_2 = 0x3F, REG_VERSION = 0x42
};

struct ExposeInternalPin : public InternalGPIOPin {
  using InternalGPIOPin::attach_interrupt;
};

/**
 * @class TadoSniffer
 * @brief Manages the SPI connection to the SX1276 transceiver, parses packets,
 * and schedules background RTOS tasks for radio handling and packet processing.
 */
class TadoSniffer : public Component, public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW, spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_8MHZ> {
 public:
  static constexpr const char *const TAG = "tado_sniffer";

  /**
   * @brief Interrupt Service Routine for DIO0 (GDO0) packet-ready interrupt.
   * Notifies the background radio task.
   */
  static void IRAM_ATTR dio0_isr(void* arg) {
    TadoSniffer* sniffer = static_cast<TadoSniffer*>(arg);
    if (sniffer->radio_task_handle_ != nullptr) {
        BaseType_t xHigherPriorityTaskWoken = pdFALSE;
        vTaskNotifyGiveFromISR(sniffer->radio_task_handle_, &xHigherPriorityTaskWoken);
        if (xHigherPriorityTaskWoken == pdTRUE) {
            portYIELD_FROM_ISR();
        }
    }
  }

  struct QueuedPacket {
      uint8_t len;
      uint8_t buffer[128];
      int rssi;
      uint64_t timestamp_us;
      bool crc_ok;
  };

  struct LogMessage {
      char text[320];
  };

  SemaphoreHandle_t spi_mutex_{nullptr};
  QueueHandle_t packet_queue_{nullptr};
  QueueHandle_t log_queue_{nullptr};
  TaskHandle_t radio_task_handle_{nullptr};
  TaskHandle_t processing_task_handle_{nullptr};
  uint32_t dropped_packets_count_{0};

  // Real-time RF & TCP diagnostic stats
  uint32_t stats_rf_received_{0};
  uint32_t stats_rf_dropped_queue_full_{0};
  uint32_t stats_rf_filtered_mac_type_{0};
  uint32_t stats_tcp_sent_{0};
  uint32_t stats_tcp_send_failed_{0};
  uint32_t stats_rf_dropped_invalid_len_{0};
  uint32_t stats_rf_crc_failed_{0};
  uint32_t last_stats_print_{0};
  uint32_t last_fifo_check_{0};

  void lock_spi() {
    if (this->spi_mutex_ != nullptr) {
        xSemaphoreTakeRecursive(this->spi_mutex_, portMAX_DELAY);
    }
  }

  void unlock_spi() {
    if (this->spi_mutex_ != nullptr) {
        xSemaphoreGiveRecursive(this->spi_mutex_);
    }
  }
  
  bool sniff_raw_{true};
  std::string tcp_host_{"192.168.0.1"};
  int tcp_port_{9999};
  int tcp_sock_{-1};
  bool print_stats_{true};
  int channel_{26};
  uint32_t last_rx_time_{0};

  ESPPreferenceObject settings_pref_;

  switch_::Switch *sniff_raw_switch_{nullptr};
  switch_::Switch *print_stats_switch_{nullptr};
  number::Number *sniffer_channel_number_{nullptr};
  number::Number *tcp_port_number_{nullptr};
  text::Text *tcp_host_text_{nullptr};

  void set_sniff_raw_switch(switch_::Switch *s) { 
    this->sniff_raw_switch_ = s; 
    if (s != nullptr) s->publish_state(this->sniff_raw_);
  }
  void set_print_stats_switch(switch_::Switch *s) { 
    this->print_stats_switch_ = s; 
    if (s != nullptr) s->publish_state(this->print_stats_);
  }
  void set_sniffer_channel_number(number::Number *n) { 
    this->sniffer_channel_number_ = n; 
    if (n != nullptr) n->publish_state(this->channel_);
  }
  void set_tcp_port_number(number::Number *n) { 
    this->tcp_port_number_ = n; 
    if (n != nullptr) n->publish_state(this->tcp_port_);
  }
  void set_tcp_host_text(text::Text *t) { 
    this->tcp_host_text_ = t; 
    if (t != nullptr) t->publish_state(this->tcp_host_);
  }

  void set_dio0_pin(InternalGPIOPin *pin) { dio0_pin_ = pin; }
  void set_dio2_pin(InternalGPIOPin *pin) { dio2_pin_ = pin; }
  void set_rst_pin(InternalGPIOPin *pin) { rst_pin_ = pin; }
  void set_channel(int channel) { channel_ = channel; }
  void set_tcp_host(const std::string &host) { this->tcp_host_ = host; }
  void set_tcp_port(int port) { this->tcp_port_ = port; }

  // YAML UI Getters
  std::string get_tcp_host_str() { return this->tcp_host_; }
  int get_tcp_port() { return this->tcp_port_; }
  int get_channel() { return this->channel_; }

  void load_settings() {
    this->settings_pref_ = global_preferences->make_preference<TadoSnifferSettings>(3810293829ULL);
    TadoSnifferSettings stored;
    if (this->settings_pref_.load(&stored) && stored.magic == 0xBB) {
        this->channel_ = stored.channel;
        this->tcp_port_ = stored.tcp_port;
        this->tcp_host_ = std::string(stored.tcp_host);
        this->print_stats_ = stored.print_stats;
        this->sniff_raw_ = stored.sniff_raw;
        
        ESP_LOGI(TAG, "Restored settings from NVRAM: channel=%d, tcp=%s:%d, print_stats=%d, sniff_raw=%d",
            this->channel_, this->tcp_host_.c_str(), this->tcp_port_, this->print_stats_, this->sniff_raw_);
    } else {
        ESP_LOGI(TAG, "No valid settings found in NVRAM (magic mismatch). Using defaults.");
    }
  }

  void save_settings() {
    TadoSnifferSettings stored;
    stored.magic = 0xBB;
    stored.channel = this->channel_;
    stored.tcp_port = this->tcp_port_;
    memset(stored.tcp_host, 0, sizeof(stored.tcp_host));
    strncpy(stored.tcp_host, this->tcp_host_.c_str(), sizeof(stored.tcp_host) - 1);
    stored.print_stats = this->print_stats_;
    stored.sniff_raw = this->sniff_raw_;
    
    this->settings_pref_.save(&stored);
    global_preferences->sync();
    ESP_LOGI(TAG, "Settings saved to NVRAM.");
  }

  void set_channel_runtime(int channel) {
    if (channel < 0 || channel > 49) return;
    this->channel_ = channel;
    if (this->initialized_) {
        this->init_radio();
    }
    this->save_settings();
    if (this->sniffer_channel_number_ != nullptr) this->sniffer_channel_number_->publish_state(channel);
    ESP_LOGI(TAG, "Runtime channel changed to %d (%.4f MHz)", channel, get_channel_freq(channel));
  }

  void set_tcp_host_runtime(const std::string &host) {
    this->tcp_host_ = host;
    if (this->tcp_sock_ >= 0) {
        close(this->tcp_sock_);
        this->tcp_sock_ = -1;
    }
    this->save_settings();
    if (this->tcp_host_text_ != nullptr) this->tcp_host_text_->publish_state(host);
    ESP_LOGI(TAG, "Runtime TCP host changed to %s", host.c_str());
  }

  void set_tcp_port_runtime(int port) {
    if (port < 0 || port > 65535) return;
    this->tcp_port_ = port;
    if (this->tcp_sock_ >= 0) {
        close(this->tcp_sock_);
        this->tcp_sock_ = -1;
    }
    this->save_settings();
    if (this->tcp_port_number_ != nullptr) this->tcp_port_number_->publish_state(port);
    ESP_LOGI(TAG, "Runtime TCP port changed to %d", port);
  }

  void set_sniff_raw(bool enable) {
    this->sniff_raw_ = enable;
    this->save_settings();
    if (enable) {
        ESP_LOGI(TAG, "=== Sniffing Mode: SNIFF ALL RAW PACKETS ACTIVE ===");
    } else {
        ESP_LOGI(TAG, "=== Sniffing Mode: SNIFF DATA ONLY ACTIVE ===");
    }
    if (this->sniff_raw_switch_ != nullptr) {
        this->sniff_raw_switch_->publish_state(enable);
    }
  }

  void set_print_stats_runtime(bool print_stats) {
    this->print_stats_ = print_stats;
    this->save_settings();
    if (this->print_stats_switch_ != nullptr) this->print_stats_switch_->publish_state(print_stats);
    ESP_LOGI(TAG, "Runtime print stats changed to %s", print_stats ? "ON" : "OFF");
  }

  double get_channel_freq(uint8_t channel) {
    return 863.125 + (double)channel * 0.199951;
  }

  void set_tado_channel(uint8_t channel) {
    if (channel > 49) return;
    
    // Read current mode and put in SLEEP to write frequency
    uint8_t current_mode = read_reg(REG_OP_MODE);
    write_reg(REG_OP_MODE, 0x00); // SLEEP
    
    double freq_hz = 863125000.0 + (double)channel * 199951.0;
    uint32_t frf = (uint32_t)((freq_hz * 16384.0) / 1000000.0 + 0.5);
    
    uint8_t msb = (frf >> 16) & 0xFF;
    uint8_t mid = (frf >> 8) & 0xFF;
    uint8_t lsb = frf & 0xFF;
    
    write_reg(REG_FRF_MSB, msb);
    write_reg(REG_FRF_MID, mid);
    write_reg(REG_FRF_LSB, lsb);
    
    // Force RX mode if we were in RX mode
    uint8_t target_mode = (current_mode == 0x05) ? 0x05 : current_mode;
    write_reg(REG_OP_MODE, target_mode);
    delay(2); // Let PLL synthesizer stabilize and lock
    
    ESP_LOGI(TAG, "[Tado Radio] Channel %d set: FRF=0x%06X (%.4f MHz)", 
        channel, frf, get_channel_freq(channel));
        
    this->last_rx_time_ = millis();
  }

  void init_radio() {
    this->initialized_ = false;
    lock_spi();
    ESP_LOGI(TAG, "Initializing SX1276 Sniffer...");
    this->rst_pin_->digital_write(false); delay(10);
    this->rst_pin_->digital_write(true); delay(10);

    if (read_reg_fast(REG_VERSION) != 0x12) {
        unlock_spi();
        return;
    }

    write_reg_fast(REG_OP_MODE, 0x00); // SLEEP
    write_reg_fast(REG_BITRATE_MSB, 0x02); write_reg_fast(REG_BITRATE_LSB, 0x80); // 50kbps
    write_reg_fast(REG_FDEV_MSB, 0x01); write_reg_fast(REG_FDEV_LSB, 0xA0); // 25.39kHz deviation
    
    set_tado_channel(this->channel_);
    ESP_LOGI(TAG, "Tuning to static Tado channel %d (%.4f MHz)", this->channel_, get_channel_freq(this->channel_));

    write_reg_fast(0x0C, 0x23);

    write_reg_fast(REG_RX_CONFIG, 0x1E); // AfcAutoOn=1, AgcAutoOn=1, RxTrigger=PreambleDetect+RSSI
    write_reg_fast(REG_RX_BW, 0x0A);     // RX bandwidth: 100 kHz (Mant=20, Exp=2)
    write_reg_fast(REG_AFC_BW, 0x01);    // AFC bandwidth: 166.67 kHz (Mant=24, Exp=1)
    write_reg_fast(0x1A, 0x20);          // AfcAutoClearOn=1
    write_reg_fast(0x10, 0xD2);          // RegRssiThresh = -105 dBm
    write_reg_fast(0x25, 0x00); write_reg_fast(0x26, 0x04); // 4 preamble bytes (TX)
    write_reg_fast(REG_PREAMBLE_DETECT, 0xCA); // 3-byte preamble detection, tolerance=10
    write_reg_fast(REG_SYNC_CONFIG, 0x73); // 4-byte sync (D391D391)
    write_reg_fast(REG_SYNC_VALUE_1, 0xD3); write_reg_fast(REG_SYNC_VALUE_2, 0x91);
    write_reg_fast(REG_SYNC_VALUE_3, 0xD3); write_reg_fast(REG_SYNC_VALUE_4, 0x91);

    write_reg_fast(REG_PACKET_CONFIG_1, 0x99);  // Variable-length, CRC ON, CrcAutoClearOff=1, CCITT CRC
    write_reg_fast(REG_PACKET_CONFIG_2, 0x40);  // Packet mode
    write_reg_fast(REG_PAYLOAD_LENGTH, 127);    // Set max length to 127
    write_reg_fast(0x40, 0x0C);                 // Map DIO2 to SyncAddress (0x0C)
    write_reg_fast(REG_PA_CONFIG, 0x8F);        // PA_BOOST
    write_reg_fast(REG_PARAMP, 0x29);           // GFSK shaping BT=1.0
    write_reg_fast(REG_FIFO_THRESH, 0x8E);     // Threshold = 14
    write_reg_fast(REG_OP_MODE, 0x05); // RX (HF Mode)
    this->last_rx_time_ = millis();
    this->initialized_ = true;
    unlock_spi();
    ESP_LOGI(TAG, "SX1276 Initialized");
  }

  void write_reg(uint8_t reg, uint8_t val) {
    lock_spi();
    this->enable(); this->write_byte(reg | 0x80); this->write_byte(val); this->disable();
    unlock_spi();
  }

  uint8_t read_reg(uint8_t reg) {
    lock_spi();
    this->enable(); this->write_byte(reg & 0x7F); uint8_t val = this->read_byte(); this->disable();
    unlock_spi();
    return val;
  }

  void write_reg_fast(uint8_t reg, uint8_t val) {
    this->enable(); this->write_byte(reg | 0x80); this->write_byte(val); this->disable();
  }

  uint8_t read_reg_fast(uint8_t reg) {
    this->enable(); this->write_byte(reg & 0x7F); uint8_t val = this->read_byte(); this->disable();
    return val;
  }

  std::string format_hex(const uint8_t* data, size_t len) {
    std::string res;
    res.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        char buf[3];
        snprintf(buf, sizeof(buf), "%02X", data[i]);
        res += buf;
    }
    return res;
  }

  void queue_log(const char *format, ...) {
    if (this->log_queue_ == nullptr) return;
    LogMessage msg;
    va_list args;
    va_start(args, format);
    vsnprintf(msg.text, sizeof(msg.text), format, args);
    va_end(args);
    xQueueSend(this->log_queue_, &msg, pdMS_TO_TICKS(5));
  }

  void setup() override {
    this->spi_mutex_ = xSemaphoreCreateRecursiveMutex();
    this->packet_queue_ = xQueueCreate(100, sizeof(QueuedPacket));
    this->log_queue_ = xQueueCreate(100, sizeof(LogMessage));

    // Load settings from NVRAM
    this->load_settings();

    this->spi_setup();
    this->dio0_pin_->setup();
    if (this->dio2_pin_ != nullptr) {
        this->dio2_pin_->setup();
    }
    this->rst_pin_->setup();
    this->start_time_ = millis();

    static_cast<const ExposeInternalPin*>(this->dio0_pin_)->attach_interrupt(TadoSniffer::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
    if (this->dio2_pin_ != nullptr) {
        static_cast<const ExposeInternalPin*>(this->dio2_pin_)->attach_interrupt(TadoSniffer::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
    }

    // Spawn the background radio-task on Core 0 to handle FIFO operations asynchronously
    xTaskCreatePinnedToCore(
        [](void* param) {
            static_cast<TadoSniffer*>(param)->radio_task();
        },
        "tado_radio_task",
        4096,
        this,
        3, // High priority
        &this->radio_task_handle_,
        0 // Pinned to Core 0 (isolated from ESPHome loop task on Core 1)
    );

    // Spawn the background processing-task on Core 1 to handle packet processing asynchronously
    xTaskCreatePinnedToCore(
        [](void* param) {
            static_cast<TadoSniffer*>(param)->processing_task();
        },
        "tado_processing_task",
        8192,
        this,
        1, // Priority 1 (same as loopTask)
        &this->processing_task_handle_,
        1 // Pinned to Core 1
    );
  }

  void loop() override {
    if (!this->initialized_) {
        if (millis() - this->start_time_ > 10000) this->init_radio();
        return;
    }

    // Process queued log messages
    if (this->log_queue_ != nullptr) {
        LogMessage msg;
        int count = 0;
        while (count < 10 && xQueueReceive(this->log_queue_, &msg, 0) == pdTRUE) {
            ESP_LOGI(TAG, "%s", msg.text);
            count++;
        }
    }

    // Periodic statistics report every 60 seconds
    uint32_t now = millis();
    if (this->print_stats_ && now - this->last_stats_print_ > 60000) {
        ESP_LOGI(TAG, "=== Tado Sniffer Diagnostic Stats (Every 60s) ===");
        ESP_LOGI(TAG, "  * RF Packets Received (FIFO): %u", this->stats_rf_received_);
        ESP_LOGI(TAG, "  * Dropped (Invalid Length):   %u", this->stats_rf_dropped_invalid_len_);
        ESP_LOGI(TAG, "  * Queue Overflow Dropped:     %u (total: %u)", this->stats_rf_dropped_queue_full_, this->dropped_packets_count_);
        ESP_LOGI(TAG, "  * Filtered (MAC Type):        %u", this->stats_rf_filtered_mac_type_);
        ESP_LOGI(TAG, "  * HW CRC Failed:              %u", this->stats_rf_crc_failed_);
        ESP_LOGI(TAG, "  * TCP Packets Sent:           %u", this->stats_tcp_sent_);
        if (this->stats_tcp_send_failed_ > 0) {
            ESP_LOGW(TAG, "  * TCP Send Failures:          %u", this->stats_tcp_send_failed_);
        }
        ESP_LOGI(TAG, "================================================");
        this->last_stats_print_ = now;
    }
  }

 protected:
  InternalGPIOPin *dio0_pin_;
  InternalGPIOPin *dio2_pin_{nullptr};
  InternalGPIOPin *rst_pin_;
  uint32_t start_time_{0};
  bool initialized_{false};

  /**
   * @brief Radio background task loop.
   * Monitors the transceiver FIFO and registers on Core 0.
   * Reads incoming packet lengths and payload data on-the-fly.
   */
  void radio_task() {
    ESP_LOGI(TAG, "Radio background task started on Core %d", xPortGetCoreID());
    bool last_was_active = false;
    while (true) {
        if (!this->initialized_) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }

        bool keep_awake = (millis() - this->last_rx_time_ < 30);
        if (this->dio2_pin_ != nullptr && !last_was_active && !keep_awake) {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
        } else if (this->dio2_pin_ == nullptr) {
            if (!last_was_active && !keep_awake) {
                vTaskDelay(pdMS_TO_TICKS(1));
            } else {
                vTaskDelay(0);
            }
        } else {
            if (!keep_awake) {
                vTaskDelay(0);
            }
        }

        lock_spi();
        uint8_t irq1 = read_reg_fast(REG_IRQ_FLAGS_1);
        uint8_t irq2 = read_reg_fast(REG_IRQ_FLAGS_2);
        
        if (irq2 & 0x10) {
            this->queue_log("FIFO Overrun detected in task! Clearing FIFO.");
            this->last_rx_time_ = millis();
            write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
            write_reg_fast(REG_RX_CONFIG, 0x5E);
            last_was_active = false;
            unlock_spi();
            continue;
        }

        bool active = (irq1 & 0x1A) || !(irq2 & 0x40);

        if (!(irq2 & 0x40)) {
            read_packet_on_the_fly();
            last_was_active = false;
        } else if (active) {
            last_was_active = true;
        } else {
            last_was_active = false;
        }
        unlock_spi();

        uint32_t now = millis();
        if (now - this->last_fifo_check_ > 2000) {
            this->last_fifo_check_ = now;
            if (this->initialized_ && now - this->last_rx_time_ > 300000) {
                this->queue_log("RX watchdog timeout (300s)! Resetting FSK receiver.");
                this->reset_fifo();
                this->last_rx_time_ = now;
            }

            if (this->dropped_packets_count_ > 0) {
                this->queue_log("Queue overflow! Dropped %u packets since boot.", this->dropped_packets_count_);
            }
        }
    }
  }

  /**
   * @brief Packet processing task loop.
   * Dequeues received packets, checks CRC, performs address checks/filtering,
   * prints diagnostic logs, and forwards packet data to the TCP socket.
   */
  void processing_task() {
    ESP_LOGI(TAG, "Processing background task started on Core %d", xPortGetCoreID());
    QueuedPacket packet;
    while (true) {
        if (xQueueReceive(this->packet_queue_, &packet, portMAX_DELAY) == pdTRUE) {
            process_queued_packet(packet);
            vTaskDelay(0);
        }
    }
  }

  void read_packet_on_the_fly() {
    this->last_rx_time_ = millis();
    this->enable();
    this->write_byte(REG_FIFO & 0x7F);
    uint8_t len = this->read_byte();
    this->disable();

    uint8_t rssi_raw = read_reg_fast(REG_RSSIVALUE);

    if (len == 0 || len > 127) {
        this->queue_log("Invalid packet length byte: %d. Dropping and resetting FIFO.", len);
        this->stats_rf_dropped_invalid_len_++;
        write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
        write_reg_fast(REG_RX_CONFIG, 0x5E);
        return;
    }

    this->stats_rf_received_++;

    QueuedPacket packet;
    packet.len = len;
    
    uint8_t bytes_read = 0;
    uint32_t start_time = millis();
    uint8_t target_read_len = len - 1;

    while (bytes_read < target_read_len) {
        if (millis() - start_time > 30) {
            this->queue_log("Timeout reading packet on the fly! Read %d of %d bytes", bytes_read, len);
            write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
            write_reg_fast(REG_RX_CONFIG, 0x5E);
            return;
        }

        uint8_t irq2 = read_reg_fast(REG_IRQ_FLAGS_2);
        if (irq2 & 0x10) {
            this->queue_log("FIFO Overrun during on-the-fly read! Read %d of %d bytes", bytes_read, len);
            write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
            write_reg_fast(REG_RX_CONFIG, 0x5E);
            return;
        }

        if (irq2 & 0x20) {
            size_t burst_len = std::min((size_t)15, (size_t)(target_read_len - bytes_read));
            if (burst_len > 0) {
                this->enable();
                this->write_byte(REG_FIFO & 0x7F);
                this->read_array(packet.buffer + bytes_read, burst_len);
                bytes_read += burst_len;
                this->disable();
            }
        } else if (!(irq2 & 0x40) && bytes_read < target_read_len) {
            this->enable();
            this->write_byte(REG_FIFO & 0x7F);
            packet.buffer[bytes_read++] = this->read_byte();
            this->disable();
        } else if (bytes_read < target_read_len) {
            delayMicroseconds(80);
        }
    }

    packet.timestamp_us = esp_timer_get_time();

    if (!(read_reg_fast(REG_IRQ_FLAGS_2) & 0x04)) {
        delayMicroseconds(200);
    }

    uint32_t wait_start = micros();
    while (!(read_reg_fast(REG_IRQ_FLAGS_2) & 0x04)) {
        if (micros() - wait_start > 5000) {
            break;
        }
        delayMicroseconds(10);
    }

    uint8_t irq2_final = read_reg_fast(REG_IRQ_FLAGS_2);
    packet.crc_ok = (irq2_final & 0x02) != 0;

    while (bytes_read < len) {
        this->enable();
        this->write_byte(REG_FIFO & 0x7F);
        packet.buffer[bytes_read++] = this->read_byte();
        this->disable();
    }
    
    if (!packet.crc_ok) {
        //this->queue_log("Hardware CRC check failed for packet (len=%d)!", len);
        this->stats_rf_crc_failed_++;
        write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
        write_reg_fast(REG_RX_CONFIG, 0x5E);
        return;
    }

    packet.rssi = -(int)rssi_raw / 2;

    if (len >= 2) {
        uint8_t f_type = packet.buffer[0] & 0x07;
        bool keep = false;
        if (this->sniff_raw_) {
            keep = true;
        } else {
            if (f_type == 0x01) {
                keep = true;
            }
        }

        if (!keep) {
            this->stats_rf_filtered_mac_type_++;
            write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
            write_reg_fast(REG_RX_CONFIG, 0x5E);
            return;
        }
    }

    if (xQueueSend(this->packet_queue_, &packet, 0) != pdTRUE) {
        this->dropped_packets_count_++;
        this->stats_rf_dropped_queue_full_++;
    }
  }

  void process_queued_packet(const QueuedPacket &packet) {
    uint8_t len = packet.len;
    int rssi = packet.rssi;

    if (this->sniff_raw_) {
        this->queue_log("RAW PACKET [len=%d, RSSI=%d]: %s", 
            len, rssi, format_hex(packet.buffer, len).c_str());
    }

    if (this->tcp_port_ > 0 && !this->tcp_host_.empty()) {
        uint32_t station_ip = 0;
        bool has_ip = false;

#ifdef ESP_IDF_VERSION_MAJOR
        esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (netif != nullptr) {
            esp_netif_ip_info_t ip_info;
            if (esp_netif_get_ip_info(netif, &ip_info) == ESP_OK && ip_info.ip.addr != 0) {
                station_ip = ip_info.ip.addr;
                has_ip = true;
            }
        }
#else
        // Fallback for non-ESP-IDF frameworks
        has_ip = true;
#endif

        if (!has_ip) {
            return; // Defer sending until WiFi station has an assigned IP address
        }

        if (this->tcp_sock_ < 0) {
            this->tcp_sock_ = lwip_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            if (this->tcp_sock_ >= 0) {
                struct sockaddr_in dest_addr;
                memset(&dest_addr, 0, sizeof(dest_addr));
                dest_addr.sin_family = AF_INET;
                dest_addr.sin_port = htons(this->tcp_port_);
                
                struct hostent *server = lwip_gethostbyname(this->tcp_host_.c_str());
                if (server != nullptr) {
                    memcpy(&dest_addr.sin_addr.s_addr, server->h_addr, server->h_length);
                } else {
                    dest_addr.sin_addr.s_addr = inet_addr(this->tcp_host_.c_str());
                }
                
                // Configure socket timeouts (2 seconds)
                struct timeval tv;
                tv.tv_sec = 2;
                tv.tv_usec = 0;
                setsockopt(this->tcp_sock_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
                setsockopt(this->tcp_sock_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

                int nodelay = 1;
                setsockopt(this->tcp_sock_, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

                // Configure Keep-Alives
                int keepalive = 1;
                int keepidle = 5;
                int keepinterval = 2;
                int keepcount = 3;
                setsockopt(this->tcp_sock_, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
                setsockopt(this->tcp_sock_, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
                setsockopt(this->tcp_sock_, IPPROTO_TCP, TCP_KEEPINTVL, &keepinterval, sizeof(keepinterval));
                setsockopt(this->tcp_sock_, IPPROTO_TCP, TCP_KEEPCNT, &keepcount, sizeof(keepcount));

                int err = lwip_connect(this->tcp_sock_, (struct sockaddr *)&dest_addr, sizeof(dest_addr));
                if (err < 0) {
                    this->queue_log("TCP connect to %s:%d failed: errno=%d", this->tcp_host_.c_str(), this->tcp_port_, errno);
                    close(this->tcp_sock_);
                    this->tcp_sock_ = -1;
                } else {
                    this->queue_log("TCP socket connected to %s:%d (fd=%d)", this->tcp_host_.c_str(), this->tcp_port_, this->tcp_sock_);
                }
            } else {
                this->queue_log("Failed to create TCP socket: errno=%d", errno);
            }
        }

        if (this->tcp_sock_ >= 0) {
            std::vector<uint8_t> tcp_payload;
            size_t payload_len = 3 + len;
            tcp_payload.reserve(2 + payload_len);
            tcp_payload.push_back(0x5A); // Sync byte
            tcp_payload.push_back((uint8_t)payload_len); // Length of payload that follows
            tcp_payload.push_back((uint8_t)rssi);
            tcp_payload.push_back(packet.crc_ok ? 1 : 0);
            tcp_payload.push_back(len);
            for (size_t i = 0; i < len; i++) {
                tcp_payload.push_back(packet.buffer[i]);
            }
            
            int sent = lwip_write(this->tcp_sock_, tcp_payload.data(), tcp_payload.size());
            if (sent >= 0) {
                this->stats_tcp_sent_++;
            } else {
                this->stats_tcp_send_failed_++;
                this->queue_log("TCP write failed: errno=%d. Closing socket.", errno);
                close(this->tcp_sock_);
                this->tcp_sock_ = -1;
            }
        }
    }
  }

  void reset_fifo() {
    lock_spi();
    write_reg(REG_OP_MODE, 0x01); // STDBY
    delayMicroseconds(100);
    int flush_count = 0;
    while (!(read_reg_fast(REG_IRQ_FLAGS_2) & 0x40) && flush_count < 64) {
        read_reg_fast(REG_FIFO);
        flush_count++;
    }
    write_reg(REG_IRQ_FLAGS_2, 0x10);
    write_reg(REG_OP_MODE, 0x05); // RX
    unlock_spi();
  }
};

} // namespace tado_sniffer
} // namespace esphome
