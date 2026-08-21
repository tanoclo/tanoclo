/**
 * @file tado_pairing.h
 * @brief ESPHome custom component for mimicking and pairing Tado devices.
 * 
 * This component interfaces with an SX1276 radio transceiver over SPI, configures
 * FSK packet parameters matching Tado's protocol, and performs active mimicry 
 * challenges to extract the operational RF keys from the Tado Internet Bridge (IB).
 */

#pragma once

#include "esphome/core/component.h"
#include "esphome/core/hal.h"
#include "esphome/components/spi/spi.h"
#include "esphome/core/preferences.h"
#include <esp_system.h>
#ifdef ESP_IDF_VERSION_MAJOR
#if ESP_IDF_VERSION_MAJOR >= 4
#include <esp_mac.h>
#endif
#endif
#include <mbedtls/ccm.h>
#include <mbedtls/aes.h>
#include <aes/esp_aes.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <esp_timer.h>
#include "esphome/components/number/number.h"
#include "esphome/components/text/text.h"
#include "esphome/components/text_sensor/text_sensor.h"
#include <sstream>
#include <algorithm>
#include <vector>

namespace esphome {
namespace tado_pairing {

/**
 * @struct TadoPairingSettings
 * @brief NVRAM-persisted structures for storing state across reboots.
 */
struct TadoPairingSettings {
    uint8_t magic;         // 0xBB = valid pairing settings in flash
    uint8_t channel;       // Stored RF channel number
    uint8_t ib_mac[8];     // Discovered/configured target Internet Bridge MAC address
    uint8_t va_mac[8];     // Cloned/mimicked Valve Assistant MAC address
    uint16_t ib_pan_id;    // 802.15.4 PAN ID derived from IB MAC
    uint8_t rf_key[16];    // Decrypted/extracted operational 128-bit RF Key
    bool rf_key_found;     // Status indicating if key has been successfully recovered
    bool ib_mac_is_real;   // True if the IB MAC was observed or manually provided
} __attribute__((packed));

/**
 * @enum PairingState
 * @brief Tracks the active state machine of the pairing controller.
 */
enum PairingState {
    STATE_IDLE,                    // Wait for user interaction or passive logging
    STATE_DISCOVERING,             // Passive sniffer mode looking for IB beacons/packets
    STATE_PAIR_MIMIC_BROADCAST_RS, // Active challenge: Broadcast Router Solicitations
    STATE_PAIR_MIMIC_UNICAST_RS    // Active challenge: Unicast Router Solicitations to target
};

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
 * @class TadoPairing
 * @brief Handles low-level SPI operations, state-machine transitions, cryptography (CCM),
 * and FreeRTOS task coordination.
 */
class TadoPairing : public Component, public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW, spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_8MHZ> {
 public:
  static constexpr const char *const TAG = "tado_pairing";

  /**
   * @brief Interrupt Service Routine for DIO0 (GDO0) packet-received interrupt.
   * Wakes up the background radio loop.
   */
  static void IRAM_ATTR dio0_isr(void* arg) {
    TadoPairing* pairing = static_cast<TadoPairing*>(arg);
    if (pairing->radio_task_handle_ != nullptr) {
        BaseType_t xHigherPriorityTaskWoken = pdFALSE;
        vTaskNotifyGiveFromISR(pairing->radio_task_handle_, &xHigherPriorityTaskWoken);
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

  SemaphoreHandle_t spi_mutex_{nullptr};
  QueueHandle_t packet_queue_{nullptr};
  TaskHandle_t radio_task_handle_{nullptr};
  TaskHandle_t processing_task_handle_{nullptr};

  PairingState state_{STATE_IDLE};
  TadoPairingSettings settings_;
  int channel_{26};
  bool initialized_{false};
  uint32_t start_time_{0};
  uint32_t last_rx_time_{0};

  uint8_t beacon_seq_{0};
  std::string tx_debug_log_;

  // Pre-built packet for minimal-latency TX
  uint8_t pre_built_packet_[256];
  size_t pre_built_packet_len_{0};
  bool pre_built_packet_ready_{false};
  uint32_t op_boot_last_tx_time_{0};
  uint8_t op_boot_tx_count_{0};

  // Member variables replacing static locals
  bool ui_published_{false};
  uint32_t last_fifo_check_{0};

  // MAC ACK detection
  volatile bool ack_received_{false};
  uint8_t ack_seq_{0};
  uint64_t ack_timestamp_us_{0};

  int tx_power_{15}; // Default 15
  number::Number *tx_power_number_{nullptr};

  void print_tx_debug_log() {
      if (this->tx_debug_log_.empty()) return;
      std::stringstream ss(this->tx_debug_log_);
      std::string line;
      while (std::getline(ss, line)) {
          ESP_LOGI(TAG, "%s", line.c_str());
      }
      this->tx_debug_log_.clear();
  }

  const uint8_t pairing_key_[16] = {'t', 'a', 'd', 'o', ' ', 'p', 'a', 'i', 'r', 'i', 'n', 'g', ' ', 'k', 'e', 'y'};

  ESPPreferenceObject settings_pref_;

  InternalGPIOPin *dio0_pin_;
  InternalGPIOPin *dio2_pin_{nullptr};
  InternalGPIOPin *rst_pin_;

  text::Text *target_ib_mac_text_{nullptr};
  text::Text *target_va_mac_text_{nullptr};
  text_sensor::TextSensor *stored_rf_key_sensor_{nullptr};
  number::Number *sniffer_channel_number_{nullptr};

  void set_dio0_pin(InternalGPIOPin *pin) { this->dio0_pin_ = pin; }
  void set_dio2_pin(InternalGPIOPin *pin) { this->dio2_pin_ = pin; }
  void set_rst_pin(InternalGPIOPin *pin) { this->rst_pin_ = pin; }
  void set_channel(int channel) { this->channel_ = channel; }

  void set_target_ib_mac_text(text::Text *t) { this->target_ib_mac_text_ = t; }
  void set_target_va_mac_text(text::Text *t) { this->target_va_mac_text_ = t; }
  void set_stored_rf_key_sensor(text_sensor::TextSensor *s) { this->stored_rf_key_sensor_ = s; }
  void set_sniffer_channel_number(number::Number *n) { 
      this->sniffer_channel_number_ = n; 
      if (n != nullptr) n->publish_state(this->channel_);
  }

  void set_tx_power(int power) {
      if (power < 0 || power > 15) return;
      this->tx_power_ = power;
      if (this->initialized_) {
          lock_spi();
          uint8_t pa_config = 0x80 | (power & 0x0F);
          write_reg(REG_PA_CONFIG, pa_config);
          unlock_spi();
      }
      ESP_LOGI(TAG, "TX Power set to %d (pa_config=0x%02X)", power, 0x80 | power);
  }

  void set_tx_power_number(number::Number *n) {
      this->tx_power_number_ = n;
      if (n != nullptr) n->publish_state(this->tx_power_);
  }

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

  bool is_zero_mac(const uint8_t *mac) {
      for (int i = 0; i < 8; i++) {
          if (mac[i] != 0) return false;
      }
      return true;
  }

  void load_settings() {
    TadoPairingSettings loaded;
    if (this->settings_pref_.load(&loaded)) {
        if (loaded.magic == 0xBB) {
            this->channel_ = loaded.channel;
            memcpy(this->settings_.ib_mac, loaded.ib_mac, 8);
            memcpy(this->settings_.va_mac, loaded.va_mac, 8);
            this->settings_.ib_pan_id = loaded.ib_pan_id;
            memcpy(this->settings_.rf_key, loaded.rf_key, 16);
            this->settings_.rf_key_found = loaded.rf_key_found;
            this->settings_.ib_mac_is_real = loaded.ib_mac_is_real;
            this->settings_.magic = 0xBB;
            // Fallback to static VA MAC if not set / all zeros
            if (is_zero_mac(this->settings_.va_mac)) {
                const uint8_t static_va_mac[8] = {0x34, 0x12, 0x56, 0x31, 0x07, 0xC5, 0x1B, 0x00};
                memcpy(this->settings_.va_mac, static_va_mac, 8);
            }
            ESP_LOGI(TAG, "Restored pairing settings from NVRAM. VA MAC: %s", format_hex_be(this->settings_.va_mac, 8).c_str());
            return;
        }
    }
    ESP_LOGI(TAG, "No valid pairing settings found in NVRAM. Using defaults.");
    this->settings_.magic = 0;
    this->settings_.channel = this->channel_;
    memset(this->settings_.ib_mac, 0, 8);
    // Always use static VA MAC
    const uint8_t static_va_mac_default[8] = {0x34, 0x12, 0x56, 0x31, 0x07, 0xC5, 0x1B, 0x00};
    memcpy(this->settings_.va_mac, static_va_mac_default, 8);
    this->settings_.ib_pan_id = 0;
    memset(this->settings_.rf_key, 0, 16);
    this->settings_.rf_key_found = false;
    this->settings_.ib_mac_is_real = false;
  }

  void save_settings() {
    this->settings_.channel = this->channel_;
    this->settings_.magic = 0xBB;
    this->settings_pref_.save(&this->settings_);
    global_preferences->sync();
  }

  void setup() override {
    this->spi_mutex_ = xSemaphoreCreateRecursiveMutex();
    this->packet_queue_ = xQueueCreate(100, sizeof(QueuedPacket));

    this->settings_pref_ = global_preferences->make_preference<TadoPairingSettings>(3829103847ULL);
    this->load_settings();

    if (this->settings_.magic == 0xBB && !is_zero_mac(this->settings_.ib_mac)) {
        this->state_ = STATE_IDLE;
        ESP_LOGI(TAG, "Booted with target IB configured. State set to IDLE.");
    } else {
        this->state_ = STATE_DISCOVERING;
        ESP_LOGI(TAG, "Booted with empty target settings. State set to DISCOVERING.");
        ESP_LOGI(TAG, "[tado_pairing] Please put the Internet Bridge (IB) into pairing mode now after disconnecting it from the network.");
    }

    this->spi_setup();
    this->dio0_pin_->setup();
    if (this->dio2_pin_ != nullptr) {
        this->dio2_pin_->setup();
    }
    this->rst_pin_->setup();
    this->start_time_ = millis();

    xTaskCreatePinnedToCore(
        [](void* param) {
            static_cast<TadoPairing*>(param)->radio_task();
        },
        "tado_radio_task",
        4096,
        this,
        3,
        &this->radio_task_handle_,
        0
    );

    xTaskCreatePinnedToCore(
        [](void* param) {
            static_cast<TadoPairing*>(param)->processing_task();
        },
        "tado_processing_task",
        8192,
        this,
        1,
        &this->processing_task_handle_,
        1
    );

    static_cast<const ExposeInternalPin*>(this->dio0_pin_)->attach_interrupt(TadoPairing::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
    if (this->dio2_pin_ != nullptr) {
        static_cast<const ExposeInternalPin*>(this->dio2_pin_)->attach_interrupt(TadoPairing::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
    }
  }

  void loop() override {
    if (!this->initialized_) {
        if (millis() - this->start_time_ > 10000) this->init_radio();
        return;
    }

    uint32_t now = millis();

    // UI Initial publishing after bindings are established
    if (!this->ui_published_ && now - this->start_time_ > 2000) {
        this->ui_published_ = true;
        if (this->target_ib_mac_text_ != nullptr && this->settings_.magic == 0xBB && !is_zero_mac(this->settings_.ib_mac)) {
            this->target_ib_mac_text_->publish_state(format_hex_be(this->settings_.ib_mac, 8));
        }
        if (this->target_va_mac_text_ != nullptr) {
            this->target_va_mac_text_->publish_state(format_hex_be(this->settings_.va_mac, 8));
        }
        if (this->stored_rf_key_sensor_ != nullptr) {
            if (this->settings_.magic == 0xBB && this->settings_.rf_key_found) {
                this->stored_rf_key_sensor_->publish_state(format_hex(this->settings_.rf_key, 16));
            } else {
                this->stored_rf_key_sensor_->publish_state("Not Found");
            }
        }
    }

    // Reset VA Mimicry — Broadcast RS phase (pairing key)
    if (this->state_ == STATE_PAIR_MIMIC_BROADCAST_RS) {
        if (now - this->op_boot_last_tx_time_ > 4000) {
            this->op_boot_last_tx_time_ = now;
            this->op_boot_tx_count_++;
            
            this->build_pair_mimic_rs_broadcast_packet();
            this->print_tx_debug_log();
            
            if (this->pre_built_packet_ready_) {
                this->ack_received_ = false;
                this->ack_seq_ = 0;
                this->ack_timestamp_us_ = 0;
                
                bool ok = transmit_packet(this->pre_built_packet_, this->pre_built_packet_len_);
                this->pre_built_packet_ready_ = false;
                
                ESP_LOGI(TAG, "[Mimic] [Broadcast RS] Sent broadcast RS #%d (%d bytes, seq=%d) — %s",
                         this->op_boot_tx_count_, (int)this->pre_built_packet_len_, this->beacon_seq_, ok ? "OK" : "FAILED");
            }
            
            if (this->op_boot_tx_count_ >= 30) {
                ESP_LOGE(TAG, "[Mimic] [Broadcast RS] Failed to receive broadcast RA after 30 attempts. Aborting.");
                this->state_ = STATE_IDLE;
                this->init_radio();
            }
        }
    }

    // Reset VA Mimicry — Unicast RS phase (pairing key), waiting for /d/pair
    if (this->state_ == STATE_PAIR_MIMIC_UNICAST_RS) {
        if (now - this->op_boot_last_tx_time_ > 2000) {
            this->op_boot_last_tx_time_ = now;
            this->op_boot_tx_count_++;
            
            this->build_pair_mimic_rs_unicast_packet();
            this->print_tx_debug_log();
            
            if (this->pre_built_packet_ready_) {
                this->ack_received_ = false;
                this->ack_seq_ = 0;
                this->ack_timestamp_us_ = 0;
                
                bool ok = transmit_packet(this->pre_built_packet_, this->pre_built_packet_len_);
                this->pre_built_packet_ready_ = false;
                
                ESP_LOGI(TAG, "[Mimic] [Unicast RS] Sent Echo Request #%d (%d bytes, seq=%d) — %s",
                         this->op_boot_tx_count_, (int)this->pre_built_packet_len_, this->beacon_seq_, ok ? "OK" : "FAILED");
            }
            
            if (this->op_boot_tx_count_ >= 30) {
                ESP_LOGE(TAG, "[Mimic] [Unicast RS] Failed to receive /d/pair after 30 attempts. Aborting.");
                this->state_ = STATE_IDLE;
                this->init_radio();
            }
        }
    }
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

  void set_target_ib_mac(const std::string &mac_str) {
      uint8_t parsed[8];
      if (parse_mac_address(mac_str, parsed)) {
          memcpy(this->settings_.ib_mac, parsed, 8);
          this->settings_.ib_pan_id = this->settings_.ib_mac[0] | ((uint16_t)this->settings_.ib_mac[1] << 8);
          this->settings_.ib_mac_is_real = true;
          this->settings_.magic = 0xBB;
          this->save_settings();
          
          std::string display = format_hex_be(this->settings_.ib_mac, 8);
          if (this->target_ib_mac_text_ != nullptr) this->target_ib_mac_text_->publish_state(display);
          ESP_LOGI(TAG, "Target IB MAC configured manually: %s (PAN ID: %04X)", display.c_str(), this->settings_.ib_pan_id);
          
          if (this->state_ == STATE_DISCOVERING && !is_zero_mac(this->settings_.ib_mac)) {
              this->state_ = STATE_IDLE;
              this->init_radio();
          }
      } else {
          ESP_LOGW(TAG, "Invalid Target IB MAC address: %s", mac_str.c_str());
      }
  }

  void set_target_va_mac(const std::string &mac_str) {
      uint8_t parsed[8];
      if (parse_mac_address(mac_str, parsed)) {
          memcpy(this->settings_.va_mac, parsed, 8);
          this->settings_.magic = 0xBB;
          this->save_settings();
          
          std::string display = format_hex_be(this->settings_.va_mac, 8);
          if (this->target_va_mac_text_ != nullptr) this->target_va_mac_text_->publish_state(display);
          ESP_LOGI(TAG, "Target VA MAC configured manually: %s", display.c_str());
      } else {
          ESP_LOGW(TAG, "Invalid Target VA MAC address: %s", mac_str.c_str());
      }
  }

  void start_reset_mimic_challenge() {
      if (this->state_ == STATE_PAIR_MIMIC_BROADCAST_RS || 
          this->state_ == STATE_PAIR_MIMIC_UNICAST_RS) {
          ESP_LOGW(TAG, "Reset VA mimicry challenge already in progress!");
          return;
      }
      
      bool ib_valid = !is_zero_mac(this->settings_.ib_mac);
      if (!ib_valid) {
          ESP_LOGE(TAG, "[Mimic] Cannot start: Target IB MAC not configured!");
          return;
      }
      
      uint16_t target_va_short = this->settings_.va_mac[0] | ((uint16_t)this->settings_.va_mac[1] << 8);
      ESP_LOGI(TAG, "================================================");
      ESP_LOGI(TAG, "[Mimic] Starting Reset VA Mimicry Challenge...");
      ESP_LOGI(TAG, "  Target IB MAC: %s (PAN %04X)", format_hex_be(this->settings_.ib_mac, 8).c_str(), this->settings_.ib_pan_id);
      ESP_LOGI(TAG, "  Pretending to be VA: %s (Short: 0x%04X)", format_hex_be(this->settings_.va_mac, 8).c_str(), target_va_short);
      ESP_LOGI(TAG, "  Encryption: Static Pairing Key");
      ESP_LOGI(TAG, "  Goal: Extract Operational Key from IB /d/pair");
      ESP_LOGI(TAG, "================================================");
      
      this->state_ = STATE_PAIR_MIMIC_BROADCAST_RS;
      this->op_boot_tx_count_ = 0;
      this->op_boot_last_tx_time_ = 0; // Trigger immediately
      this->init_radio();
  }

  void reset_target_devices() {
      ESP_LOGI(TAG, "Resetting target devices and clearing settings...");
      memset(this->settings_.ib_mac, 0, 8);
      this->settings_.ib_pan_id = 0;
      this->settings_.rf_key_found = false;
      memset(this->settings_.rf_key, 0, 16);
      this->settings_.ib_mac_is_real = false;
      
      const uint8_t static_va_mac_default[8] = {0x34, 0x12, 0x56, 0x31, 0x07, 0xC5, 0x1B, 0x00};
      memcpy(this->settings_.va_mac, static_va_mac_default, 8);
      
      this->settings_.magic = 0;
      this->save_settings();

      if (this->target_ib_mac_text_ != nullptr) this->target_ib_mac_text_->publish_state("");
      if (this->stored_rf_key_sensor_ != nullptr) this->stored_rf_key_sensor_->publish_state("Not Found");

      this->state_ = STATE_DISCOVERING;
      this->init_radio();
      ESP_LOGI(TAG, "Passive discovery restarted. Please put Internet Bridge in pairing mode.");
  }

  uint16_t compute_ipv6_checksum(const uint8_t *src_ip, const uint8_t *dst_ip, uint8_t next_hdr, const uint8_t *data, uint16_t len) {
      uint32_t sum = 0;
      for (size_t i = 0; i < 16; i += 2) {
          sum += ((uint32_t)src_ip[i] << 8) | src_ip[i+1];
      }
      for (size_t i = 0; i < 16; i += 2) {
          sum += ((uint32_t)dst_ip[i] << 8) | dst_ip[i+1];
      }
      sum += (uint32_t)len;
      sum += (uint32_t)next_hdr;
      
      for (size_t i = 0; i < len - 1; i += 2) {
          sum += ((uint32_t)data[i] << 8) | data[i+1];
      }
      if (len & 1) {
          sum += ((uint32_t)data[len - 1] << 8);
      }
      
      while (sum >> 16) {
          sum = (sum & 0xFFFF) + (sum >> 16);
      }
      uint16_t csum = (uint16_t)(~sum);
      if (next_hdr == 17 && csum == 0) {
          csum = 0xFFFF;
      }
      return csum;
  }

  void get_link_local_ip(const uint8_t *le_mac, uint8_t *ip_out) {
      memset(ip_out, 0, 16);
      ip_out[0] = 0xFE;
      ip_out[1] = 0x80;
      ip_out[8] = le_mac[7] ^ 0x02;
      ip_out[9] = le_mac[6];
      ip_out[10] = le_mac[5];
      ip_out[11] = le_mac[4];
      ip_out[12] = le_mac[3];
      ip_out[13] = le_mac[2];
      ip_out[14] = le_mac[1];
      ip_out[15] = le_mac[0];
  }

  uint16_t compute_crc16_kermit(const uint8_t *data, size_t len) {
      uint16_t crc = 0x0000;
      const uint16_t poly = 0x8408;
      for (size_t i = 0; i < len; i++) {
          crc ^= data[i];
          for (int j = 0; j < 8; j++) {
              if (crc & 1) {
                  crc = (crc >> 1) ^ poly;
              } else {
                  crc = crc >> 1;
              }
          }
      }
      return crc;
  }

  void build_pair_mimic_rs_broadcast_packet() {
      this->beacon_seq_++;

      // 1. Build ICMPv6 Router Solicitation
      uint8_t icmp[24];
      memset(icmp, 0, 24);
      icmp[0] = 0x85; // Type 133: RS
      icmp[1] = 0x00; // Code 0
      icmp[8] = 0x01; // Option Type 1: Source Link-Layer Address
      icmp[9] = 0x02; // Length 2 (16 bytes)
      
      // Copy VA MAC in BE
      icmp[10] = this->settings_.va_mac[7];
      icmp[11] = this->settings_.va_mac[6];
      icmp[12] = this->settings_.va_mac[5];
      icmp[13] = this->settings_.va_mac[4];
      icmp[14] = this->settings_.va_mac[3];
      icmp[15] = this->settings_.va_mac[2];
      icmp[16] = this->settings_.va_mac[1];
      icmp[17] = this->settings_.va_mac[0];

      // Compute IPs
      uint8_t src_ip[16];
      get_link_local_ip(this->settings_.va_mac, src_ip);
      
      uint8_t dst_ip[16];
      memset(dst_ip, 0, 16);
      dst_ip[0] = 0xFF;
      dst_ip[1] = 0x02;
      dst_ip[15] = 0x02; // All-Routers Multicast: ff02::2

      uint16_t csum = compute_ipv6_checksum(src_ip, dst_ip, 58, icmp, 24);
      icmp[2] = (csum >> 8) & 0xFF;
      icmp[3] = csum & 0xFF;

      // 2. Build IEEE 802.15.4 Frame Header
      uint8_t frame_header[16];
      frame_header[0] = 0x49; // FCF low
      frame_header[1] = 0xE8; // FCF high
      frame_header[2] = this->beacon_seq_;
      frame_header[3] = 0xFF; // Dest PAN ID low
      frame_header[4] = 0xFF; // Dest PAN ID high
      frame_header[5] = this->settings_.va_mac[0];
      frame_header[6] = this->settings_.va_mac[1];
      frame_header[7] = this->settings_.va_mac[2];
      frame_header[8] = this->settings_.va_mac[3];
      frame_header[9] = this->settings_.va_mac[4];
      frame_header[10] = this->settings_.va_mac[5];
      frame_header[11] = this->settings_.va_mac[6];
      frame_header[12] = this->settings_.va_mac[7];
      frame_header[13] = 0x04;
      frame_header[14] = 0x01;
      frame_header[15] = 0x00;

      // 3. Build Plaintext
      uint8_t plaintext[32];
      plaintext[0] = 0x00;
      plaintext[1] = 0x00;
      plaintext[2] = 0x7B;
      plaintext[3] = 0x3B;
      plaintext[4] = 0x3A;
      plaintext[5] = 0x02;
      memcpy(plaintext + 6, icmp, 24);
      
      uint8_t crc_data[46];
      memcpy(crc_data, frame_header, 16);
      memcpy(crc_data + 16, plaintext, 30);
      uint16_t crc_val = this->compute_crc16_kermit(crc_data, 46);
      plaintext[30] = crc_val & 0xFF;
      plaintext[31] = (crc_val >> 8) & 0xFF;
      size_t pt_len = 32;

      // 4. Encrypt using PAIRING KEY
      uint8_t nonce[13];
      memcpy(nonce, frame_header, 13);
      uint8_t aad[16];
      memcpy(aad, frame_header, 16);

      mbedtls_ccm_context ctx;
      mbedtls_ccm_init(&ctx);
      int ret = mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, this->pairing_key_, 128);
      if (ret != 0) {
          ESP_LOGE(TAG, "[Mimic] Failed to set AES key for broadcast RS");
          mbedtls_ccm_free(&ctx);
          return;
      }
      
      uint8_t ct[32];
      uint8_t mic[4];
      ret = mbedtls_ccm_encrypt_and_tag(&ctx, pt_len, nonce, 13, aad, 16, plaintext, ct, mic, 4);
      mbedtls_ccm_free(&ctx);
      
      if (ret != 0) {
          ESP_LOGE(TAG, "[Mimic] Failed to encrypt broadcast RS");
          return;
      }
      
      size_t final_len = 0;
      memcpy(this->pre_built_packet_ + final_len, frame_header, 16); final_len += 16;
      memcpy(this->pre_built_packet_ + final_len, ct, pt_len); final_len += pt_len;
      memcpy(this->pre_built_packet_ + final_len, mic, 4); final_len += 4;
      this->pre_built_packet_len_ = final_len;
      this->pre_built_packet_ready_ = true;

      this->tx_debug_log_.clear();
      char tbuf[256];
      snprintf(tbuf, sizeof(tbuf), "[Mimic] Generated Broadcast RS (Seq: %d, Pairing Key)\n", this->beacon_seq_);
      this->tx_debug_log_ += tbuf;
      snprintf(tbuf, sizeof(tbuf), "[Mimic] Plaintext:  %s\n", format_hex(plaintext, pt_len).c_str());
      this->tx_debug_log_ += tbuf;
      snprintf(tbuf, sizeof(tbuf), "[Mimic] Packet:     %s\n", format_hex(this->pre_built_packet_, final_len).c_str());
      this->tx_debug_log_ += tbuf;
  }

  void build_pair_mimic_rs_unicast_packet() {
      this->beacon_seq_++;

      // 1. Build ICMPv6 Echo Request (Type 128)
      uint8_t icmp[8];
      icmp[0] = 0x80; // Type 128: Echo Request
      icmp[1] = 0x00; // Code 0
      icmp[2] = 0x00; // checksum
      icmp[3] = 0x00;
      icmp[4] = 0x40; // Identifier
      icmp[5] = 0x40;
      icmp[6] = 0x07; // Sequence Number
      icmp[7] = 0x08;

      uint8_t src_ip[16];
      get_link_local_ip(this->settings_.va_mac, src_ip);

      uint8_t dst_ip[16];
      get_link_local_ip(this->settings_.ib_mac, dst_ip);

      uint16_t csum = compute_ipv6_checksum(src_ip, dst_ip, 58, icmp, 8);
      icmp[2] = (csum >> 8) & 0xFF;
      icmp[3] = csum & 0xFF;

      // 2. Build IEEE 802.15.4 Frame Header
      uint8_t frame_header[16];
      frame_header[0] = 0x69; // FCF low
      frame_header[1] = 0xEC; // FCF high
      frame_header[2] = this->beacon_seq_;
      frame_header[3] = this->settings_.ib_pan_id & 0xFF;
      frame_header[4] = (this->settings_.ib_pan_id >> 8) & 0xFF;
      memcpy(frame_header + 5, this->settings_.ib_mac + 2, 6);
      memcpy(frame_header + 11, this->settings_.va_mac, 2);
      memcpy(frame_header + 13, this->settings_.va_mac + 2, 3);

      // 3. Build Plaintext
      uint8_t plaintext[32];
      size_t pt_len = 0;
      plaintext[pt_len++] = this->settings_.va_mac[5];
      plaintext[pt_len++] = this->settings_.va_mac[6];
      plaintext[pt_len++] = this->settings_.va_mac[7];
      plaintext[pt_len++] = 0x04;
      plaintext[pt_len++] = this->beacon_seq_;
      plaintext[pt_len++] = 0x00;
      plaintext[pt_len++] = 0x00;
      plaintext[pt_len++] = 0x00;
      plaintext[pt_len++] = 0x7A; // Dispatch
      plaintext[pt_len++] = 0x33;
      plaintext[pt_len++] = 0x3A; // Next Header: ICMPv6

      memcpy(plaintext + pt_len, icmp, 8);
      pt_len += 8;

      uint8_t crc_data[35];
      memcpy(crc_data, frame_header, 16);
      memcpy(crc_data + 16, plaintext, 19);
      uint16_t crc_val = this->compute_crc16_kermit(crc_data, 35);
      plaintext[19] = crc_val & 0xFF;
      plaintext[20] = (crc_val >> 8) & 0xFF;
      pt_len = 21;

      // 4. Encrypt using PAIRING KEY
      uint8_t nonce[13];
      memcpy(nonce, frame_header, 13);
      uint8_t aad[16];
      memcpy(aad, frame_header, 16);

      mbedtls_ccm_context ctx;
      mbedtls_ccm_init(&ctx);
      int ret = mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, this->pairing_key_, 128);
      if (ret != 0) {
          ESP_LOGE(TAG, "[Mimic] Failed to set AES key for unicast RS");
          mbedtls_ccm_free(&ctx);
          return;
      }
      
      uint8_t ct[32];
      uint8_t mic[4];
      ret = mbedtls_ccm_encrypt_and_tag(&ctx, pt_len, nonce, 13, aad, 16, plaintext, ct, mic, 4);
      mbedtls_ccm_free(&ctx);
      
      if (ret != 0) {
          ESP_LOGE(TAG, "[Mimic] Failed to encrypt unicast RS");
          return;
      }
      
      size_t final_len = 0;
      memcpy(this->pre_built_packet_ + final_len, frame_header, 16); final_len += 16;
      memcpy(this->pre_built_packet_ + final_len, ct, pt_len); final_len += pt_len;
      memcpy(this->pre_built_packet_ + final_len, mic, 4); final_len += 4;
      this->pre_built_packet_len_ = final_len;
      this->pre_built_packet_ready_ = true;

      this->tx_debug_log_.clear();
      char tbuf2[256];
      snprintf(tbuf2, sizeof(tbuf2), "[Mimic] Generated Unicast Echo Request (Seq: %d, Pairing Key)\n", this->beacon_seq_);
      this->tx_debug_log_ += tbuf2;
      snprintf(tbuf2, sizeof(tbuf2), "[Mimic] Plaintext:  %s\n", format_hex(plaintext, pt_len).c_str());
      this->tx_debug_log_ += tbuf2;
      snprintf(tbuf2, sizeof(tbuf2), "[Mimic] Packet:     %s\n", format_hex(this->pre_built_packet_, final_len).c_str());
      this->tx_debug_log_ += tbuf2;
  }

  int is_ib_mac(const uint8_t* mac, uint8_t* cleaned_mac_out) {
      if (mac[4] == 0x55 && mac[5] == 0x31 && mac[6] == 0x07 && mac[7] == 0xC5) {
          cleaned_mac_out[0] = mac[2];
          cleaned_mac_out[1] = mac[3];
          cleaned_mac_out[2] = mac[4];
          cleaned_mac_out[3] = mac[5];
          cleaned_mac_out[4] = mac[6];
          cleaned_mac_out[5] = mac[7];
          cleaned_mac_out[6] = 0x1B;
          cleaned_mac_out[7] = 0x00;
          return 2;
      }
      if (mac[2] == 0x55 && mac[3] == 0x31 && mac[4] == 0x07 && mac[5] == 0xC5 && mac[6] == 0x1B && mac[7] == 0x00) {
          memcpy(cleaned_mac_out, mac, 8);
          return 1;
      }
      if (mac[0] == 0x55 && mac[1] == 0x31 && mac[2] == 0x07 && mac[3] == 0xC5 && mac[4] == 0x1B && mac[5] == 0x00) {
          cleaned_mac_out[0] = mac[6];
          cleaned_mac_out[1] = mac[7];
          memcpy(cleaned_mac_out + 2, mac, 6);
          return 3;
      }
      return 0;
  }

 protected:
  double get_channel_freq(uint8_t channel) {
    return 863.125 + (double)channel * 0.199951;
  }

  void set_tado_channel(uint8_t channel) {
    if (channel > 49) return;
    
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
    
    uint8_t target_mode = (current_mode == 0x05) ? 0x05 : current_mode;
    write_reg(REG_OP_MODE, target_mode);
    delay(2);
    
    ESP_LOGI(TAG, "[Tado Radio] Channel %d set: FRF=0x%06X (%.4f MHz)", 
        channel, frf, get_channel_freq(channel));
        
    this->last_rx_time_ = millis();
  }

  void init_radio() {
    this->initialized_ = false;
    lock_spi();
    ESP_LOGI(TAG, "Initializing SX1276 for Pairing...");
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

    write_reg_fast(0x0C, 0x23);

    write_reg_fast(REG_RX_CONFIG, 0x1E); // AfcAutoOn=1, AgcAutoOn=1, RxTrigger=PreambleDetect+RSSI
    write_reg_fast(REG_RX_BW, 0x0A);     // RX bandwidth: 100 kHz
    write_reg_fast(REG_AFC_BW, 0x01);    // AFC bandwidth: 166.67 kHz
    write_reg_fast(0x1A, 0x20);          // AfcAutoClearOn=1
    write_reg_fast(0x10, 0xD2);          // RegRssiThresh = -105 dBm
    //write_reg_fast(0x25, 0x00); write_reg_fast(0x26, 0x10); // 16 preamble bytes TX (2.56ms at 50kbps)
    write_reg_fast(0x25, 0x00); write_reg_fast(0x26, 0x04); // 4 preamble bytes TX (640µs at 50kbps — matches native CC110L MDMCFG1=0x22)
    write_reg_fast(REG_PREAMBLE_DETECT, 0xCA); // 3-byte preamble detection
    write_reg_fast(REG_SYNC_CONFIG, 0x73); // 4-byte sync D391D391 (matches CC110L 30/32 mode), AutoRestartRx=01, PreamblePolarity=0x55
    write_reg_fast(REG_SYNC_VALUE_1, 0xD3); write_reg_fast(REG_SYNC_VALUE_2, 0x91);
    write_reg_fast(REG_SYNC_VALUE_3, 0xD3); write_reg_fast(REG_SYNC_VALUE_4, 0x91);

    write_reg_fast(REG_PACKET_CONFIG_1, 0x99);  // Variable-length, CRC ON, IBM CRC (0x8005)
    write_reg_fast(REG_PACKET_CONFIG_2, 0x40);  // Packet mode
    write_reg_fast(REG_PAYLOAD_LENGTH, 127);
    write_reg_fast(0x40, 0x0C);                 // Map DIO2 to SyncAddress
    write_reg_fast(REG_PA_CONFIG, 0x80 | (this->tx_power_ & 0x0F)); // PA_BOOST with configured power
    write_reg_fast(REG_PARAMP, 0x29);           // GFSK shaping BT=1.0 (matches CC110L)
    write_reg_fast(REG_FIFO_THRESH, 0x8E);

    if (this->state_ == STATE_IDLE) {
        write_reg_fast(REG_OP_MODE, 0x00); // SLEEP
    } else {
        write_reg_fast(REG_OP_MODE, 0x05); // RX (HF Mode)
    }
    
    this->last_rx_time_ = millis();
    this->initialized_ = true;
    unlock_spi();
    ESP_LOGI(TAG, "SX1276 Initialized for state %d", (int)this->state_);
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

  bool transmit_packet(const uint8_t* data, size_t len) {
    if (len == 0 || len > 255) return false;

    lock_spi();

    // Switch to STDBY — only needs ~100µs to settle, not 1ms
    write_reg_fast(REG_OP_MODE, 0x01); // STDBY
    delayMicroseconds(150);

    // Flush any leftover RX/TX bytes from FIFO before writing new TX data
    int flush_count = 0;
    while (!(read_reg_fast(REG_IRQ_FLAGS_2) & 0x40) && flush_count < 64) {
        read_reg_fast(REG_FIFO);
        flush_count++;
    }
    write_reg_fast(REG_IRQ_FLAGS_2, 0x10); // Reset FIFO flags

    // Pre-load FIFO with length byte + up to 63 bytes of data
    size_t written = 0;
    this->enable();
    this->write_byte(REG_FIFO | 0x80);
    this->write_byte((uint8_t)len);
    size_t initial_chunk = std::min(len, (size_t)63);
    for (size_t i = 0; i < initial_chunk; i++) {
        this->write_byte(data[i]);
    }
    written = initial_chunk;
    this->disable();

    // TX mode — preamble goes on air after PLL lock (~100µs)
    write_reg_fast(REG_OP_MODE, 0x03);

    // Stream remaining bytes into FIFO as space becomes available
    while (written < len) {
        uint8_t irq2 = read_reg_fast(REG_IRQ_FLAGS_2);
        if (!(irq2 & 0x20)) { // FIFO not full
            size_t chunk = std::min(len - written, (size_t)32);
            this->enable();
            this->write_byte(REG_FIFO | 0x80);
            for (size_t i = 0; i < chunk; i++) {
                this->write_byte(data[written + i]);
            }
            this->disable();
            written += chunk;
        }
        delayMicroseconds(100);
    }

    // Wait for TX complete (PacketSent flag)
    uint32_t tx_start = millis();
    while (!(read_reg_fast(REG_IRQ_FLAGS_2) & 0x08)) {
        if (millis() - tx_start > 100) {
            ESP_LOGW(TAG, "TX timeout!");
            if (this->state_ == STATE_IDLE) {
                write_reg_fast(REG_OP_MODE, 0x00); // SLEEP
            } else {
                write_reg_fast(REG_OP_MODE, 0x05); // RX
            }
            unlock_spi();
            return false;
        }
    }

    // Switch back to RX to listen for ACK
    if (this->state_ == STATE_IDLE) {
        write_reg_fast(REG_OP_MODE, 0x00); // SLEEP
    } else {
        write_reg_fast(REG_OP_MODE, 0x05); // RX
    }
    unlock_spi();
    return true;
  }

  bool decrypt_packet(const uint8_t* key, const uint8_t* frame, size_t len, uint8_t* plaintext_out, size_t& pt_len) {
    if (len < 21) return false;
    
    uint16_t fcf = frame[0] | (frame[1] << 8);
    if (!(fcf & 0x08)) return false;
    
    uint8_t nonce[13];
    memcpy(nonce, frame, 13);
    
    uint8_t aad[16];
    memcpy(aad, frame, 16);
    
    size_t ct_len = len - 20;
    const uint8_t* ciphertext = frame + 16;
    const uint8_t* mic = frame + 16 + ct_len;
    
    mbedtls_ccm_context ctx;
    mbedtls_ccm_init(&ctx);
    
    int ret = mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 128);
    if (ret != 0) {
        mbedtls_ccm_free(&ctx);
        return false;
    }
    
    ret = mbedtls_ccm_auth_decrypt(&ctx, ct_len, nonce, 13, aad, 16, ciphertext, plaintext_out, mic, 4);
    mbedtls_ccm_free(&ctx);
    
    if (ret == 0) {
        pt_len = ct_len;
        return true;
    }
    return false;
  }

  /**
   * @brief Radio hardware controller background loop.
   * Runs on Core 0. Monitors FIFO state and interrupt flags to extract packets on-the-fly,
   * avoiding RX queue overflow.
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
            ESP_LOGW(TAG, "FIFO Overrun detected in task! Clearing FIFO.");
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
        if (now - this->last_fifo_check_ > 1000) {
            this->last_fifo_check_ = now;
            if (this->initialized_ && this->state_ != STATE_IDLE && now - this->last_rx_time_ > 30000) {
                ESP_LOGW(TAG, "RX watchdog timeout (30s)! Resetting FSK receiver.");
                this->reset_fifo();
                this->last_rx_time_ = now;
            }
        }
    }
  }

  /**
   * @brief Packet processing task running on Core 1.
   * Handles CPU-intensive tasks such as decryption, validation, MAC address parsing,
   * and state machine transitions without blocking SPI transfers.
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
        write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
        write_reg_fast(REG_RX_CONFIG, 0x5E);
        return;
    }

    QueuedPacket packet;
    packet.len = len;
    
    uint8_t bytes_read = 0;
    uint32_t start_time = millis();
    uint8_t target_read_len = len - 1;

    while (bytes_read < target_read_len) {
        if (millis() - start_time > 30) {
            write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
            write_reg_fast(REG_RX_CONFIG, 0x5E);
            return;
        }

        uint8_t irq2 = read_reg_fast(REG_IRQ_FLAGS_2);
        if (irq2 & 0x10) {
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
        write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
        write_reg_fast(REG_RX_CONFIG, 0x5E);
        return;
    }
    
    packet.rssi = -(int)rssi_raw / 2;

    if (len >= 2) {
        uint8_t f_type = packet.buffer[0] & 0x07;
        bool keep = false;
        if (f_type == 0x01) {
            uint8_t addr_mode = packet.buffer[1] & 0xCC;
            if (addr_mode == 0xCC || addr_mode == 0xC8) {
                keep = true;
            }
        } else if (f_type == 0x02) {
            // MAC ACK frame (Type 0x02) — accept during active pairing phases
            if (this->state_ == STATE_PAIR_MIMIC_BROADCAST_RS ||
                this->state_ == STATE_PAIR_MIMIC_UNICAST_RS) {
                keep = true;
            }
        }

        if (!keep) {
            write_reg_fast(REG_IRQ_FLAGS_2, 0x10);
            write_reg_fast(REG_RX_CONFIG, 0x5E);
            return;
        }
    }

    if (xQueueSend(this->packet_queue_, &packet, 0) != pdTRUE) {
        // Drop packet if queue full
    }
  }

  void process_queued_packet(const QueuedPacket &packet) {
    uint8_t len = packet.len;
    const uint8_t* frame = packet.buffer;
    uint8_t frame_type = frame[0] & 0x07;

    // 0. Frame Type 0x02 Handling (MAC ACK)
    if (frame_type == 0x02) {
        if (this->state_ != STATE_PAIR_MIMIC_UNICAST_RS) return;

        uint8_t ack_seq = frame[2];
        if (ack_seq == this->beacon_seq_) {
            this->ack_received_ = true;
            this->ack_seq_ = ack_seq;
            this->ack_timestamp_us_ = packet.timestamp_us;
            ESP_LOGI(TAG, "[Mimic] *** MAC ACK RECEIVED! *** seq=0x%02X", ack_seq);
        }
        return;
    }

    // 1. Data Frame Processing
    uint8_t plaintext[128];
    size_t pt_len = 0;
    bool decrypted = decrypt_packet(this->pairing_key_, frame, len, plaintext, pt_len);

    if (decrypted) {
        // Reconstruct Frame Addresses based on FCF addressing modes
        uint8_t fcf_msb = frame[1];
        uint8_t dest_mode = (fcf_msb >> 2) & 0x03;
        uint8_t src_mode = (fcf_msb >> 6) & 0x03;

        uint8_t src_ext[8];
        uint8_t dst_ext[8];
        memset(src_ext, 0, 8);
        memset(dst_ext, 0, 8);

        if (dest_mode == 3 && src_mode == 3) {
            dst_ext[0] = frame[3];
            dst_ext[1] = frame[4];
            memcpy(dst_ext + 2, frame + 5, 6);
            
            src_ext[0] = frame[11];
            src_ext[1] = frame[12];
            memcpy(src_ext + 2, frame + 13, 3);
            memcpy(src_ext + 5, plaintext, 3);
        } else if (dest_mode == 2 && src_mode == 3) {
            dst_ext[0] = frame[5];
            dst_ext[1] = frame[6];
            dst_ext[2] = 0x56; // VA signature
            dst_ext[3] = 0x31;
            dst_ext[4] = 0x07;
            dst_ext[5] = 0xC5;
            dst_ext[6] = 0x1B;
            dst_ext[7] = 0x00;

            memcpy(src_ext, frame + 7, 8);
        }

        // --- Passive Discovery Phase ---
        if (this->state_ == STATE_DISCOVERING) {
            uint16_t dest_pan = frame[3] | ((uint16_t)frame[4] << 8);
            bool is_broadcast = (dest_pan == 0xFFFF);
            uint8_t cleaned_ib[8];
            bool found_ib = false;

            // 1. IB Discovery (strictly from broadcasts or packets sent by the IB)
            bool found_ib_candidate = false;
            
            // Preferred: Plaintext ICMPv6 RA Link-layer Address Option in broadcast RA
            if (pt_len >= 32 && plaintext[3] == 0x3B && plaintext[6] == 0x86 && plaintext[22] == 0x01 && plaintext[23] == 0x02) {
                uint8_t temp_mac[8];
                for (int i = 0; i < 8; i++) {
                    temp_mac[i] = plaintext[24 + (7 - i)]; // BE to LE
                }
                uint8_t cleaned_temp[8];
                if (is_ib_mac(temp_mac, cleaned_temp) > 0) {
                    memcpy(cleaned_ib, cleaned_temp, 8);
                    found_ib_candidate = true;
                }
            }

            // Fallback: Check reconstructed frame addresses
            if (!found_ib_candidate) {
                int src_ib_match = is_ib_mac(src_ext, cleaned_ib);
                if (src_ib_match > 0) {
                    found_ib_candidate = true;
                } else if (is_broadcast) {
                    int dst_ib_match = is_ib_mac(dst_ext, cleaned_ib);
                    if (dst_ib_match > 0) {
                        found_ib_candidate = true;
                    }
                }
            }

            if (found_ib_candidate) {
                memcpy(this->settings_.ib_mac, cleaned_ib, 8);
                this->settings_.ib_mac_is_real = true;
                this->settings_.ib_pan_id = (dest_pan == 0xFFFF) ? (cleaned_ib[0] | ((uint16_t)cleaned_ib[1] << 8)) : dest_pan;
                found_ib = true;
                if (this->target_ib_mac_text_ != nullptr) {
                    this->target_ib_mac_text_->publish_state(format_hex_be(this->settings_.ib_mac, 8));
                }
                ESP_LOGI(TAG, "Discovered Target IB MAC: %s (PAN: %04X)", 
                    format_hex_be(this->settings_.ib_mac, 8).c_str(), this->settings_.ib_pan_id);
            }

            if (found_ib) {
                this->settings_.magic = 0xBB;
                this->save_settings();
            }

            if (!is_zero_mac(this->settings_.ib_mac)) {
                ESP_LOGI(TAG, "================================================");
                ESP_LOGI(TAG, " SUCCESS! Automatically Sniffed Target Devices:");
                ESP_LOGI(TAG, "   * IB MAC: %s (PAN: %04X)", format_hex_be(settings_.ib_mac, 8).c_str(), settings_.ib_pan_id);
                ESP_LOGI(TAG, "================================================");
                ESP_LOGI(TAG, "[IMPORTANT] Please make sure the IB is not connected to the internet before proceeding.");

                this->state_ = STATE_IDLE;
                this->init_radio();
            }
            return;
        }

        // --- Reset VA Mimicry: Broadcast RA detection ---
        if (this->state_ == STATE_PAIR_MIMIC_BROADCAST_RS) {
            if (pt_len >= 8 && plaintext[6] == 0x86) {
                ESP_LOGI(TAG, "[Mimic] *** BROADCAST ROUTER ADVERTISEMENT RECEIVED! *** Stage 1 Success.");
                ESP_LOGI(TAG, "[Mimic] Plaintext [len=%d]: %s", (int)pt_len, format_hex(plaintext, pt_len).c_str());
                this->beacon_seq_ = frame[2]; // Synchronize sequence number to the Broadcast RA
                this->state_ = STATE_PAIR_MIMIC_UNICAST_RS;
                this->op_boot_tx_count_ = 0;
                this->op_boot_last_tx_time_ = 0;
                this->init_radio();
                return;
            }
        }

        // --- Reset VA Mimicry: /d/pair key extraction ---
        if (this->state_ == STATE_PAIR_MIMIC_UNICAST_RS) {
            // Check for ICMPv6 Neighbor Solicitation (Type 135 / 0x87)
            if (pt_len >= 37 && plaintext[8] == 0x7B && plaintext[10] == 0x3A && plaintext[11] == 0x87) {
                ESP_LOGI(TAG, "[Mimic] *** NEIGHBOR SOLICITATION RECEIVED! *** Sending Neighbor Advertisement...");

                // 1. Build IEEE 802.15.4 Frame Header
                uint8_t frame_header[16];
                frame_header[0] = 0x69; // FCF low
                frame_header[1] = 0xEC; // FCF high
                this->beacon_seq_++;
                frame_header[2] = this->beacon_seq_;
                frame_header[3] = this->settings_.ib_pan_id & 0xFF;
                frame_header[4] = (this->settings_.ib_pan_id >> 8) & 0xFF;
                memcpy(frame_header + 5, this->settings_.ib_mac + 2, 6);
                memcpy(frame_header + 11, this->settings_.va_mac, 2);
                memcpy(frame_header + 13, this->settings_.va_mac + 2, 3);

                // 2. Build Plaintext
                uint8_t tx_plaintext[64];
                size_t tx_pt_len = 0;
                tx_plaintext[tx_pt_len++] = this->settings_.va_mac[5];
                tx_plaintext[tx_pt_len++] = this->settings_.va_mac[6];
                tx_plaintext[tx_pt_len++] = this->settings_.va_mac[7];
                tx_plaintext[tx_pt_len++] = 0x04;
                tx_plaintext[tx_pt_len++] = this->beacon_seq_;
                tx_plaintext[tx_pt_len++] = 0x00;
                tx_plaintext[tx_pt_len++] = 0x00;
                tx_plaintext[tx_pt_len++] = 0x00;
                tx_plaintext[tx_pt_len++] = 0x7B; // Dispatch: Unicast
                tx_plaintext[tx_pt_len++] = 0x33;
                tx_plaintext[tx_pt_len++] = 0x3A; // Next Header: ICMPv6

                // 3. Build ICMPv6 Neighbor Advertisement (40 bytes)
                uint8_t icmp_data[40];
                memset(icmp_data, 0, 40);
                icmp_data[0] = 0x88; // Type 136: NA
                icmp_data[1] = 0x00; // Code 0
                // Checksum at [2..3] is 0x00 for now
                icmp_data[4] = 0x60; // Flags: Solicited=1, Override=1

                // Target IP: VA's Link-Local IP
                uint8_t va_ip[16];
                this->get_link_local_ip(this->settings_.va_mac, va_ip);
                memcpy(icmp_data + 8, va_ip, 16);

                // Option: Target Link-Layer Address
                icmp_data[24] = 0x02; // Type 2: Target Link-Layer Address
                icmp_data[25] = 0x02; // Length 2 (16 bytes option size)
                
                // VA MAC in BE format
                icmp_data[26] = this->settings_.va_mac[7];
                icmp_data[27] = this->settings_.va_mac[6];
                icmp_data[28] = this->settings_.va_mac[5];
                icmp_data[29] = this->settings_.va_mac[4];
                icmp_data[30] = this->settings_.va_mac[3];
                icmp_data[31] = this->settings_.va_mac[2];
                icmp_data[32] = this->settings_.va_mac[1];
                icmp_data[33] = this->settings_.va_mac[0];

                // Compute IPv6 Checksum
                uint8_t ib_ip[16];
                this->get_link_local_ip(this->settings_.ib_mac, ib_ip);
                uint16_t csum = this->compute_ipv6_checksum(va_ip, ib_ip, 58, icmp_data, 40);
                icmp_data[2] = (csum >> 8) & 0xFF;
                icmp_data[3] = csum & 0xFF;

                // Copy ICMPv6 data into plaintext
                memcpy(tx_plaintext + tx_pt_len, icmp_data, 40);
                tx_pt_len += 40;

                // Compute Frame CRC16 (over 16-byte frame header + 51-byte plaintext payload)
                uint8_t crc_data[67];
                memcpy(crc_data, frame_header, 16);
                memcpy(crc_data + 16, tx_plaintext, 51);
                uint16_t crc_val = this->compute_crc16_kermit(crc_data, 67);
                tx_plaintext[51] = crc_val & 0xFF;
                tx_plaintext[52] = (crc_val >> 8) & 0xFF;
                tx_pt_len = 53;

                // 4. Encrypt using PAIRING KEY
                uint8_t nonce[13];
                memcpy(nonce, frame_header, 13);
                uint8_t aad[16];
                memcpy(aad, frame_header, 16);

                mbedtls_ccm_context ctx;
                mbedtls_ccm_init(&ctx);
                int ret = mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, this->pairing_key_, 128);
                if (ret != 0) {
                    ESP_LOGE(TAG, "[Mimic] Failed to set AES key for unicast NA");
                    mbedtls_ccm_free(&ctx);
                    return;
                }

                uint8_t ct[64];
                uint8_t mic[4];
                ret = mbedtls_ccm_encrypt_and_tag(&ctx, tx_pt_len, nonce, 13, aad, 16, tx_plaintext, ct, mic, 4);
                mbedtls_ccm_free(&ctx);

                if (ret != 0) {
                    ESP_LOGE(TAG, "[Mimic] Failed to encrypt unicast NA");
                    return;
                }

                uint8_t tx_packet[128];
                size_t tx_packet_len = 0;
                memcpy(tx_packet + tx_packet_len, frame_header, 16); tx_packet_len += 16;
                memcpy(tx_packet + tx_packet_len, ct, tx_pt_len); tx_packet_len += tx_pt_len;
                memcpy(tx_packet + tx_packet_len, mic, 4); tx_packet_len += 4;

                bool ok = this->transmit_packet(tx_packet, tx_packet_len);
                ESP_LOGI(TAG, "[Mimic] [Unicast NA] Sent Neighbor Advertisement (%d bytes, seq=%d) — %s",
                         (int)tx_packet_len, this->beacon_seq_, ok ? "OK" : "FAILED");
                return;
            }

            // Look for TLV type 0x12 or 0x07, length 0x10 (16 bytes) in the decrypted payload
            // This is the raw or encrypted Operational Key inside CoAP POST /d/pair
            for (size_t i = 0; i + 17 < pt_len; i++) {
                if (plaintext[i] == 0x12 && plaintext[i + 1] == 0x10) {
                    uint8_t extracted_key[16];
                    memcpy(extracted_key, plaintext + i + 2, 16);
                    
                    std::string key_hex = format_hex(extracted_key, 16);
                    ESP_LOGI(TAG, "================================================");
                    ESP_LOGI(TAG, "[Mimic] *** SUCCESS! OPERATIONAL KEY EXTRACTED! ***");
                    ESP_LOGI(TAG, "   PLAINTEXT KEY: %s", key_hex.c_str());
                    ESP_LOGI(TAG, "   Source:        /d/pair (TLV 0x12)");
                    ESP_LOGI(TAG, "================================================");
                    ESP_LOGI(TAG, "[Mimic] Plaintext [len=%d]: %s", (int)pt_len, format_hex(plaintext, pt_len).c_str());
                    
                    memcpy(this->settings_.rf_key, extracted_key, 16);
                    this->settings_.rf_key_found = true;
                    this->settings_.magic = 0xBB;
                    this->save_settings();
                    
                    if (this->stored_rf_key_sensor_ != nullptr) {
                        this->stored_rf_key_sensor_->publish_state(key_hex);
                    }
                    
                    this->state_ = STATE_IDLE;
                    this->init_radio();
                    return;
                } else if (plaintext[i] == 0x07 && plaintext[i + 1] == 0x10) {
                    uint8_t encrypted_key[16];
                    memcpy(encrypted_key, plaintext + i + 2, 16);
                    ESP_LOGW(TAG, "[Mimic] TLV 0x07 detected (device-specific encrypted variant).");
                    ESP_LOGW(TAG, "[Mimic] Raw value: %s (cannot be decrypted locally)", 
                             format_hex(encrypted_key, 16).c_str());
                    ESP_LOGW(TAG, "[Mimic] ACTION REQUIRED: Please force the Internet Bridge to send the plaintext operational key (TLV 0x12).");
                    ESP_LOGW(TAG, "[Mimic] To do this make sure the internet connection on the IB is disabled (unplug ethernet) then retry.");
                    
                    // Automatically increment the VA MAC suffix (lower 2 bytes)
                    uint16_t suffix = this->settings_.va_mac[0] | (this->settings_.va_mac[1] << 8);
                    suffix++;
                    this->settings_.va_mac[0] = suffix & 0xFF;
                    this->settings_.va_mac[1] = (suffix >> 8) & 0xFF;
                    this->settings_.magic = 0xBB;
                    this->save_settings();
                    
                    std::string new_mac_str = format_hex_be(this->settings_.va_mac, 8);
                    ESP_LOGW(TAG, "[Mimic] Automatically incremented VA MAC suffix. New VA MAC: %s", new_mac_str.c_str());
                    
                    if (this->target_va_mac_text_ != nullptr) {
                        this->target_va_mac_text_->publish_state(new_mac_str);
                    }
                    
                    // Abort current mimic session
                    this->state_ = STATE_IDLE;
                    this->init_radio();
                    return;
                }
            }
            ESP_LOGI(TAG, "[Mimic] Decrypted frame in unicast phase (not /d/pair) [len=%d]: %s",
                     (int)pt_len, format_hex(plaintext, pt_len).c_str());
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
    if (this->state_ == STATE_IDLE) {
        write_reg(REG_OP_MODE, 0x00); // SLEEP
    } else {
        write_reg(REG_OP_MODE, 0x05); // RX
    }
    unlock_spi();
  }

  std::string format_hex(const uint8_t* data, size_t len) {
    std::string res;
    res.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        char buf[3]; sprintf(buf, "%02X", data[i]);
        res += buf;
    }
    return res;
  }

  std::string format_hex_be(const uint8_t* data, size_t len) {
    std::string res;
    res.reserve(len * 2);
    for (int i = (int)len - 1; i >= 0; i--) {
        char buf[3]; sprintf(buf, "%02X", data[i]);
        res += buf;
    }
    return res;
  }

  bool parse_mac_address(const std::string &str, uint8_t *mac_out) {
    std::string hex_clean = "";
    for (char c : str) {
        if (isxdigit(c)) {
            hex_clean += c;
        }
    }
    
    if (hex_clean.length() == 16) {
        uint8_t parsed_be[8];
        for (size_t i = 0; i < 8; i++) {
            std::string byteString = hex_clean.substr(i * 2, 2);
            parsed_be[i] = (uint8_t)strtol(byteString.c_str(), nullptr, 16);
        }
        for (int i = 0; i < 8; i++) {
            mac_out[i] = parsed_be[7 - i];
        }
        return true;
    }
    return false;
  }
};

} // namespace tado_pairing
} // namespace esphome
