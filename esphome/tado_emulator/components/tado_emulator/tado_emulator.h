/**
 * @file tado_emulator.h
 * @brief ESPHome custom component for multi-device Tado Room Unit (RU) emulation on TTGO LoRa32 (SX1276).
 *
 * Implements IEEE 802.15.4 FSK RF transmission/reception (868.323 MHz Channel 26),
 * AES-128-CCM encryption/decryption, CoAP message parsing/building, bit-accurate TLV serialization,
 * automated IB pairing state machine, and HMAC-authenticated REST RPC API.
 */

#pragma once

#include "esphome/core/component.h"
#include "esphome/core/hal.h"
#include "esphome/components/spi/spi.h"
#include "esphome/components/web_server_base/web_server_base.h"
#include "esphome/components/network/util.h"
#include <esp_system.h>
#ifdef ESP_IDF_VERSION_MAJOR
#if ESP_IDF_VERSION_MAJOR >= 4
#include <esp_mac.h>
#endif
#endif
#include <nvs_flash.h>
#include <nvs.h>
#include <esp_http_client.h>
#include <mbedtls/ccm.h>
#include <mbedtls/aes.h>
#include <mbedtls/md.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <vector>
#include <string>
#include <map>
#include <cstring>

namespace esphome {
namespace tado_emulator {

// SX1276 Register Definitions
enum SX1276Reg {
  REG_FIFO = 0x00, REG_OP_MODE = 0x01, REG_BITRATE_MSB = 0x02, REG_BITRATE_LSB = 0x03,
  REG_FDEV_MSB = 0x04, REG_FDEV_LSB = 0x05, REG_FRF_MSB = 0x06, REG_FRF_MID = 0x07, REG_FRF_LSB = 0x08,
  REG_PA_CONFIG = 0x09, REG_PARAMP = 0x0A,
  REG_RX_CONFIG = 0x0D, REG_RSSICONFIG = 0x0E, REG_RSSIVALUE = 0x11, REG_RX_BW = 0x12,
  REG_AFC_BW = 0x13, REG_PREAMBLE_DETECT = 0x1F, REG_SYNC_CONFIG = 0x27,
  REG_SYNC_VALUE_1 = 0x28, REG_SYNC_VALUE_2 = 0x29, REG_SYNC_VALUE_3 = 0x2A, REG_SYNC_VALUE_4 = 0x2B,
  REG_PACKET_CONFIG_1 = 0x30, REG_PACKET_CONFIG_2 = 0x31, REG_PAYLOAD_LENGTH = 0x32,
  REG_FIFO_THRESH = 0x35, REG_SEQ_CONFIG_1 = 0x36, REG_IRQ_FLAGS_1 = 0x3E, REG_IRQ_FLAGS_2 = 0x3F,
  REG_VERSION = 0x42
};

enum PairingState {
  STATE_IDLE = 0,
  STATE_PAIR_BROADCAST_RS = 1, // Broadcast RS phase (looking for RA)
  STATE_PAIR_UNICAST_RS = 2,   // Unicast Echo Request phase (waiting for /d/pair)
  STATE_PAIRING_KEY = 3,             // POST auth/key over RF
  STATE_PAIRING_TOKEN = 4,           // POST auth/token over RF
  STATE_PAIRED = 5,                  // Fully operational
  STATE_FAILED = 6
};

/**
 * Tracks an unACKed CoAP CON request for retry with exponential backoff.
 * Stores enough state to rebuild the frame with a fresh seq on each retry.
 */
struct PendingRequest {
  uint16_t mid;
  uint8_t seq;
  uint32_t sent_ts;
  uint8_t retry_count;
  bool mac_confirmed{false};
  std::vector<uint8_t> frame;   // Current RF frame (rebuilt on each retry)
  // Fields for frame rebuild on retry:
  std::vector<uint8_t> coap;    // CoAP datagram (unchanged across retries)
  uint8_t key[16];              // Encryption key
  uint8_t dest_mac[8];          // Destination MAC
  uint8_t src_mac[8];           // Source MAC (device)
};

/**
 * Structure representing an emulated Tado Room Unit (RU) device in NVRAM
 */
struct EmulatedDevice {
  std::string serial_no;
  std::string ipv6_address;
  uint8_t mac_addr[8]{0};
  uint8_t op_key[16]{0};
  uint8_t factory_key[16]{0};
  uint8_t session_token[8]{0};
  bool has_op_key{false};
  bool has_factory_key{false};
  bool has_session_token{false};
  uint32_t home_id{0};
  uint32_t zone_id{0};
  uint8_t zone_role{0};
  bool is_measuring_leader{false};
  PairingState pairing_state{STATE_IDLE};
  uint8_t ib_mac[8]{0};
  uint16_t ib_pan_id{0xFFFF};
  bool ib_mac_known{false};
  uint8_t beacon_seq_{0};
  uint32_t last_pair_tx_time_{0};
  uint8_t pair_tx_count_{0};
  uint16_t coap_mid{0x9000};
  uint8_t seq_num{0};
  uint32_t last_telemetry_ts{0};
  uint32_t last_config_check_ts{0};
  uint32_t last_token_refresh_ts{0};
  uint32_t last_time_sync_ts{0};
  uint32_t server_time_s{0};
  std::string current_etag;

  // Discovered peer IPv6 addresses & MACs in the same zone
  std::vector<std::string> zone_peer_ipv6s;
  std::vector<std::vector<uint8_t>> zone_peer_macs;

  // Cached sensor telemetry values
  float target_temp_celsius{21.5f};
  float target_humidity_pct{50.0f};
  uint16_t target_battery_mv{4500};     // Default full battery (4.5V)
  uint16_t target_ambient_light{6249};  // Default ambient light ADC (matches Real RU ~0x1869)
  uint8_t reset_counter{6};             // Default reset counter (1 byte uint8)

  // Firmware descriptor metadata (synced dynamically from server devices table)
  uint16_t fw_version{55042};           // e.g. 55042 (215.2) for RU, 55041 (215.1) for VA
  uint16_t fw_other_slot{52227};        // e.g. 52227 (204.3) for RU, 52225 (204.1) for VA
  std::string fw_build_id{"c54baf8"};   // e.g. "c54baf8" for RU, "1556c5e" for VA
  uint8_t dev_type_code{10};            // field_0036: 10
  uint8_t slot_num{1};                  // field_0180: 1 for RU, 4 for VA
  uint8_t field_01a0{8};
  uint8_t field_003b{14};
  uint8_t field_003c{14};
  uint8_t field_014c{1};

  // CoAP CON retry tracking
  bool token_refresh_pending{false};
  std::vector<PendingRequest> pending_requests;

  // Staggered bootup & startup sequence tracking (1000ms intervals)
  uint8_t startup_stage{0};
  bool stage_ack_received{false};
  uint32_t last_startup_step_ms{0};
  uint32_t next_retry_ms{0};
  uint32_t last_link_probe_ts{0};
  uint16_t last_rx_coap_mid{0xFFFF};
  uint8_t last_rx_coap_code{0};
  uint32_t last_rx_coap_ts{0};
  uint16_t last_rx_fcf{0};
  uint8_t last_rx_seq{0xFF};

  // 6LoWPAN fragment reassembly buffer
  uint16_t frag_tag{0};
  uint16_t frag_total_len{0};
  std::vector<uint8_t> frag_buf;
  uint32_t frag_start_ts{0};
  uint16_t frag_next_offset{0};  // Next expected FRAGN offset (in 8-byte units), prevents duplicate appends
  uint8_t last_rx_len{0};

  // IEEE 802.15.4 short address (derived from MAC, used in operational dispatch)
  uint16_t short_addr{0};
  uint32_t last_csl_wakeup_ms{0};

  void derive_short_addr() {
    // Tado 802.15.4 Short Address is always the first 2 bytes of the wire LE MAC address
    short_addr = mac_addr[0] | ((uint16_t)mac_addr[1] << 8);
  }

  uint16_t get_ib_pan() const {
    if (ib_mac_known && (ib_mac[0] != 0 || ib_mac[1] != 0)) {
      return ib_mac[0] | ((uint16_t)ib_mac[1] << 8);
    }
    return 0xABCD;
  }
};

struct ExposeInternalPin : public InternalGPIOPin {
  using InternalGPIOPin::attach_interrupt;
};

class TadoEmulatorComponent : public Component,
                              public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW, spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_8MHZ>,
                              public AsyncWebHandler {
 public:
  static constexpr const char *const TAG = "tado_emulator";

  static void IRAM_ATTR dio0_isr(void *arg) {
    TadoEmulatorComponent *emulator = static_cast<TadoEmulatorComponent *>(arg);
    if (emulator->radio_task_handle_ != nullptr) {
      BaseType_t xHigherPriorityTaskWoken = pdFALSE;
      vTaskNotifyGiveFromISR(emulator->radio_task_handle_, &xHigherPriorityTaskWoken);
      if (xHigherPriorityTaskWoken == pdTRUE) {
        portYIELD_FROM_ISR();
      }
    }
  }

  void set_dio0_pin(InternalGPIOPin *pin) { this->dio0_pin_ = pin; }
  void set_rst_pin(InternalGPIOPin *pin) { this->rst_pin_ = pin; }
  void set_channel(int channel) { this->channel_ = channel; }
  void set_auto_mac_ack(bool enabled) { this->auto_mac_ack_ = enabled; }
  bool auto_mac_ack_{false};
  // 2026-08-27: Configurable high-throughput SPI burst FIFO draining
  void set_fast_fifo_drain(bool fast) { this->fast_fifo_drain_ = fast; }
  bool fast_fifo_drain_{true};
  bool web_server_initialized_{false};

  void set_server_base(web_server_base::WebServerBase *base) { this->base_ = base; }
  void set_server_url(const std::string &url) { this->server_url_ = url; }
  void set_api_key(const std::string &key) { this->api_key_ = key; }

  void setup() override {
    ESP_LOGI(TAG, "Initializing TaNoClo ESP32 Multi-Device RU Emulator (TTGO LoRa32 SX1276)...");
    this->spi_setup();
    this->spi_mutex_ = xSemaphoreCreateMutex();
    this->devices_mutex_ = xSemaphoreCreateRecursiveMutex();
    this->packet_queue_ = xQueueCreate(24, sizeof(QueuedPacket));

    this->init_hardware();
    this->load_from_nvs();

    if (this->base_ != nullptr) {
      this->base_->add_handler(this);
    }

    // Radio task: SPI I/O, FIFO reads, packet queuing (Core 0, high priority)
    xTaskCreatePinnedToCore(TadoEmulatorComponent::radio_task_entry, "tado_emul_radio", 4096, this, 5, &this->radio_task_handle_, 0);
    // Processing task: decryption, state machine, TX building (Core 1, normal priority)
    xTaskCreatePinnedToCore(TadoEmulatorComponent::processing_task_entry, "tado_emul_proc", 8192, this, 2, &this->processing_task_handle_, 1);
  }

  void loop() override {
    if (this->base_ != nullptr && !this->web_server_initialized_ && network::is_connected()) {
      this->base_->init();
      this->web_server_initialized_ = true;
      ESP_LOGI(TAG, "TaNoClo REST RPC Web Server listening on port 80");
    }

    if (this->devices_mutex_ == nullptr) return;
    if (xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
      uint32_t now = (uint32_t)(esp_timer_get_time() / 1000000ULL);
      uint32_t now_ms = millis();
      bool another_device_starting_up = false;
      for (size_t dev_idx = 0; dev_idx < this->devices_.size(); ++dev_idx) {
        auto &dev = this->devices_[dev_idx];
        // 1. Discovery Phase: Broadcast Router Solicitation (every 2.5s)
        if (dev.pairing_state == STATE_PAIR_BROADCAST_RS) {
          if (now_ms - dev.last_pair_tx_time_ >= 2500) {
            dev.last_pair_tx_time_ = now_ms;
            dev.pair_tx_count_++;
            this->send_broadcast_rs_packet(&dev);
            if (dev.pair_tx_count_ >= 30) {
              ESP_LOGE(TAG, "%s: Broadcast RA timed out after 30 attempts. Aborting.", dev.serial_no.c_str());
              dev.pairing_state = STATE_FAILED;
            }
          }
        }
        // 2. Unicast Phase: Unicast Echo Request (every 2.0s)
        else if (dev.pairing_state == STATE_PAIR_UNICAST_RS) {
          if (now_ms - dev.last_pair_tx_time_ >= 2000) {
            dev.last_pair_tx_time_ = now_ms;
            dev.pair_tx_count_++;
            this->send_unicast_echo_packet(&dev);
            if (dev.pair_tx_count_ >= 30) {
              ESP_LOGE(TAG, "%s: /d/pair reception timed out after 30 attempts. Aborting.", dev.serial_no.c_str());
              dev.pairing_state = STATE_FAILED;
            }
          }
        }
        // 3. Neighbor Discovery Phase (waiting for Bridge NS 0x87)
        else if (dev.pairing_state == STATE_PAIRING_TOKEN) {
          if (dev.last_pair_tx_time_ != 0 && now_ms - dev.last_pair_tx_time_ >= 60000) {
            dev.pairing_state = STATE_PAIRED;
            dev.last_telemetry_ts = 0;
            this->save_to_nvs();
            ESP_LOGI(TAG, "[Pairing] Timeout waiting for NS (60s). Transitioning %s to STATE_PAIRED.", dev.serial_no.c_str());
          }
        }
        // 4. Operational Phase: Normal Periodic Telemetry & Maintenance
        else if (dev.pairing_state == STATE_PAIRED) {
          if (now > 0) {
            uint32_t now_ms = millis();
            // Stagger initial link probe, telemetry, time sync and zone presence (1000ms intervals)
            // Multi-device serialization: only one device runs startup at a time
            if (dev.startup_stage < 6) {
              if (another_device_starting_up) {
                // Another device is actively progressing through startup stages, wait for it
                continue;
              }
              another_device_starting_up = true;

              if (dev.startup_stage == 0) {
                if (dev.next_retry_ms != 0) {
                  if (now_ms < dev.next_retry_ms) continue;
                  dev.next_retry_ms = 0;
                  dev.last_startup_step_ms = 0;
                }
                if (!network::is_connected()) {
                  continue; // Wait for Wi-Fi connection to sync real initial telemetry from server
                }
                if (dev.last_startup_step_ms == 0) {
                  // Sub-step 0: Mark WiFi-connected time, wait 500ms for TCP/IP stack to settle
                  dev.last_startup_step_ms = now_ms;
                  continue;
                }
                if (now_ms - dev.last_startup_step_ms < 500) {
                  continue; // Wait for TCP/IP stack to settle after association
                }
                this->fetch_initial_telemetry_from_server(&dev);
                ESP_LOGI(TAG, "Device %s (%u/%u) fully paired. Commencing startup handshake...",
                         dev.serial_no.c_str(), (unsigned int)(dev_idx + 1), (unsigned int)this->devices_.size());
                // Send 2x Router Solicitation (matching real RU boot trace) + Neighbor Advertisement
                this->send_router_solicitation(&dev);
                this->send_router_solicitation(&dev);
                this->send_neighbor_advertisement(&dev);
                bool is_ru = (dev.serial_no.rfind("RU", 0) == 0);
                if (is_ru) {
                  dev.startup_stage = 2; // RU starts directly with Stage 2: GET d/{serial}/config
                  dev.stage_ack_received = false;
                  dev.last_startup_step_ms = now_ms;
                  ESP_LOGI(TAG, "%s: Stage 0 complete (RS beacons + NA sent). Advancing directly to Stage 2: GET d/%s/config (MID 0x9000)...", dev.serial_no.c_str(), dev.serial_no.c_str());
                  this->send_config_get(&dev);
                } else {
                  dev.startup_stage = 1; // Stage 1: Waiting for Bridge POST /auth/token (VA devices)
                  dev.stage_ack_received = false;
                  dev.last_startup_step_ms = now_ms;
                  ESP_LOGI(TAG, "%s: Stage 0 complete (RS beacons + NA sent). Awaiting Bridge POST /auth/token...", dev.serial_no.c_str());
                }
              } else if (dev.startup_stage == 1 && (now_ms - dev.last_startup_step_ms >= 4000)) {
                // If Bridge didn't send /auth/token within 4s, proceed to Stage 2: GET d/{serial}/config
                dev.startup_stage = 2;
                dev.stage_ack_received = false;
                dev.last_startup_step_ms = now_ms;
                ESP_LOGI(TAG, "✓ %s: Advancing to Stage 2: GET d/%s/config (MID 0x9000)...", dev.serial_no.c_str(), dev.serial_no.c_str());
                this->send_config_get(&dev);
              } else if (dev.startup_stage == 2 && dev.stage_ack_received && (now_ms - dev.last_startup_step_ms >= 1000)) {
                // Advance to Stage 3: PUT d/sen (1 full second after Stage 2 ACK)
                dev.startup_stage = 3;
                dev.stage_ack_received = false;
                dev.last_startup_step_ms = now_ms;
                ESP_LOGI(TAG, "✓ %s: Advancing to Stage 3: PUT d/sen (MID 0x9001)...", dev.serial_no.c_str());
                this->send_telemetry_put(&dev, dev.target_temp_celsius, dev.target_humidity_pct, dev.target_battery_mv);
              } else if (dev.startup_stage == 3 && dev.stage_ack_received && (now_ms - dev.last_startup_step_ms >= 1000)) {
                // Advance to Stage 4: PUT d/err (1 full second after Stage 3 ACK)
                dev.startup_stage = 4;
                dev.stage_ack_received = false;
                dev.last_startup_step_ms = now_ms;
                ESP_LOGI(TAG, "✓ %s: Advancing to Stage 4: PUT d/err (MID 0x9002)...", dev.serial_no.c_str());
                this->send_error_flags_put(&dev);
              } else if (dev.startup_stage == 4 && dev.stage_ack_received && (now_ms - dev.last_startup_step_ms >= 1000)) {
                // Advance to Stage 5: GET time (1 full second after Stage 4 ACK)
                dev.startup_stage = 5;
                dev.stage_ack_received = false;
                dev.last_startup_step_ms = now_ms;
                ESP_LOGI(TAG, "✓ %s: Advancing to Stage 5: GET time (MID 0x9003)...", dev.serial_no.c_str());
                this->send_time_get(&dev);
              }
            } else if (dev.startup_stage >= 6 && (now - dev.last_telemetry_ts) >= 900) {
              // Periodic Telemetry Heartbeat (every 15 mins / 900s)
              dev.last_telemetry_ts = now;
              this->send_telemetry_put(&dev, dev.target_temp_celsius, dev.target_humidity_pct, dev.target_battery_mv);
            }
            // Periodic Link Maintenance & Neighbor Discovery Keepalive (every 300s / 5 mins)
            // Real RU transmits periodic Neighbor Advertisements (0x88) and RS/RA beacons
            // so the Bridge's 6LoWPAN neighbor table stays populated after Bridge reboot.
            if (dev.startup_stage >= 6 && (now - dev.last_link_probe_ts) >= 300) {
              dev.last_link_probe_ts = now;
              ESP_LOGI(TAG, "%s: Sending periodic Neighbor Advertisement link probe (5-min keepalive)...", dev.serial_no.c_str());
              this->send_neighbor_advertisement(&dev);
            }
            // Periodic Config ETag Check (1 hour / 3600s)
            if (dev.last_config_check_ts != 0 && (now - dev.last_config_check_ts) >= 3600) {
              dev.last_config_check_ts = now;
              this->send_config_get(&dev);
            }
            // Periodic Session Token Refresh (24 hours / 86400s)
            if (dev.last_token_refresh_ts != 0 && (now - dev.last_token_refresh_ts) >= 86400) {
              dev.last_token_refresh_ts = now;
              this->send_auth_token_request(&dev);
            }
            // Periodic Time Sync (24 hours / 86400s)
            if (dev.last_time_sync_ts != 0 && (now - dev.last_time_sync_ts) >= 86400) {
              dev.last_time_sync_ts = now;
              this->send_time_get(&dev);
            }
          }
        }
        // 4. CoAP CON retry with exponential backoff
        for (auto it = dev.pending_requests.begin(); it != dev.pending_requests.end(); ) {
          // If Bridge already confirmed MAC reception of this frame, wait for upstream server CoAP response
          if (it->mac_confirmed) {
            uint32_t elapsed = now - it->sent_ts;
            if (elapsed < 45) {
              ++it;
              continue; // Do not fire RF retries; Bridge is awaiting upstream backend response
            }
          }
          // Channel activity backoff: if IB was transmitting in last 500ms, defer retry
          if (millis() - this->last_rx_time_ < 500) {
            ++it;
            continue;
          }
          uint32_t elapsed = now - it->sent_ts;
          uint32_t timeout = 4u << it->retry_count; // CoAP RFC 7252: 4, 8, 16, 32 seconds
          if (elapsed >= timeout) {
            if (it->retry_count >= 4) {
              ESP_LOGW(TAG, "[RF] %s: MID=0x%04X abandoned after 4 retries",
                       dev.serial_no.c_str(), it->mid);
              it = dev.pending_requests.erase(it);
              if (dev.startup_stage < 5) {
                ESP_LOGW(TAG, "[RF] %s: Bootup handshake failed to receive ACK. Resetting to Stage 0 to re-attempt boot sequence in 60s...",
                         dev.serial_no.c_str());
                dev.startup_stage = 0;
                dev.next_retry_ms = millis() + 60000; // Retry in 60 seconds
                dev.last_startup_step_ms = 0;
              } else if (dev.pending_requests.empty()) {
                ESP_LOGI(TAG, "[RF] Re-probing IB link for %s via Router Solicitation...", dev.serial_no.c_str());
                this->send_router_solicitation(&dev);
              }
            } else {
              it->retry_count++;
              it->sent_ts = now;
              // Rebuild frame with fresh seq to avoid stale-seq MAC ACK ambiguity
              uint8_t new_seq = dev.seq_num++;
              it->seq = new_seq;
              it->frame = this->rebuild_pending_frame(*it, &dev, new_seq);
              ESP_LOGI(TAG, "[RF TX Retry] %s: Retry #%u for MID=0x%04X (backoff %us, new seq=%u)",
                       dev.serial_no.c_str(), it->retry_count, it->mid, 4u << (it->retry_count - 1), new_seq);
              this->send_raw_rf_frame(it->frame);
              ++it;
            }
          } else {
            ++it;
          }
        }
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
    }
  }

  // -------------------------------------------------------------------------
  // Web Server / REST API Handlers
  // -------------------------------------------------------------------------

  static bool constant_time_eq(const std::string &a, const std::string &b) {
    if (a.length() != b.length()) return false;
    unsigned char result = 0;
    for (size_t i = 0; i < a.length(); i++) {
      result |= (unsigned char)(a[i] ^ b[i]);
    }
    return result == 0;
  }

  static std::string json_extract_str(const std::string &json, const std::string &key) {
    size_t k = json.find("\"" + key + "\"");
    if (k == std::string::npos) return "";
    size_t colon = json.find(':', k + key.length() + 2);
    if (colon == std::string::npos) return "";
    size_t q1 = json.find('"', colon + 1);
    if (q1 == std::string::npos) return "";
    size_t q2 = json.find('"', q1 + 1);
    if (q2 == std::string::npos) return "";
    return json.substr(q1 + 1, q2 - q1 - 1);
  }

  static double json_extract_num(const std::string &json, const std::string &key, double default_val = 0.0) {
    size_t k = json.find("\"" + key + "\"");
    if (k == std::string::npos) return default_val;
    size_t colon = json.find(':', k + key.length() + 2);
    if (colon == std::string::npos) return default_val;
    size_t val_start = colon + 1;
    while (val_start < json.length() && (json[val_start] == ' ' || json[val_start] == '\t' || json[val_start] == '\r' || json[val_start] == '\n')) {
      val_start++;
    }
    if (val_start >= json.length()) return default_val;
    if (json[val_start] == '"') {
      size_t q2 = json.find('"', val_start + 1);
      if (q2 == std::string::npos) return default_val;
      return atof(json.substr(val_start + 1, q2 - val_start - 1).c_str());
    }
    return atof(json.substr(val_start).c_str());
  }

  static std::vector<std::string> json_extract_str_array(const std::string &json, const std::string &key) {
    std::vector<std::string> res;
    size_t k = json.find("\"" + key + "\"");
    if (k == std::string::npos) return res;
    size_t ob = json.find('[', k + key.length() + 2);
    if (ob == std::string::npos) return res;

    size_t p = ob + 1;
    while (p < json.length()) {
      size_t q1 = json.find('"', p);
      if (q1 == std::string::npos) break;
      size_t close_arr = json.find(']', p);
      if (close_arr != std::string::npos && close_arr < q1) break;

      size_t q2 = q1 + 1;
      while (q2 < json.length()) {
        if (json[q2] == '"' && json[q2 - 1] != '\\') break;
        q2++;
      }
      if (q2 >= json.length()) break;

      res.push_back(json.substr(q1 + 1, q2 - q1 - 1));
      p = q2 + 1;

      while (p < json.length() && (json[p] == ' ' || json[p] == ',' || json[p] == '\n' || json[p] == '\r')) {
        p++;
      }
      if (p < json.length() && json[p] == ']') break;
    }
    return res;
  }

  static bool json_has_key(const std::string &json, const std::string &key) {
    return json.find("\"" + key + "\"") != std::string::npos;
  }

  bool canHandle(AsyncWebServerRequest *request) const override {
    char url_buf[513];
    auto url_ref = request->url_to(url_buf);
    return url_ref == "/api/cmd" || url_ref == "/api/status";
  }

  void handleRequest(AsyncWebServerRequest *request) override {
    char url_buf[513];
    auto url_ref = request->url_to(url_buf);
    if (url_ref == "/api/status" && request->method() == HTTP_GET) {
      this->handle_status_request(request);
      return;
    }

    if (url_ref == "/api/cmd" && request->method() == HTTP_POST) {
      std::string body_str = "";
      if (request->hasArg("plain")) {
        body_str = request->arg("plain");
      } else if (request->hasArg("body")) {
        body_str = request->arg("body");
      }

      if (!this->api_key_.empty()) {
        auto hdr = request->get_header("X-ESP-API-Key");
        if (!hdr.has_value()) hdr = request->get_header("x-esp-api-key");
        bool key_match = (hdr.has_value() && constant_time_eq(*hdr, this->api_key_));
        if (!key_match && !body_str.empty()) {
          std::string parsed_key = json_extract_str(body_str, "api_key");
          if (!parsed_key.empty() && constant_time_eq(parsed_key, this->api_key_)) {
            key_match = true;
          }
        }
        if (!key_match) {
          request->send(401, "application/json", "{\"error\":\"Unauthorized: Invalid API Key\"}");
          return;
        }
      }

      this->handle_cmd_request(request, body_str);
      return;
    }

    request->send(404, "text/plain", "Not Found");
  }

  // -------------------------------------------------------------------------
  // Binary TLV Builders
  // -------------------------------------------------------------------------

  static void append_tlv_uint8(std::vector<uint8_t> &out, uint16_t tag, uint8_t val) {
    out.push_back((tag >> 8) & 0xFF);
    out.push_back(tag & 0xFF);
    out.push_back(0x01);
    out.push_back(val);
  }

  static void append_tlv_int16(std::vector<uint8_t> &out, uint16_t tag, int16_t val) {
    out.push_back((tag >> 8) & 0xFF);
    out.push_back(tag & 0xFF);
    out.push_back(0x02);
    out.push_back((val >> 8) & 0xFF);
    out.push_back(val & 0xFF);
  }

  static void append_tlv_uint16(std::vector<uint8_t> &out, uint16_t tag, uint16_t val) {
    out.push_back((tag >> 8) & 0xFF);
    out.push_back(tag & 0xFF);
    out.push_back(0x02);
    out.push_back((val >> 8) & 0xFF);
    out.push_back(val & 0xFF);
  }

  static void append_tlv_uint32(std::vector<uint8_t> &out, uint16_t tag, uint32_t val) {
    out.push_back((tag >> 8) & 0xFF);
    out.push_back(tag & 0xFF);
    out.push_back(0x04);
    out.push_back((val >> 24) & 0xFF);
    out.push_back((val >> 16) & 0xFF);
    out.push_back((val >> 8) & 0xFF);
    out.push_back(val & 0xFF);
  }

  static void append_tlv_string(std::vector<uint8_t> &out, uint16_t tag, const std::string &val) {
    out.push_back((tag >> 8) & 0xFF);
    out.push_back(tag & 0xFF);
    out.push_back((uint8_t)val.length());
    for (char c : val) out.push_back((uint8_t)c);
  }

  /**
   * Builds exact d/sen payload matching Real RU:
   * 0x0161: ambient_light_adc (uint16, e.g. 6249 / 0x1869)
   * 0x0162: battery_mv (uint16, mV)
   * 0x012d: temp_celsius (int16, temp * 100)
   * 0x012e: aux_temp_celsius (int16, follows ambient)
   * 0x0135: humidity_percent (uint16, % * 10, e.g. 50.0% -> 500)
   * 0x0136: reset_counter / status (uint8, 1 byte matching Real RU)
   */
  static std::vector<uint8_t> build_d_sen_payload(float temp_c, float humidity_pct, uint16_t battery_mv, uint16_t light_adc = 6249, uint8_t reset_count = 6) {
    std::vector<uint8_t> tlv;
    int16_t temp_val = (int16_t)(temp_c * 100.0f);
    int16_t aux_temp_val = temp_val;
    uint16_t hum_val = (uint16_t)(humidity_pct * 10.0f);

    append_tlv_uint16(tlv, 0x0161, light_adc);
    append_tlv_uint16(tlv, 0x0162, battery_mv);
    append_tlv_int16(tlv, 0x012d, temp_val);
    append_tlv_int16(tlv, 0x012e, aux_temp_val);
    append_tlv_uint16(tlv, 0x0135, hum_val);
    append_tlv_uint8(tlv, 0x0136, reset_count);
    return tlv;
  }

  /**
   * Builds d/fw/state and /d/info response payload using dynamic device metadata:
   * - RU02 default: type 10, active_fw 55042 (v215.2), other_slot 52227 (v204.3), build "c54baf8e6aa4b6064303f0b130ba32e5f9658c85", slot 1
   * - VA02 default: type 10, active_fw 55041 (v215.1), other_slot 52225 (v204.1), build "1556c5e16fabcbe0f58fbaca5b5d6ecd266bc52c", slot 4
   */
  static std::vector<uint8_t> build_d_fw_state_payload(const EmulatedDevice *dev) {
    if (dev == nullptr) return build_d_fw_state_payload("RU");
    bool is_ru = (dev->serial_no.rfind("RU", 0) == 0);
    uint8_t slot_num = is_ru ? 1 : 4;
    std::string build_id = dev->fw_build_id;
    if (build_id.length() <= 8) {
      build_id = is_ru ? "c54baf8e6aa4b6064303f0b130ba32e5f9658c85" : "1556c5e16fabcbe0f58fbaca5b5d6ecd266bc52c";
    }

    std::vector<uint8_t> tlv;
    append_tlv_uint8(tlv, 0x01a0, dev->field_01a0);
    append_tlv_uint16(tlv, 0x003a, dev->fw_version);
    append_tlv_uint8(tlv, 0x003b, dev->field_003b);
    append_tlv_uint16(tlv, 0x0035, dev->fw_other_slot);
    append_tlv_uint16(tlv, 0x0039, dev->fw_version);
    append_tlv_uint8(tlv, 0x0036, dev->dev_type_code);
    append_tlv_uint8(tlv, 0x003c, dev->field_003c);
    append_tlv_string(tlv, 0x0210, build_id);
    append_tlv_uint8(tlv, 0x0180, slot_num);
    append_tlv_uint8(tlv, 0x014c, dev->field_014c);
    return tlv;
  }

  static std::vector<uint8_t> build_d_fw_state_payload(const std::string &serial_no = "RU") {
    std::vector<uint8_t> tlv;
    bool is_ru = (serial_no.rfind("RU", 0) == 0);
    uint16_t fw_version = is_ru ? 55042 : 55041;           // RU02 v215.2 vs VA02 v215.1
    uint16_t other_slot = is_ru ? 52227 : 52225;           // RU02 v204.3 vs VA02 v204.1
    std::string build_id = is_ru ? "c54baf8e6aa4b6064303f0b130ba32e5f9658c85" : "1556c5e16fabcbe0f58fbaca5b5d6ecd266bc52c";
    uint8_t dev_type = 10;                                 // field_0036 = 10
    uint8_t slot_num = is_ru ? 1 : 4;                      // slot 1 (RU) vs slot 4 (VA)

    append_tlv_uint8(tlv, 0x01a0, 8);
    append_tlv_uint16(tlv, 0x003a, fw_version);
    append_tlv_uint8(tlv, 0x003b, 14);
    append_tlv_uint16(tlv, 0x0035, other_slot);
    append_tlv_uint16(tlv, 0x0039, fw_version);
    append_tlv_uint8(tlv, 0x0036, dev_type);
    append_tlv_uint8(tlv, 0x003c, 14);
    append_tlv_string(tlv, 0x0210, build_id);
    append_tlv_uint8(tlv, 0x0180, slot_num);
    append_tlv_uint8(tlv, 0x014c, 1);
    return tlv;
  }

  /**
   * Builds d/act payload: va_actuator_active = false
   */
  static std::vector<uint8_t> build_d_act_payload() {
    std::vector<uint8_t> tlv;
    append_tlv_uint8(tlv, 0x028c, 0); // false
    return tlv;
  }

  /**
   * Builds /z/p TLV payload:
   * 0x4060: zone_temperature_4060 (int16, degC * 100)
   */
  static std::vector<uint8_t> build_z_p_payload(float temp_c) {
    std::vector<uint8_t> tlv;
    int16_t temp_val = (int16_t)(temp_c * 100.0f);
    append_tlv_int16(tlv, 0x4060, temp_val);
    return tlv;
  }

  /**
   * Builds d/err payload: error_flags_u32 = 0
   */
  static std::vector<uint8_t> build_d_err_payload() {
    std::vector<uint8_t> tlv;
    append_tlv_uint32(tlv, 0x01a3, 0);
    return tlv;
  }

  // -------------------------------------------------------------------------
  // Outgoing RU CoAP Transmissions
  // -------------------------------------------------------------------------

  /**
   * PUT /d/config — device registration push sent after IB reboot.
   * Contains device capabilities (firmware TLVs) so the IB re-registers
   * this node in its neighbor/routing table.
   */
  void send_device_config_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_fw_state_payload(dev);
    this->send_coap_request(dev, 3 /* PUT */, "d/config", payload);
  }

  void send_telemetry_put(EmulatedDevice *dev, float temp_c, float hum_pct, uint16_t battery_mv) {
    dev->target_temp_celsius = temp_c;
    dev->target_humidity_pct = hum_pct;
    dev->target_battery_mv = battery_mv;
    dev->last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);

    std::vector<uint8_t> payload = build_d_sen_payload(temp_c, hum_pct, battery_mv, dev->target_ambient_light, dev->reset_counter);
    std::string path = "d/" + dev->serial_no + "/sen";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
    ESP_LOGI(TAG, "  └─ Telemetry payload: Temp=%.2fC, Hum=%.1f%%, Batt=%umV, Light=%uADC, Reset=%u",
             temp_c, hum_pct, battery_mv, dev->target_ambient_light, dev->reset_counter);
  }

  void send_fw_state_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_fw_state_payload(dev);
    std::string path = "d/" + dev->serial_no + "/fw/state";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
  }

  void send_actuator_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_act_payload();
    std::string path = "d/" + dev->serial_no + "/act";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
  }

  void send_error_flags_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_err_payload();
    std::string path = "d/" + dev->serial_no + "/err";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
  }

  //Not needed
  void send_zone_p_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_z_p_payload(dev->target_temp_celsius);
    
    // 1. Broadcast / Internet Bridge transmission
    this->send_coap_request(dev, 3 /* PUT */, "z/p", payload);

    // 2. Unicast transmission to all peer VA devices in the zone
    for (const auto &peer_mac : dev->zone_peer_macs) {
      if (peer_mac.size() == 8) {
        this->send_coap_raw_dest(dev, 3 /* PUT */, "z/p", payload, dev->op_key, true, peer_mac.data());
      }
    }
  }

  void send_config_get(EmulatedDevice *dev) {
    std::string path = "d/" + dev->serial_no + "/config";
    this->send_coap_request(dev, 1 /* GET */, path, {});
  }

  void send_time_get(EmulatedDevice *dev) {
    this->send_coap_request(dev, 1 /* GET */, "time", {});
  }

  void send_auth_key_request(EmulatedDevice *dev) {
    dev->pairing_state = STATE_PAIRING_KEY;
    std::vector<uint8_t> payload;
    append_tlv_string(payload, 0x0260, dev->serial_no);

    uint8_t rand_nonce[16];
    esp_fill_random(rand_nonce, 16);
    char nonce_hex[33];
    for (int i = 0; i < 16; i++) {
      snprintf(nonce_hex + (i * 2), 3, "%02x", rand_nonce[i]);
    }
    append_tlv_string(payload, 0x0007, std::string(nonce_hex));

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *key = dev->has_op_key ? dev->op_key : pairing_key;
    this->send_coap_raw(dev, 2 /* POST */, "auth/key", payload, key, false);
    ESP_LOGI(TAG, "[RF TX] %s: POST auth/key (%s)", dev->serial_no.c_str(),
             dev->has_op_key ? "Operational Key" : "Pairing Key");
  }

  void send_auth_token_request(EmulatedDevice *dev) {
    if (dev->pairing_state == STATE_PAIRED) {
      dev->token_refresh_pending = true; // Don't clobber PAIRED state during refresh
    } else {
      dev->pairing_state = STATE_PAIRING_TOKEN;
    }
    std::vector<uint8_t> payload;
    append_tlv_string(payload, 0x0260, dev->serial_no);
    this->send_coap_request(dev, 2 /* POST */, "auth/token", payload);
    ESP_LOGI(TAG, "[RF TX] %s: POST auth/token (Pairing Step 2)", dev->serial_no.c_str());
  }

  static uint16_t compute_crc16_kermit(const uint8_t *data, size_t len) {
    uint16_t crc = 0x0000;
    const uint16_t poly = 0x8408;
    for (size_t i = 0; i < len; i++) {
      crc ^= data[i];
      for (int j = 0; j < 8; j++) {
        if (crc & 1) crc = (crc >> 1) ^ poly;
        else crc = crc >> 1;
      }
    }
    return crc;
  }

  static uint16_t compute_ipv6_checksum(const uint8_t *src_ip, const uint8_t *dst_ip, uint8_t proto, const uint8_t *payload, size_t payload_len) {
    uint32_t sum = 0;
    for (int i = 0; i < 16; i += 2) sum += (src_ip[i] << 8) | src_ip[i + 1];
    for (int i = 0; i < 16; i += 2) sum += (dst_ip[i] << 8) | dst_ip[i + 1];
    sum += (uint32_t)payload_len;
    sum += (uint32_t)proto;
    for (size_t i = 0; i < payload_len; i += 2) {
      if (i + 1 < payload_len) sum += (payload[i] << 8) | payload[i + 1];
      else sum += (payload[i] << 8);
    }
    while (sum >> 16) sum = (sum & 0xFFFF) + (sum >> 16);
    return ~((uint16_t)sum);
  }

  static void get_link_local_ip(const uint8_t *mac, uint8_t *ip_out) {
    memset(ip_out, 0, 16);
    ip_out[0] = 0xFE; ip_out[1] = 0x80;
    ip_out[8] = mac[7] ^ 0x02; ip_out[9] = mac[6]; ip_out[10] = mac[5];
    ip_out[11] = mac[4]; ip_out[12] = mac[3]; ip_out[13] = mac[2];
    ip_out[14] = mac[1]; ip_out[15] = mac[0];
  }

  void send_broadcast_rs_packet(EmulatedDevice *dev) {
    dev->beacon_seq_++;

    uint8_t icmp[24];
    memset(icmp, 0, 24);
    icmp[0] = 0x85; // Type 133: RS
    icmp[1] = 0x00;
    icmp[8] = 0x01; // Option Type 1: SLLA
    icmp[9] = 0x02; // Length 2 (16 bytes)
    for (int i = 0; i < 8; i++) icmp[10 + i] = dev->mac_addr[7 - i];

    uint8_t src_ip[16], dst_ip[16];
    get_link_local_ip(dev->mac_addr, src_ip);
    memset(dst_ip, 0, 16);
    dst_ip[0] = 0xFF; dst_ip[1] = 0x02; dst_ip[15] = 0x02; // ff02::2

    uint16_t csum = compute_ipv6_checksum(src_ip, dst_ip, 58, icmp, 24);
    icmp[2] = (csum >> 8) & 0xFF;
    icmp[3] = csum & 0xFF;

    uint8_t frame_header[16];
    frame_header[0] = 0x49; // FCF low
    frame_header[1] = 0xE8; // FCF high
    frame_header[2] = dev->beacon_seq_;
    frame_header[3] = 0xFF; frame_header[4] = 0xFF; // Broadcast PAN
    memcpy(frame_header + 5, dev->mac_addr, 8);
    frame_header[13] = 0x04; frame_header[14] = 0x01; frame_header[15] = 0x00;

    uint8_t plaintext[32];
    plaintext[0] = 0x00; plaintext[1] = 0x00; plaintext[2] = 0x7B;
    plaintext[3] = 0x3B; plaintext[4] = 0x3A; plaintext[5] = 0x02;
    memcpy(plaintext + 6, icmp, 24);

    uint8_t crc_data[46];
    memcpy(crc_data, frame_header, 16);
    memcpy(crc_data + 16, plaintext, 30);
    uint16_t crc_val = compute_crc16_kermit(crc_data, 46);
    plaintext[30] = crc_val & 0xFF;
    plaintext[31] = (crc_val >> 8) & 0xFF;

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    uint8_t nonce[13], aad[16], ct[32], mic[4];
    memcpy(nonce, frame_header, 13);
    memcpy(aad, frame_header, 16);

    mbedtls_ccm_context ctx;
    mbedtls_ccm_init(&ctx);
    mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, pairing_key, 128);
    mbedtls_ccm_encrypt_and_tag(&ctx, 32, nonce, 13, aad, 16, plaintext, ct, mic, 4);
    mbedtls_ccm_free(&ctx);

    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), ct, ct + 32);
    frame.insert(frame.end(), mic, mic + 4);

    this->send_raw_rf_frame(frame);
    ESP_LOGI(TAG, "%s: Sent Broadcast RS #%d (seq=%d)", dev->serial_no.c_str(), dev->pair_tx_count_, dev->beacon_seq_);
  }

  void send_unicast_echo_packet(EmulatedDevice *dev) {
    uint8_t echo_seq = dev->seq_num++; // Unified seq counter (was beacon_seq_)

    uint8_t icmp[8];
    icmp[0] = 0x80; // Echo Request
    icmp[1] = 0x00;
    icmp[2] = 0x00; icmp[3] = 0x00;
    icmp[4] = 0x40; icmp[5] = 0x40;
    icmp[6] = 0x07; icmp[7] = 0x08;

    uint8_t src_ip[16], dst_ip[16];
    get_link_local_ip(dev->mac_addr, src_ip);
    get_link_local_ip(dev->ib_mac, dst_ip);

    uint16_t csum = compute_ipv6_checksum(src_ip, dst_ip, 58, icmp, 8);
    icmp[2] = (csum >> 8) & 0xFF;
    icmp[3] = csum & 0xFF;

    uint8_t frame_header[16];
    frame_header[0] = 0x69; frame_header[1] = 0xEC;
    frame_header[2] = echo_seq;
    uint16_t pan = dev->get_ib_pan();
    frame_header[3] = pan & 0xFF;
    frame_header[4] = (pan >> 8) & 0xFF;
    memcpy(frame_header + 5, dev->ib_mac + 2, 6);
    memcpy(frame_header + 11, dev->mac_addr, 2);
    memcpy(frame_header + 13, dev->mac_addr + 2, 3);

    uint8_t plaintext[32];
    size_t pt_len = 0;
    plaintext[pt_len++] = dev->mac_addr[5];
    plaintext[pt_len++] = dev->mac_addr[6];
    plaintext[pt_len++] = dev->mac_addr[7];
    plaintext[pt_len++] = 0x04;
    plaintext[pt_len++] = echo_seq;
    plaintext[pt_len++] = 0x00;
    plaintext[pt_len++] = 0x00;
    plaintext[pt_len++] = 0x00;
    plaintext[pt_len++] = 0x7A; // Dispatch: 0x7A
    plaintext[pt_len++] = 0x33;
    plaintext[pt_len++] = 0x3A; // Next Header: ICMPv6
    memcpy(plaintext + pt_len, icmp, 8);
    pt_len += 8;

    uint8_t crc_data[35];
    memcpy(crc_data, frame_header, 16);
    memcpy(crc_data + 16, plaintext, 19);
    uint16_t crc_val = compute_crc16_kermit(crc_data, 35);
    plaintext[19] = crc_val & 0xFF;
    plaintext[20] = (crc_val >> 8) & 0xFF;
    pt_len = 21;

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *key_to_use = (dev->pairing_state == STATE_PAIRED && dev->has_op_key) ? dev->op_key : pairing_key;
    uint8_t nonce[13], aad[16], ct[32], mic[4];
    memcpy(nonce, frame_header, 13);
    memcpy(aad, frame_header, 16);

    mbedtls_ccm_context ctx;
    mbedtls_ccm_init(&ctx);
    mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key_to_use, 128);
    mbedtls_ccm_encrypt_and_tag(&ctx, pt_len, nonce, 13, aad, 16, plaintext, ct, mic, 4);
    mbedtls_ccm_free(&ctx);

    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), ct, ct + pt_len);
    frame.insert(frame.end(), mic, mic + 4);

    this->send_raw_rf_frame(frame);
    ESP_LOGI(TAG, "[Unicast Echo] %s: Transmitted Echo Request #%d (seq=%d, DestPAN=0x%04X, DestMAC=%02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X, SrcMAC=%02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X)",
             dev->serial_no.c_str(), dev->pair_tx_count_, echo_seq, pan,
             dev->ib_mac[0], dev->ib_mac[1], dev->ib_mac[2], dev->ib_mac[3],
             dev->ib_mac[4], dev->ib_mac[5], dev->ib_mac[6], dev->ib_mac[7],
             dev->mac_addr[0], dev->mac_addr[1], dev->mac_addr[2], dev->mac_addr[3],
             dev->mac_addr[4], dev->mac_addr[5], dev->mac_addr[6], dev->mac_addr[7]);
  }

  void send_csl_data_poll(EmulatedDevice *dev, uint8_t strobe_seq) {
    uint8_t pkt[27];
    pkt[0] = 0x42;
    pkt[1] = 0xEE;
    pkt[2] = strobe_seq;
    memcpy(pkt + 3, dev->ib_mac, 8);
    memcpy(pkt + 11, dev->mac_addr, 8);
    pkt[19] = 0x04;
    pkt[20] = 0x0D;
    pkt[21] = 0x00;
    pkt[22] = 0x00;
    pkt[23] = 0x35;
    pkt[24] = 0x0C;
    pkt[25] = 0x80;
    pkt[26] = 0x3F;

    this->send_raw_rf_frame(pkt, sizeof(pkt));
    ESP_LOGI(TAG, "[CSL Data Poll] %s: Sent 802.15.4e CSL Data Request Poll for Strobe Seq=%d (Dest=Bridge %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X)",
             dev->serial_no.c_str(), strobe_seq,
             dev->ib_mac[0], dev->ib_mac[1], dev->ib_mac[2], dev->ib_mac[3],
             dev->ib_mac[4], dev->ib_mac[5], dev->ib_mac[6], dev->ib_mac[7]);
  }

  void send_router_solicitation(EmulatedDevice *dev, const uint8_t *key = nullptr) {
    uint8_t frame_seq = dev->seq_num++;

    uint8_t frame_header[16];
    frame_header[0] = 0x49;
    frame_header[1] = 0xE8;
    frame_header[2] = frame_seq;
    frame_header[3] = 0xFF; // Broadcast PAN / Short
    frame_header[4] = 0xFF;
    memcpy(frame_header + 5, dev->mac_addr, 8);
    frame_header[13] = 0x04;
    frame_header[14] = 0x01;
    frame_header[15] = 0x00;

    uint8_t tx_plaintext[32];
    memset(tx_plaintext, 0, 32);
    tx_plaintext[2] = 0x7B;
    tx_plaintext[3] = 0x3B;
    tx_plaintext[4] = 0x3A;
    tx_plaintext[5] = 0x02;
    tx_plaintext[6] = 0x85; // ICMPv6 Type 133: RS
    tx_plaintext[7] = 0x00;

    uint32_t serial_num = 0;
    if (dev->serial_no.length() > 2) {
      serial_num = (uint32_t)strtoull(dev->serial_no.substr(2).c_str(), nullptr, 10);
    }
    tx_plaintext[8] = (serial_num & 0xFF);
    tx_plaintext[9] = ((serial_num >> 8) & 0xFF);
    tx_plaintext[10] = ((serial_num >> 16) & 0xFF);
    tx_plaintext[11] = ((serial_num >> 24) & 0xFF);

    tx_plaintext[14] = 0x01; // ICMPv6 Option 1: Source Link-Layer Address
    tx_plaintext[15] = 0x02; // Length 2
    for (int i = 0; i < 8; i++) {
      tx_plaintext[16 + i] = dev->mac_addr[7 - i];
    }

    // CRC16 Kermit over 16B header + 30B PT = 46B
    uint8_t crc_data[46];
    memcpy(crc_data, frame_header, 16);
    memcpy(crc_data + 16, tx_plaintext, 30);
    uint16_t crc_val = compute_crc16_kermit(crc_data, 46);
    tx_plaintext[30] = crc_val & 0xFF;
    tx_plaintext[31] = (crc_val >> 8) & 0xFF;

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *enc_key = (key != nullptr) ? key : (dev->has_op_key ? dev->op_key : pairing_key);
    uint8_t nonce[13], aad[16], ct[32], mic[4];
    memcpy(nonce, frame_header, 13);
    memcpy(aad, frame_header, 16);

    mbedtls_ccm_context ctx;
    mbedtls_ccm_init(&ctx);
    mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, enc_key, 128);
    mbedtls_ccm_encrypt_and_tag(&ctx, 32, nonce, 13, aad, 16, tx_plaintext, ct, mic, 4);
    mbedtls_ccm_free(&ctx);

    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), ct, ct + 32);
    frame.insert(frame.end(), mic, mic + 4);

    this->send_raw_rf_frame(frame);
    ESP_LOGI(TAG, "%s: Sent Router Solicitation (RS) broadcast beacon (seq=%d)", dev->serial_no.c_str(), frame_seq);
  }

  void send_neighbor_advertisement(EmulatedDevice *dev, const uint8_t *key = nullptr) {
    uint8_t frame_seq = dev->seq_num++;

    uint8_t frame_header[16];
    frame_header[0] = 0x69; frame_header[1] = 0xEC;
    frame_header[2] = frame_seq;
    uint16_t pan = dev->get_ib_pan();
    frame_header[3] = pan & 0xFF;
    frame_header[4] = (pan >> 8) & 0xFF;
    memcpy(frame_header + 5, dev->ib_mac + 2, 6);
    memcpy(frame_header + 11, dev->mac_addr, 2);
    memcpy(frame_header + 13, dev->mac_addr + 2, 3);

    uint8_t tx_plaintext[64];
    size_t tx_pt_len = 0;
    tx_plaintext[tx_pt_len++] = dev->mac_addr[5];
    tx_plaintext[tx_pt_len++] = dev->mac_addr[6];
    tx_plaintext[tx_pt_len++] = dev->mac_addr[7];
    tx_plaintext[tx_pt_len++] = 0x04;
    tx_plaintext[tx_pt_len++] = frame_seq;
    tx_plaintext[tx_pt_len++] = 0x00; tx_plaintext[tx_pt_len++] = 0x00; tx_plaintext[tx_pt_len++] = 0x00;
    tx_plaintext[tx_pt_len++] = 0x7B; tx_plaintext[tx_pt_len++] = 0x33; tx_plaintext[tx_pt_len++] = 0x3A;

    uint8_t icmp_data[40];
    memset(icmp_data, 0, 40);
    icmp_data[0] = 0x88; // Type 136: NA
    icmp_data[1] = 0x00;
    icmp_data[4] = 0x60; // Solicited=1, Override=1

    uint8_t va_ip[16];
    get_link_local_ip(dev->mac_addr, va_ip);
    memcpy(icmp_data + 8, va_ip, 16);

    icmp_data[24] = 0x02; // Type 2: Target Link-Layer Address
    icmp_data[25] = 0x02; // Length 2
    for (int i = 0; i < 8; i++) icmp_data[26 + i] = dev->mac_addr[7 - i];

    uint8_t dst_ip[16];
    get_link_local_ip(dev->ib_mac, dst_ip);
    uint16_t csum = compute_ipv6_checksum(va_ip, dst_ip, 58, icmp_data, 40);
    icmp_data[2] = (csum >> 8) & 0xFF;
    icmp_data[3] = csum & 0xFF;

    memcpy(tx_plaintext + tx_pt_len, icmp_data, 40);
    tx_pt_len += 40;

    // Compute Frame CRC16 Kermit (over 16-byte frame header + 51-byte plaintext payload = 67 bytes)
    uint8_t crc_data[67];
    memcpy(crc_data, frame_header, 16);
    memcpy(crc_data + 16, tx_plaintext, 51);
    uint16_t crc_val = compute_crc16_kermit(crc_data, 67);
    tx_plaintext[51] = crc_val & 0xFF;
    tx_plaintext[52] = (crc_val >> 8) & 0xFF;
    tx_pt_len = 53;

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *enc_key = (key != nullptr) ? key : (dev->has_op_key ? dev->op_key : pairing_key);
    uint8_t nonce[13], aad[16], ct[64], mic[4];
    memcpy(nonce, frame_header, 13);
    memcpy(aad, frame_header, 16);

    mbedtls_ccm_context ctx;
    mbedtls_ccm_init(&ctx);
    mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, enc_key, 128);
    mbedtls_ccm_encrypt_and_tag(&ctx, tx_pt_len, nonce, 13, aad, 16, tx_plaintext, ct, mic, 4);
    mbedtls_ccm_free(&ctx);

    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), ct, ct + tx_pt_len);
    frame.insert(frame.end(), mic, mic + 4);

    this->send_raw_rf_frame(frame);
    ESP_LOGI(TAG, "%s: Sent Neighbor Advertisement", dev->serial_no.c_str());
  }

  void send_echo_reply(EmulatedDevice *dev, const std::vector<uint8_t> &req_decrypted, const uint8_t *key = nullptr) {
    uint8_t frame_seq = dev->seq_num++;

    uint8_t frame_header[16];
    frame_header[0] = 0x69; frame_header[1] = 0xEC;
    frame_header[2] = frame_seq;
    uint16_t pan = dev->get_ib_pan();
    frame_header[3] = pan & 0xFF;
    frame_header[4] = (pan >> 8) & 0xFF;
    memcpy(frame_header + 5, dev->ib_mac + 2, 6);
    memcpy(frame_header + 11, dev->mac_addr, 2);
    memcpy(frame_header + 13, dev->mac_addr + 2, 3);

    uint8_t tx_plaintext[64];
    size_t tx_pt_len = 0;
    tx_plaintext[tx_pt_len++] = dev->mac_addr[5];
    tx_plaintext[tx_pt_len++] = dev->mac_addr[6];
    tx_plaintext[tx_pt_len++] = dev->mac_addr[7];
    tx_plaintext[tx_pt_len++] = 0x04;
    tx_plaintext[tx_pt_len++] = frame_seq;
    tx_plaintext[tx_pt_len++] = 0x00; tx_plaintext[tx_pt_len++] = 0x00; tx_plaintext[tx_pt_len++] = 0x00;
    tx_plaintext[tx_pt_len++] = 0x7A; tx_plaintext[tx_pt_len++] = 0x33; tx_plaintext[tx_pt_len++] = 0x3A;

    size_t icmp_req_offset = 11;
    for (size_t i = 0; i + 4 <= req_decrypted.size() && i < 12; i++) {
      if ((req_decrypted[i] == 0x7A || req_decrypted[i] == 0x7B) && req_decrypted[i+1] == 0x33 && req_decrypted[i+2] == 0x3A) {
        icmp_req_offset = i + 3;
        break;
      }
    }

    size_t echo_body_len = (req_decrypted.size() > icmp_req_offset + 4) ? (req_decrypted.size() - 2 - icmp_req_offset) : 8;
    if (echo_body_len > 32) echo_body_len = 32;

    uint8_t icmp_data[36];
    memset(icmp_data, 0, sizeof(icmp_data));
    icmp_data[0] = 0x81; // Type 129: Echo Reply
    icmp_data[1] = 0x00; // Code 0

    if (req_decrypted.size() >= icmp_req_offset + echo_body_len) {
      memcpy(icmp_data + 4, req_decrypted.data() + icmp_req_offset + 4, echo_body_len - 4);
    }

    uint8_t va_ip[16], dst_ip[16];
    get_link_local_ip(dev->mac_addr, va_ip);
    get_link_local_ip(dev->ib_mac, dst_ip);
    uint16_t csum = compute_ipv6_checksum(va_ip, dst_ip, 58, icmp_data, echo_body_len);
    icmp_data[2] = (csum >> 8) & 0xFF;
    icmp_data[3] = csum & 0xFF;

    memcpy(tx_plaintext + tx_pt_len, icmp_data, echo_body_len);
    tx_pt_len += echo_body_len;

    std::vector<uint8_t> crc_data;
    crc_data.insert(crc_data.end(), frame_header, frame_header + 16);
    crc_data.insert(crc_data.end(), tx_plaintext, tx_plaintext + tx_pt_len);
    uint16_t crc_val = compute_crc16_kermit(crc_data.data(), crc_data.size());
    tx_plaintext[tx_pt_len++] = crc_val & 0xFF;
    tx_plaintext[tx_pt_len++] = (crc_val >> 8) & 0xFF;

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *enc_key = (key != nullptr) ? key : (dev->has_op_key ? dev->op_key : pairing_key);
    uint8_t nonce[13], aad[16], ct[64], mic[4];
    memcpy(nonce, frame_header, 13);
    memcpy(aad, frame_header, 16);

    mbedtls_ccm_context ctx;
    mbedtls_ccm_init(&ctx);
    mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, enc_key, 128);
    mbedtls_ccm_encrypt_and_tag(&ctx, tx_pt_len, nonce, 13, aad, 16, tx_plaintext, ct, mic, 4);
    mbedtls_ccm_free(&ctx);

    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), ct, ct + tx_pt_len);
    frame.insert(frame.end(), mic, mic + 4);

    this->send_raw_rf_frame(frame);
    ESP_LOGI(TAG, "%s: Sent Echo Reply (0x81)", dev->serial_no.c_str());
  }

  void send_coap_ack(EmulatedDevice *dev, uint16_t mid, uint8_t code, const uint8_t *key, const uint8_t *dest_mac, const std::vector<uint8_t> &payload = {}, bool is_pairing = false, const std::vector<uint8_t> &req_token = {}, uint16_t dst_port = 4005) {
    std::vector<uint8_t> coap;
    uint8_t tkl = (uint8_t)std::min((size_t)8, req_token.size());
    coap.push_back(0x60 | (tkl & 0x0F)); // Type=ACK (0x60) | TKL
    coap.push_back(code); // e.g. 68 = 2.04 Changed, 69 = 2.05 Content
    coap.push_back((mid >> 8) & 0xFF);
    coap.push_back(mid & 0xFF);
    for (size_t i = 0; i < tkl; i++) coap.push_back(req_token[i]);

    // Option 12: Content-Format = 42 (0xC1 0x2A) - only when payload is non-empty
    uint16_t last_opt = 0;
    if (!payload.empty()) {
      coap.push_back(0xC1);
      coap.push_back(0x2A);
      last_opt = 12;
    }

    // Option 2048 (Session Token) is only included on 2.05 Content responses with valid non-zero token
    bool token_non_zero = false;
    for (int i = 0; i < 8; i++) { if (dev->session_token[i] != 0) { token_non_zero = true; break; } }
    if (code == 69 && dev->has_session_token && token_non_zero) {
      uint16_t delta_2048 = 2048 - last_opt;
      uint16_t ext_delta = delta_2048 - 269;
      coap.push_back(0xE8); // Delta=14(ext 2-byte), Length=8
      coap.push_back((ext_delta >> 8) & 0xFF);
      coap.push_back(ext_delta & 0xFF);
      for (int i = 0; i < 8; i++) coap.push_back(dev->session_token[i]);
    }

    if (!payload.empty()) {
      coap.push_back(0xFF);
      coap.insert(coap.end(), payload.begin(), payload.end());
    }

    uint8_t frame_seq = dev->seq_num++;
    uint8_t frame_header[16];
    frame_header[0] = 0x69;
    frame_header[1] = 0xEC;
    frame_header[2] = frame_seq;
    uint16_t pan = dev->get_ib_pan();
    frame_header[3] = pan & 0xFF;
    frame_header[4] = (pan >> 8) & 0xFF;
    if (dest_mac && (dest_mac[0] != 0xFF || dest_mac[7] != 0xFF)) {
      memcpy(frame_header + 5, dest_mac + 2, 6);
    } else {
      memset(frame_header + 5, 0xFF, 6);
    }
    frame_header[11] = dev->mac_addr[0];
    frame_header[12] = dev->mac_addr[1];
    frame_header[13] = dev->mac_addr[2];
    frame_header[14] = dev->mac_addr[3];
    frame_header[15] = dev->mac_addr[4];

    std::vector<uint8_t> pt;
    pt.push_back(dev->mac_addr[5]);
    pt.push_back(dev->mac_addr[6]);
    pt.push_back(dev->mac_addr[7]);
    pt.push_back(0x04);

    // 4-byte sequence counter
    pt.push_back(frame_seq); pt.push_back(0x00); pt.push_back(0x00); pt.push_back(0x00);
    // Tado Custom Dispatch: 6LoWPAN UDP (0x7E)
    pt.push_back(0x7E);
    // 6LoWPAN NHC (Port 5683 -> dst_port)
    pt.push_back(0x33); pt.push_back(0xF0); pt.push_back(0x16); pt.push_back(0x33);
    pt.push_back((dst_port >> 8) & 0xFF); pt.push_back(dst_port & 0xFF);

    // Compute IPv6 UDP Checksum (src=5683, dst=dst_port)
    uint8_t src_ip[16], dst_ip[16];
    get_link_local_ip(dev->mac_addr, src_ip);
    get_link_local_ip((dest_mac && (dest_mac[0] != 0xFF || dest_mac[7] != 0xFF)) ? dest_mac : dev->ib_mac, dst_ip);
    std::vector<uint8_t> udp_pkt(8 + coap.size(), 0);
    udp_pkt[0] = 0x16; udp_pkt[1] = 0x33; // src port 5683
    udp_pkt[2] = (dst_port >> 8) & 0xFF; udp_pkt[3] = dst_port & 0xFF; // dst port (e.g. 4005 for IB)
    uint16_t udp_len = 8 + coap.size();
    udp_pkt[4] = (udp_len >> 8) & 0xFF; udp_pkt[5] = udp_len & 0xFF;
    memcpy(udp_pkt.data() + 8, coap.data(), coap.size());
    uint16_t udp_csum = compute_ipv6_checksum(src_ip, dst_ip, 17, udp_pkt.data(), udp_len);
    pt.push_back((udp_csum >> 8) & 0xFF); pt.push_back(udp_csum & 0xFF);

    pt.insert(pt.end(), coap.begin(), coap.end());

    // Compute Frame CRC16 Kermit (over 16-byte frame_header + plaintext payload)
    std::vector<uint8_t> crc_data;
    crc_data.insert(crc_data.end(), frame_header, frame_header + 16);
    crc_data.insert(crc_data.end(), pt.begin(), pt.end());
    uint16_t crc_val = compute_crc16_kermit(crc_data.data(), crc_data.size());
    pt.push_back(crc_val & 0xFF);
    pt.push_back((crc_val >> 8) & 0xFF);

    uint8_t nonce[13];
    memcpy(nonce, frame_header, 13);
    uint8_t aad[16];
    memcpy(aad, frame_header, 16);

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *key_to_use = key ? key : (dev->has_op_key ? dev->op_key : pairing_key);

    std::vector<uint8_t> encrypted(pt.size());
    uint8_t mic[4];
    mbedtls_ccm_context ccm;
    mbedtls_ccm_init(&ccm);
    mbedtls_ccm_setkey(&ccm, MBEDTLS_CIPHER_ID_AES, key_to_use, 128);
    mbedtls_ccm_encrypt_and_tag(&ccm, pt.size(), nonce, 13, aad, 16, pt.data(), encrypted.data(), mic, 4);
    mbedtls_ccm_free(&ccm);

    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), encrypted.begin(), encrypted.end());
    frame.push_back(mic[0]); frame.push_back(mic[1]); frame.push_back(mic[2]); frame.push_back(mic[3]);

    this->send_raw_rf_frame(frame);
    ESP_LOGI(TAG, "[CoAP TX] %s: Sent CoAP Code=%d (0x%02X) ACK for MID=0x%04X", dev->serial_no.c_str(), code, code, mid);
  }

  void send_pair_ack_204(EmulatedDevice *dev, uint16_t mid, const uint8_t *dest_mac = nullptr, const std::vector<uint8_t> &req_token = {}, uint16_t dst_port = 4005) {
    const uint8_t *key_to_use = dev->has_factory_key ? dev->factory_key : (const uint8_t*)"\x74\x61\x64\x6f\x20\x70\x61\x69\x72\x69\x6e\x67\x20\x6b\x65\x79";
    this->send_coap_ack(dev, mid, 68 /* 2.04 Changed */, key_to_use, dest_mac ? dest_mac : dev->ib_mac, {}, true, req_token, dst_port);
  }

  // -------------------------------------------------------------------------
  // CoAP & Radio Packet Transmission Engine
  // -------------------------------------------------------------------------

  void send_coap_request(EmulatedDevice *dev, uint8_t code, const std::string &path, const std::vector<uint8_t> &payload) {
    if (!dev->has_op_key) {
      ESP_LOGW(TAG, "Device %s has no operational key. Cannot send encrypted CoAP packet.", dev->serial_no.c_str());
      return;
    }
    this->send_coap_raw(dev, code, path, payload, dev->op_key, true);
  }

  void send_coap_raw(EmulatedDevice *dev, uint8_t code, const std::string &path, const std::vector<uint8_t> &payload, const uint8_t *key, bool use_token) {
    if (dev->ib_mac_known) {
      this->send_coap_raw_dest(dev, code, path, payload, key, use_token, dev->ib_mac);
    } else {
      const uint8_t bcast_mac[8] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
      this->send_coap_raw_dest(dev, code, path, payload, key, use_token, bcast_mac);
    }
  }

  void send_coap_raw_dest(EmulatedDevice *dev, uint8_t code, const std::string &path, const std::vector<uint8_t> &payload, const uint8_t *key, bool use_token, const uint8_t *dest_mac) {
    std::vector<uint8_t> coap;
    uint16_t mid = dev->coap_mid++;

    // CoAP Header (Confirmable = 0x40 | TokenLen = 0x00)
    coap.push_back(0x40);
    coap.push_back(code);
    coap.push_back((mid >> 8) & 0xFF);
    coap.push_back(mid & 0xFF);

    // Option 11: Uri-Path
    size_t start = 0;
    uint16_t last_opt = 0;
    while (start < path.length()) {
      size_t slash = path.find('/', start);
      std::string segment = (slash == std::string::npos) ? path.substr(start) : path.substr(start, slash - start);
      uint16_t opt_delta = 11 - last_opt;
      coap.push_back(((opt_delta & 0x0F) << 4) | ((uint8_t)segment.length() & 0x0F));
      for (char c : segment) coap.push_back((uint8_t)c);
      last_opt = 11;
      if (slash == std::string::npos) break;
      start = slash + 1;
    }

    // Option 12: Content-Format = 42 (0x11 0x2A) if payload is non-empty
    if (!payload.empty()) {
      coap.push_back(0x11); // Delta=1 (12 - 11), Length=1
      coap.push_back(0x2A); // Content-Format = 42 (Binary TLV)
      last_opt = 12;
    }

    // Option 2048 (Session Token) if applicable
    if (use_token && dev->has_session_token) {
      uint16_t delta_2048 = 2048 - last_opt; // 2036 if last_opt=12, 2037 if last_opt=11
      uint16_t ext_delta = delta_2048 - 269; // 1767 (0x06E7) or 1768 (0x06E8)
      coap.push_back(0xE8); // Delta=14(ext 2-byte), Length=8
      coap.push_back((ext_delta >> 8) & 0xFF); // Extended delta MSB
      coap.push_back(ext_delta & 0xFF);        // Extended delta LSB
      for (int i = 0; i < 8; i++) coap.push_back(dev->session_token[i]);
    }

    // Payload Marker & Payload
    if (!payload.empty()) {
      coap.push_back(0xFF);
      coap.insert(coap.end(), payload.begin(), payload.end());
    }

    uint8_t frame_seq = dev->seq_num++; // Capture sequence number

    // 1. Build IEEE 802.15.4 Cleartext Frame Header (16 Bytes per rf_protocol.md §2)
    uint8_t frame_header[16];
    frame_header[0] = 0x69; // FCF low
    frame_header[1] = 0xEC; // FCF high
    frame_header[2] = frame_seq;
    if (dest_mac && (dest_mac[0] != 0xFF || dest_mac[7] != 0xFF)) {
      uint16_t pan = dev->get_ib_pan();
      frame_header[3] = pan & 0xFF;
      frame_header[4] = (pan >> 8) & 0xFF;
      memcpy(frame_header + 5, dest_mac + 2, 6);
    } else {
      memset(frame_header + 3, 0xFF, 8);
    }
    // Source MAC Prefix (2 Bytes in LE: dev->mac_addr[0..1])
    frame_header[11] = dev->mac_addr[0];
    frame_header[12] = dev->mac_addr[1];
    // Source MAC Middle (3 Bytes in LE: dev->mac_addr[2..4])
    frame_header[13] = dev->mac_addr[2];
    frame_header[14] = dev->mac_addr[3];
    frame_header[15] = dev->mac_addr[4];

    // 2. Build Plaintext (Hidden Address Tail + Inner Header + Dispatch + 6LoWPAN NHC + CoAP)
    std::vector<uint8_t> pt;
    // Source MAC Tail (3 Bytes in LE: dev->mac_addr[5..7] = OUI 0xC5, 0x1B, 0x00, hidden in ciphertext)
    pt.push_back(dev->mac_addr[5]);
    pt.push_back(dev->mac_addr[6]);
    pt.push_back(dev->mac_addr[7]);
    // Inner Protocol Header (0x04 = Operational/Standard)
    pt.push_back(0x04);
    // 4-byte Monotonic Sequence Counter
    pt.push_back(frame_seq); pt.push_back(0x00); pt.push_back(0x00); pt.push_back(0x00);

    // Compute IPv6 UDP Checksum
    uint8_t src_ip[16], dst_ip[16];
    get_link_local_ip(dev->mac_addr, src_ip);
    get_link_local_ip(dest_mac ? dest_mac : dev->ib_mac, dst_ip);

    uint16_t dst_port = 4005; // Outbound CON requests target IB relay port 4005 (0x0FA5)

    std::vector<uint8_t> udp_pkt;
    udp_pkt.push_back(0x16); udp_pkt.push_back(0x33); // Src 5683
    udp_pkt.push_back((dst_port >> 8) & 0xFF); udp_pkt.push_back(dst_port & 0xFF); // Dst Port 4005
    uint16_t ulen = 8 + coap.size();
    udp_pkt.push_back((ulen >> 8) & 0xFF); udp_pkt.push_back(ulen & 0xFF);
    udp_pkt.push_back(0x00); udp_pkt.push_back(0x00);
    udp_pkt.insert(udp_pkt.end(), coap.begin(), coap.end());
    uint16_t ucsum = compute_ipv6_checksum(src_ip, dst_ip, 17, udp_pkt.data(), udp_pkt.size());

    // 6LoWPAN UDP Dispatch + NHC (Dispatch 0x7E, Ports 5683 -> dst_port, Checksum)
    pt.push_back(0x7E);
    pt.push_back(0x33); pt.push_back(0xF0); pt.push_back(0x16); pt.push_back(0x33);
    pt.push_back((dst_port >> 8) & 0xFF); pt.push_back(dst_port & 0xFF);
    pt.push_back((ucsum >> 8) & 0xFF); pt.push_back(ucsum & 0xFF);

    // Append CoAP Datagram
    pt.insert(pt.end(), coap.begin(), coap.end());

    // Compute Frame CRC16 Kermit (over 16-byte frame_header + plaintext payload)
    std::vector<uint8_t> crc_data;
    crc_data.insert(crc_data.end(), frame_header, frame_header + 16);
    crc_data.insert(crc_data.end(), pt.begin(), pt.end());
    uint16_t crc_val = compute_crc16_kermit(crc_data.data(), crc_data.size());
    pt.push_back(crc_val & 0xFF);
    pt.push_back((crc_val >> 8) & 0xFF);

    // 3. Encrypt with AES-128-CCM (13-Byte Nonce = frame_header[0..12], 16-Byte AAD = frame_header[0..15])
    uint8_t nonce[13];
    memcpy(nonce, frame_header, 13);
    uint8_t aad[16];
    memcpy(aad, frame_header, 16);

    std::vector<uint8_t> encrypted(pt.size());
    uint8_t mic[4];

    mbedtls_ccm_context ccm;
    mbedtls_ccm_init(&ccm);
    mbedtls_ccm_setkey(&ccm, MBEDTLS_CIPHER_ID_AES, key, 128);
    mbedtls_ccm_encrypt_and_tag(&ccm, pt.size(), nonce, 13, aad, 16, pt.data(), encrypted.data(), mic, 4);
    mbedtls_ccm_free(&ccm);

    // 4. Assemble Final IEEE 802.15.4 Physical Frame
    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), encrypted.begin(), encrypted.end());
    frame.push_back(mic[0]); frame.push_back(mic[1]); frame.push_back(mic[2]); frame.push_back(mic[3]);

    // Register pending request for CoAP CON retry (with rebuild state)
    if (dev->pending_requests.size() >= 8) {
      dev->pending_requests.erase(dev->pending_requests.begin());
    }
    PendingRequest pr;
    pr.mid = mid;
    pr.seq = frame_seq;
    pr.sent_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    pr.retry_count = 0;
    pr.frame = frame;
    pr.coap = coap; // Store CoAP datagram for rebuild
    memcpy(pr.key, key, 16);
    memcpy(pr.dest_mac, dest_mac, 8);
    memcpy(pr.src_mac, dev->mac_addr, 8);
    dev->pending_requests.push_back(pr);

    const char *method_str = (code == 1) ? "GET" : (code == 2 ? "POST" : (code == 3 ? "PUT" : (code == 4 ? "DELETE" : "CoAP")));
    ESP_LOGI(TAG, "[RF TX] %s: %s %s (MID=0x%04X, Seq=%u)",
             dev->serial_no.c_str(), method_str, path.c_str(), mid, frame_seq);

    // Transmit frame over SX1276 RF
    this->send_raw_rf_frame(frame);
  }


  /**
   * Rebuilds a PendingRequest frame with a fresh sequence number.
   * Re-encrypts using the stored CoAP datagram, key, and MAC addresses,
   * so the Bridge sees a unique seq and matching nonce on each retry.
   */
  std::vector<uint8_t> rebuild_pending_frame(const PendingRequest &pr, EmulatedDevice *dev, uint8_t new_seq) {
    // 1. Build frame header with new seq
    uint8_t frame_header[16];
    frame_header[0] = 0x69;
    frame_header[1] = 0xEC;
    frame_header[2] = new_seq;
    if (pr.dest_mac[0] != 0xFF || pr.dest_mac[7] != 0xFF) {
      uint16_t pan = dev->get_ib_pan();
      frame_header[3] = pan & 0xFF;
      frame_header[4] = (pan >> 8) & 0xFF;
      memcpy(frame_header + 5, pr.dest_mac + 2, 6);
    } else {
      memset(frame_header + 3, 0xFF, 8);
    }
    frame_header[11] = pr.src_mac[0];
    frame_header[12] = pr.src_mac[1];
    frame_header[13] = pr.src_mac[2];
    frame_header[14] = pr.src_mac[3];
    frame_header[15] = pr.src_mac[4];

    // 2. Build plaintext with new seq
    std::vector<uint8_t> pt;
    pt.push_back(pr.src_mac[5]);
    pt.push_back(pr.src_mac[6]);
    pt.push_back(pr.src_mac[7]);
    pt.push_back(0x04);
    pt.push_back(new_seq); pt.push_back(0x00); pt.push_back(0x00); pt.push_back(0x00);

    // 3. 6LoWPAN NHC header + UDP checksum + CoAP
    bool is_bcast = (pr.dest_mac[0] == 0xFF && pr.dest_mac[7] == 0xFF);
    uint16_t dst_port = 4005;
    uint8_t src_ip[16], dst_ip[16];
    get_link_local_ip(pr.src_mac, src_ip);
    get_link_local_ip(is_bcast ? dev->ib_mac : pr.dest_mac, dst_ip);

    std::vector<uint8_t> udp_pkt;
    udp_pkt.push_back(0x16); udp_pkt.push_back(0x33);
    udp_pkt.push_back((dst_port >> 8) & 0xFF); udp_pkt.push_back(dst_port & 0xFF);
    uint16_t ulen = 8 + pr.coap.size();
    udp_pkt.push_back((ulen >> 8) & 0xFF); udp_pkt.push_back(ulen & 0xFF);
    udp_pkt.push_back(0x00); udp_pkt.push_back(0x00);
    udp_pkt.insert(udp_pkt.end(), pr.coap.begin(), pr.coap.end());
    uint16_t ucsum = compute_ipv6_checksum(src_ip, dst_ip, 17, udp_pkt.data(), udp_pkt.size());

    pt.push_back(0x7E);
    pt.push_back(0x33); pt.push_back(0xF0); pt.push_back(0x16); pt.push_back(0x33);
    pt.push_back((dst_port >> 8) & 0xFF); pt.push_back(dst_port & 0xFF);
    pt.push_back((ucsum >> 8) & 0xFF); pt.push_back(ucsum & 0xFF);
    pt.insert(pt.end(), pr.coap.begin(), pr.coap.end());

    // 4. CRC
    std::vector<uint8_t> crc_data;
    crc_data.insert(crc_data.end(), frame_header, frame_header + 16);
    crc_data.insert(crc_data.end(), pt.begin(), pt.end());
    uint16_t crc_val = compute_crc16_kermit(crc_data.data(), crc_data.size());
    pt.push_back(crc_val & 0xFF);
    pt.push_back((crc_val >> 8) & 0xFF);

    // 5. Encrypt
    uint8_t nonce[13], aad[16];
    memcpy(nonce, frame_header, 13);
    memcpy(aad, frame_header, 16);
    std::vector<uint8_t> encrypted(pt.size());
    uint8_t mic[4];
    mbedtls_ccm_context ccm;
    mbedtls_ccm_init(&ccm);
    mbedtls_ccm_setkey(&ccm, MBEDTLS_CIPHER_ID_AES, pr.key, 128);
    mbedtls_ccm_encrypt_and_tag(&ccm, pt.size(), nonce, 13, aad, 16, pt.data(), encrypted.data(), mic, 4);
    mbedtls_ccm_free(&ccm);

    // 6. Assemble frame
    std::vector<uint8_t> frame;
    frame.insert(frame.end(), frame_header, frame_header + 16);
    frame.insert(frame.end(), encrypted.begin(), encrypted.end());
    frame.push_back(mic[0]); frame.push_back(mic[1]); frame.push_back(mic[2]); frame.push_back(mic[3]);
    return frame;
  }

  bool send_raw_rf_frame(const std::vector<uint8_t> &frame) {
    return this->send_raw_rf_frame(frame.data(), frame.size());
  }

  bool send_raw_rf_frame(const uint8_t *frame, size_t len) {
    if (frame == nullptr || len == 0 || len > 255) return false;

    if (xSemaphoreTake(this->spi_mutex_, pdMS_TO_TICKS(100)) != pdTRUE) return false;

    // If radio is actively receiving a frame (SyncAddress / Preamble detected), wait up to 5ms for RX to finish
    uint32_t defer_start = millis();
    while ((this->read_reg(REG_IRQ_FLAGS_1) & 0x1A) && (millis() - defer_start < 5)) {
      delayMicroseconds(100);
    }

    // Switch to STDBY (~100µs to settle)
    this->write_reg(REG_OP_MODE, 0x01);
    delayMicroseconds(150);

    // Flush any leftover RX/TX bytes from FIFO before writing new TX data
    int flush_count = 0;
    while (!(this->read_reg(REG_IRQ_FLAGS_2) & 0x40) && flush_count < 64) {
      this->read_reg(REG_FIFO);
      flush_count++;
    }
    this->write_reg(REG_IRQ_FLAGS_2, 0x10); // Reset FIFO flags

    // Pre-load FIFO with length byte + up to 63 bytes of data (SX1276 FIFO is 64 bytes total)
    size_t written = 0;
    this->enable();
    this->transfer_byte(REG_FIFO | 0x80);
    this->transfer_byte((uint8_t)len);
    size_t initial_chunk = std::min(len, (size_t)63);
    for (size_t i = 0; i < initial_chunk; i++) {
      this->transfer_byte(frame[i]);
    }
    written = initial_chunk;
    this->disable();

    // TX mode — preamble goes on air after PLL lock (~100µs)
    this->write_reg(REG_OP_MODE, 0x03);

    // Stream remaining bytes into FIFO as space becomes available (1 byte per non-full check to prevent FIFO overflow)
    while (written < len) {
      uint8_t irq2 = this->read_reg(REG_IRQ_FLAGS_2);
      if (!(irq2 & 0x20)) { // FIFO has space for at least 1 byte (FifoFull == 0)
        this->enable();
        this->transfer_byte(REG_FIFO | 0x80);
        this->transfer_byte(frame[written++]);
        this->disable();
      } else {
        delayMicroseconds(80);
      }
    }

    // Wait for TX complete (PacketSent flag)
    uint32_t tx_start = millis();
    while (!(this->read_reg(REG_IRQ_FLAGS_2) & 0x08)) {
      if (millis() - tx_start > 100) {
        ESP_LOGW(TAG, "TX timeout");
        this->write_reg(REG_OP_MODE, 0x05); // Return to RX
        xSemaphoreGive(this->spi_mutex_);
        return false;
      }
    }

    // Switch back to Continuous RX
    this->write_reg(REG_OP_MODE, 0x05);
    xSemaphoreGive(this->spi_mutex_);
    return true;
  }

  // -------------------------------------------------------------------------
  // SX1276 Hardware Initialization & FreeRTOS Radio Task
  // -------------------------------------------------------------------------

  void init_hardware() {
    if (this->rst_pin_ != nullptr) {
      this->rst_pin_->setup();
      this->rst_pin_->digital_write(false);
      delay(10);
      this->rst_pin_->digital_write(true);
      delay(20);
    }

    if (xSemaphoreTake(this->spi_mutex_, pdMS_TO_TICKS(500)) == pdTRUE) {
      this->write_reg(REG_OP_MODE, 0x00); // Sleep
      delay(10);
      this->write_reg(REG_OP_MODE, 0x01); // Standby

      // Bitrate: 50 kbps (32 MHz crystal -> 0x0280)
      this->write_reg(REG_BITRATE_MSB, 0x02);
      this->write_reg(REG_BITRATE_LSB, 0x80);

      // Frequency Deviation: 25.39 kHz -> 0x01A0 (matches CC110L / sniffer)
      this->write_reg(REG_FDEV_MSB, 0x01);
      this->write_reg(REG_FDEV_LSB, 0xA0);

      // Frequency: Channel 26 (868.323 MHz) — computed via set_tado_channel()
      {
        uint32_t f_hz = 863125000UL + ((uint32_t)this->channel_ * 199951UL);
        uint32_t frf = (uint32_t)((double)f_hz / 61.03515625 + 0.5);
        this->write_reg(REG_FRF_MSB, (frf >> 16) & 0xFF);
        this->write_reg(REG_FRF_MID, (frf >> 8) & 0xFF);
        this->write_reg(REG_FRF_LSB, frf & 0xFF);
      }

      // LNA: Maximum gain + LNA Boost for maximum sensitivity
      this->write_reg(0x0C, 0x23);

      // RX Config: AfcAutoOn, AgcAutoOn, RxTrigger=PreambleDetect+RSSI
      this->write_reg(REG_RX_CONFIG, 0x1E);

      // Receiver Bandwidth: 100 kHz (Mant=20, Exp=2)
      this->write_reg(REG_RX_BW, 0x0A);
      // AFC Bandwidth: 166.67 kHz (Mant=24, Exp=1)
      this->write_reg(REG_AFC_BW, 0x01);

      // AFC auto-clear on RX start
      this->write_reg(0x1A, 0x20);
      // RSSI Threshold: -105 dBm
      this->write_reg(0x10, 0xD2);

      // TX Preamble: 4 bytes (640µs at 50kbps — matches native CC110L MDMCFG1=0x22)
      this->write_reg(0x25, 0x00);
      this->write_reg(0x26, 0x04);

      // 3-byte preamble detection, tolerance=10
      this->write_reg(REG_PREAMBLE_DETECT, 0xCA);

      // Sync Word: D3 91 D3 91 (4-byte, matches Tado CC110L reference)
      this->write_reg(REG_SYNC_CONFIG, 0x73);
      this->write_reg(REG_SYNC_VALUE_1, 0xD3);
      this->write_reg(REG_SYNC_VALUE_2, 0x91);
      this->write_reg(REG_SYNC_VALUE_3, 0xD3);
      this->write_reg(REG_SYNC_VALUE_4, 0x91);

      // Packet Config: Variable length, CRC ON, CrcAutoClearOff=1, CCITT CRC
      this->write_reg(REG_PACKET_CONFIG_1, 0x99);
      this->write_reg(REG_PACKET_CONFIG_2, 0x40);
      this->write_reg(REG_PAYLOAD_LENGTH, 0x7F); // Max 127 bytes

      // PA_BOOST at maximum output power
      this->write_reg(REG_PA_CONFIG, 0x8F);
      // GFSK shaping BT=1.0 (matches CC110L)
      this->write_reg(REG_PARAMP, 0x29);
      // Map DIO2 to SyncAddress (wake radio task on sync word detection)
      this->write_reg(0x40, 0x0C);
      // FIFO Threshold = 14, TxStartCondition = FIFO Not Empty
      this->write_reg(REG_FIFO_THRESH, 0x8E);

      // Continuous Receive Mode
      this->write_reg(REG_OP_MODE, 0x05);
      xSemaphoreGive(this->spi_mutex_);
      ESP_LOGI(TAG, "SX1276 Transceiver configured for Channel %d (%.3f MHz)", this->channel_, (863125000.0 + this->channel_ * 199951.0) / 1e6);
    }

    if (this->dio0_pin_ != nullptr) {
      this->dio0_pin_->setup();
      auto *expose_pin = static_cast<ExposeInternalPin *>(this->dio0_pin_);
      expose_pin->attach_interrupt(TadoEmulatorComponent::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
    }
  }

  struct QueuedPacket {
    uint8_t len;
    uint8_t buffer[128];
    int rssi;
    bool crc_ok;
  };

  static void radio_task_entry(void *param) {
    auto *self = static_cast<TadoEmulatorComponent *>(param);
    bool last_was_active = false;
    while (true) {
      // 2026-08-27: Wake instantly on DIO0 ISR, or fallback after 1ms (when fast_fifo_drain is enabled) to prevent FIFO overruns on back-to-back packets
      uint32_t wait_ticks = pdMS_TO_TICKS(self->fast_fifo_drain_ ? 1 : 10);
      ulTaskNotifyTake(pdTRUE, wait_ticks > 0 ? wait_ticks : 1);
      self->radio_read_fifo(last_was_active);
    }
  }

  static void processing_task_entry(void *param) {
    auto *self = static_cast<TadoEmulatorComponent *>(param);
    QueuedPacket packet;
    while (true) {
      if (xQueueReceive(self->packet_queue_, &packet, portMAX_DELAY) == pdTRUE) {
        self->process_queued_packet(packet);
        vTaskDelay(0);
      }
    }
  }

  /**
   * @brief Streaming FIFO reader matching tado_pairing.h architecture.
   * Reads bytes on-the-fly as they arrive, before PayloadReady fires.
   * This avoids FIFO overruns for fast Bridge replies.
   */
  void radio_read_fifo(bool &last_was_active) {
    if (xSemaphoreTake(this->spi_mutex_, pdMS_TO_TICKS(5)) != pdTRUE) return;

    uint8_t irq1 = this->read_reg(REG_IRQ_FLAGS_1);
    uint8_t irq2 = this->read_reg(REG_IRQ_FLAGS_2);

    // FIFO Overrun recovery
    if (irq2 & 0x10) {
      ESP_LOGW(TAG, "FIFO Overrun detected. Clearing.");
      this->last_rx_time_ = millis();
      this->write_reg(REG_IRQ_FLAGS_2, 0x10);
      this->write_reg(REG_RX_CONFIG, 0x5E);
      last_was_active = false;
      xSemaphoreGive(this->spi_mutex_);
      return;
    }

    bool active = (irq1 & 0x1A) || !(irq2 & 0x40);

    if (!(irq2 & 0x40)) {
      // FIFO not empty — read packet on-the-fly
      this->read_packet_on_the_fly();
      last_was_active = false;
    } else if (active) {
      last_was_active = true;
    } else {
      last_was_active = false;
    }

    xSemaphoreGive(this->spi_mutex_);

    // RX watchdog: reset FSK receiver if no RX activity for 30s during pairing
    uint32_t now = millis();
    if (now - this->last_fifo_check_ > 1000) {
      this->last_fifo_check_ = now;
      bool any_pairing = false;
      if (xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(10)) == pdTRUE) {
        for (auto &dev : this->devices_) {
          if (dev.pairing_state == STATE_PAIR_BROADCAST_RS || dev.pairing_state == STATE_PAIR_UNICAST_RS) {
            any_pairing = true;
            break;
          }
        }
        xSemaphoreGiveRecursive(this->devices_mutex_);
      }
      if (any_pairing && now - this->last_rx_time_ > 30000) {
        ESP_LOGW(TAG, "RX watchdog timeout (30s). Resetting FSK receiver.");
        this->reset_fifo();
        this->last_rx_time_ = now;
      }
    }
  }

  /**
   * @brief On-the-fly streaming FIFO reader (matches tado_pairing.h architecture).
   * Called with SPI mutex held. Reads bytes as they stream in, waits for
   * PayloadReady at end for CRC validation, then queues packet for processing task.
   */
  void read_packet_on_the_fly() {
    this->last_rx_time_ = millis();

    // Read length byte
    this->enable();
    this->transfer_byte(REG_FIFO & 0x7F);
    uint8_t len = this->transfer_byte(0x00);
    this->disable();

    uint8_t rssi_raw = this->read_reg(REG_RSSIVALUE);

    if (len == 0 || len > 127) {
      this->write_reg(REG_IRQ_FLAGS_2, 0x10);
      this->write_reg(REG_RX_CONFIG, 0x5E);
      return;
    }

    QueuedPacket packet;
    packet.len = len;
    packet.rssi = -(int)rssi_raw / 2;

    uint8_t bytes_read = 0;
    uint32_t start_time = millis();
    uint8_t target_read_len = len - 1; // Read all but last byte before PayloadReady

    // Stream bytes from FIFO as they arrive (before PayloadReady)
    while (bytes_read < target_read_len) {
      if (millis() - start_time > 30) {
        this->write_reg(REG_IRQ_FLAGS_2, 0x10);
        this->write_reg(REG_RX_CONFIG, 0x5E);
        return;
      }

      uint8_t irq2 = this->read_reg(REG_IRQ_FLAGS_2);
      if (irq2 & 0x10) { // Overrun during read
        this->write_reg(REG_IRQ_FLAGS_2, 0x10);
        this->write_reg(REG_RX_CONFIG, 0x5E);
        return;
      }

      if (irq2 & 0x20) { // FIFO above threshold (SX1276 hardware threshold = 15 bytes)
        size_t burst_len = std::min((size_t)15, (size_t)(target_read_len - bytes_read));
        if (burst_len > 0) {
          this->enable();
          this->transfer_byte(REG_FIFO & 0x7F);
          for (size_t i = 0; i < burst_len; i++) {
            packet.buffer[bytes_read++] = this->transfer_byte(0x00);
          }
          this->disable();
        }
      } else if (!(irq2 & 0x40) && bytes_read < target_read_len) { // FIFO not empty (1 byte guaranteed)
        this->enable();
        this->transfer_byte(REG_FIFO & 0x7F);
        packet.buffer[bytes_read++] = this->transfer_byte(0x00);
        this->disable();
      } else if (bytes_read < target_read_len) {
        // 2026-08-27: Polling spin delay matching air data rate (80us)
        delayMicroseconds(80);
      }
    }

    // Wait for PayloadReady (CRC validation)
    if (!(this->read_reg(REG_IRQ_FLAGS_2) & 0x04)) {
      delayMicroseconds(200);
    }
    uint32_t wait_start = micros();
    while (!(this->read_reg(REG_IRQ_FLAGS_2) & 0x04)) {
      if (micros() - wait_start > 5000) break;
      delayMicroseconds(10);
    }

    uint8_t irq2_final = this->read_reg(REG_IRQ_FLAGS_2);
    packet.crc_ok = (irq2_final & 0x02) != 0;

    // Read remaining bytes
    while (bytes_read < len) {
      this->enable();
      this->transfer_byte(REG_FIFO & 0x7F);
      packet.buffer[bytes_read++] = this->transfer_byte(0x00);
      this->disable();
    }

    if (!packet.crc_ok) {
      this->write_reg(REG_IRQ_FLAGS_2, 0x10);
      this->write_reg(REG_RX_CONFIG, 0x5E);
      return;
    }

    // Configurable Unicast-filtered 802.15.4 MAC Auto-ACK (enabled via yaml `auto_mac_ack: true`)
    // Ultra-fast sub-millisecond turnaround matching CC1101 AIFS receiver window
    if (this->auto_mac_ack_ && len >= 5 && (packet.buffer[0] & 0x07) == 0x01 && (packet.buffer[0] & 0x20) != 0) {
      uint16_t fcf = packet.buffer[0] | ((uint16_t)packet.buffer[1] << 8);
      uint8_t dst_mode = (fcf >> 10) & 0x03;
      bool pan_compress = (fcf & 0x40) != 0;
      size_t dst_offset = pan_compress ? 3 : 5;
      bool is_for_us = false;
      if (dst_mode == 2 && len >= dst_offset + 2) {
        uint16_t dest_short = packet.buffer[dst_offset] | ((uint16_t)packet.buffer[dst_offset + 1] << 8);
        if (dest_short != 0xFFFF) {
          for (const auto &dev : this->devices_) {
            if (dev.short_addr == dest_short) {
              is_for_us = true;
              break;
            }
          }
        }
      } else if (dst_mode == 3 && len >= dst_offset + 6) {
        if (packet.buffer[dst_offset] != 0xFF || packet.buffer[dst_offset + 1] != 0xFF) {
          for (const auto &dev : this->devices_) {
            if (memcmp(dev.mac_addr + 2, packet.buffer + dst_offset, 6) == 0 ||
                (len >= dst_offset + 8 && memcmp(dev.mac_addr, packet.buffer + dst_offset, 8) == 0)) {
              is_for_us = true;
              break;
            }
          }
        }
      }
      if (is_for_us) {
        uint8_t ack_seq = packet.buffer[2];
        this->write_reg(REG_IRQ_FLAGS_2, 0x10); // Reset FIFO flags
        this->enable();
        this->transfer_byte(REG_FIFO | 0x80);
        this->transfer_byte(0x03); // Length = 3
        this->transfer_byte(0x02); // 802.15.4 Frame Type: MAC ACK
        this->transfer_byte(0x00);
        this->transfer_byte(ack_seq);
        this->disable();
        this->write_reg(REG_OP_MODE, 0x03); // Direct RX -> TX (60µs PLL lock)
        uint32_t t_tx = micros();
        while (!(this->read_reg(REG_IRQ_FLAGS_2) & 0x08)) {
          if (micros() - t_tx > 4000) break;
        }
        this->write_reg(REG_OP_MODE, 0x05); // Return to RX
        ESP_LOGI(TAG, "[RF MAC ACK TX] Sent 802.15.4 MAC ACK for downlink Seq=%u", ack_seq);
      }
    }

    // Pre-filter: accept data frames (type 0x01), MAC ACKs (type 0x02), and Multipurpose wakeup frames (type 0x05)
    if (len >= 2) {
      uint8_t f_type = packet.buffer[0] & 0x07;
      bool keep = false;
      if (f_type == 0x01) {
        uint8_t addr_mode = packet.buffer[1] & 0xCC;
        if (addr_mode == 0xCC || addr_mode == 0xC8 || addr_mode == 0xEC || addr_mode == 0xE8) {
          keep = true;
        }
      } else if (f_type == 0x02) {
        keep = true; // MAC ACK
      } else if (f_type == 0x05) {
        keep = true; // 802.15.4e CSL Multipurpose Wakeup Strobe
      }
      if (!keep) {
        this->write_reg(REG_IRQ_FLAGS_2, 0x10);
        this->write_reg(REG_RX_CONFIG, 0x5E);
        return;
      }
    }

    // 2026-08-27: Early-drop pre-filter on Core 0 for foreign unicast data frames before FreeRTOS queue dispatch
    if (len >= 5 && (packet.buffer[0] & 0x07) == 0x01) {
      uint16_t fcf = packet.buffer[0] | ((uint16_t)packet.buffer[1] << 8);
      uint8_t dst_mode = (fcf >> 10) & 0x03;
      bool pan_compress = (fcf & 0x40) != 0;
      size_t dst_offset = pan_compress ? 3 : 5;
      bool is_for_us = false;

      if (dst_mode == 2 && len >= dst_offset + 2) {
        uint16_t dest_short = packet.buffer[dst_offset] | ((uint16_t)packet.buffer[dst_offset + 1] << 8);
        if (dest_short == 0xFFFF) {
          is_for_us = true; // Broadcast
        } else {
          for (const auto &dev : this->devices_) {
            if (dev.short_addr == dest_short) {
              is_for_us = true;
              break;
            }
          }
        }
      } else if (dst_mode == 3 && len >= dst_offset + 6) {
        bool all_ff = true;
        for (size_t i = dst_offset; i < dst_offset + 6 && i < len; i++) {
          if (packet.buffer[i] != 0xFF) { all_ff = false; break; }
        }
        if (all_ff) {
          is_for_us = true; // Broadcast
        } else {
          for (const auto &dev : this->devices_) {
            if (memcmp(dev.mac_addr + 2, packet.buffer + dst_offset, 6) == 0 ||
                (len >= dst_offset + 8 && memcmp(dev.mac_addr, packet.buffer + dst_offset, 8) == 0)) {
              is_for_us = true;
              break;
            }
          }
        }
      } else {
        is_for_us = true; // Non-unicast or unknown addressing mode -> keep for Core 1 inspection
      }

      if (!is_for_us) {
        this->write_reg(REG_IRQ_FLAGS_2, 0x10);
        this->write_reg(REG_RX_CONFIG, 0x5E);
        return; // Dropped foreign unicast frame on Core 0 before queue / decrypt
      }
    }

    // Queue packet for processing task
    if (xQueueSend(this->packet_queue_, &packet, 0) != pdTRUE) {
      ESP_LOGW(TAG, "Packet queue full, dropping frame");
    }
  }

  void reset_fifo() {
    if (xSemaphoreTake(this->spi_mutex_, pdMS_TO_TICKS(100)) != pdTRUE) return;
    this->write_reg(REG_OP_MODE, 0x01); // STDBY
    delayMicroseconds(100);
    int flush_count = 0;
    while (!(this->read_reg(REG_IRQ_FLAGS_2) & 0x40) && flush_count < 64) {
      this->read_reg(REG_FIFO);
      flush_count++;
    }
    this->write_reg(REG_IRQ_FLAGS_2, 0x10);
    this->write_reg(REG_OP_MODE, 0x05); // RX
    xSemaphoreGive(this->spi_mutex_);
  }

  /**
   * @brief Process a queued packet on the processing task (Core 1).
   * Handles decryption, state machine transitions, and TX building
   * without blocking the radio FIFO reader.
   */
  void process_queued_packet(const QueuedPacket &pkt) {
    const uint8_t *buffer_data = pkt.buffer;
    size_t buf_len = pkt.len;
    if (buf_len < 3) return;
    uint16_t fcf = buffer_data[0] | ((uint16_t)buffer_data[1] << 8);
    uint8_t seq = buffer_data[2];

    if (xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(100)) != pdTRUE) return;

    // Handle 802.15.4 MAC ACK (Type 0x02)
    if ((fcf & 0x07) == 0x02) {
      ESP_LOGD(TAG, "[RF MAC ACK RX] Received 802.15.4 ACK for Seq=%d (0x%02X)", seq, seq);
      for (auto &dev : this->devices_) {
        for (auto it = dev.pending_requests.begin(); it != dev.pending_requests.end(); ++it) {
          if (it->seq == seq) {
            it->mac_confirmed = true;
            ESP_LOGI(TAG, "[RF MAC Confirmed] %s: Frame Seq=%d (MID=0x%04X) confirmed by Bridge MAC ACK (awaiting server CoAP response)",
                     dev.serial_no.c_str(), seq, it->mid);
          }
        }
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    // Check if this frame is addressed to one of our emulated devices:
    EmulatedDevice *target_dev = nullptr;
    bool is_broadcast = false;

    uint8_t frame_type = fcf & 0x07;
    uint8_t dst_mode = (fcf >> 10) & 0x03; // 2 = 16-bit short, 3 = 64-bit extended
    bool pan_compress = (fcf & 0x40) != 0;

    if (frame_type == 0x05 && buf_len >= 6) { // 802.15.4e CSL Multipurpose Wakeup Frame (no seq byte, Dest Short at bytes 4..5)
      uint16_t dest_short = buffer_data[4] | ((uint16_t)buffer_data[5] << 8);
      uint8_t strobe_seq = buffer_data[1];
      uint16_t countdown = (buf_len >= 10) ? (buffer_data[8] | ((uint16_t)buffer_data[9] << 8)) : 0;

      // Only respond at the tail end of the CSL strobe burst (when Bridge switches from TX to RX)
      if (countdown <= 0x000C) {
        uint32_t now_ms = millis();
        for (auto &dev : this->devices_) {
          if (dev.pairing_state == STATE_PAIRED && dev.short_addr == dest_short) {
            if (now_ms - dev.last_csl_wakeup_ms >= 500) {
              dev.last_csl_wakeup_ms = now_ms;
              ESP_LOGI(TAG, "[CSL Wakeup] Bridge strobe ending (dest=0x%04X, strobe_seq=0x%02X, count=0x%04X) for %s. Sending CSL Data Request Poll...",
                       dest_short, strobe_seq, countdown, dev.serial_no.c_str());
              this->send_csl_data_poll(&dev, strobe_seq);
            }
          }
        }
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    } else if (dst_mode == 2 && buf_len >= 5) {
      size_t dst_offset = pan_compress ? 3 : 5;
      if (buf_len >= dst_offset + 2) {
        uint16_t dest_short = buffer_data[dst_offset] | ((uint16_t)buffer_data[dst_offset + 1] << 8);
        if (dest_short == 0xFFFF) {
          is_broadcast = true;
        } else {
          for (auto &dev : this->devices_) {
            if (dev.short_addr == dest_short) {
              target_dev = &dev;
              break;
            }
          }
        }
      }
    } else if (dst_mode == 3 && buf_len >= 11) {
      size_t dst_offset = pan_compress ? 3 : 5;
      bool all_ff = true;
      for (size_t i = dst_offset; i < dst_offset + 6 && i < buf_len; i++) { if (buffer_data[i] != 0xFF) { all_ff = false; break; } }
      if (all_ff) {
        is_broadcast = true;
      } else {
        for (auto &dev : this->devices_) {
          // Check 6-byte compressed extended MAC
          if (memcmp(dev.mac_addr + 2, buffer_data + dst_offset, 6) == 0) {
            target_dev = &dev;
            break;
          }
          // Check 8-byte full extended MAC
          if (buf_len >= dst_offset + 8 && memcmp(dev.mac_addr, buffer_data + dst_offset, 8) == 0) {
            target_dev = &dev;
            break;
          }
        }
      }
    }

    if (is_broadcast) {
      for (auto &dev : this->devices_) {
        if (dev.pairing_state == STATE_PAIRED || dev.pairing_state == STATE_PAIR_BROADCAST_RS) {
          target_dev = &dev;
          break;
        }
      }
    }

    // Discard short wake-up probe frames (< 21 bytes) or non-encrypted frames
    if (buf_len < 21 || !(fcf & 0x08)) {
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    if (!target_dev) {
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    bool is_dup_rf = (fcf == target_dev->last_rx_fcf && seq == target_dev->last_rx_seq && buf_len == target_dev->last_rx_len);
    target_dev->last_rx_fcf = fcf;
    target_dev->last_rx_seq = seq;
    target_dev->last_rx_len = buf_len;

    is_broadcast = is_broadcast || (fcf == 0xE849 || fcf == 0xE859);
    if (is_dup_rf) {
      ESP_LOGD(TAG, "[RF RX Dup] %s: Len=%d, FCF=0x%04X, Seq=%d, RSSI=%d",
               is_broadcast ? "Broadcast" : target_dev->serial_no.c_str(), (int)buf_len, fcf, seq, pkt.rssi);
    } else {
      if (is_broadcast) {
        ESP_LOGI(TAG, "[RF Broadcast RX] Len=%d, FCF=0x%04X, Seq=%d, RSSI=%d",
                 (int)buf_len, fcf, seq, pkt.rssi);
      } else {
        ESP_LOGI(TAG, "[RF RX] Encrypted Frame for %s: Len=%d, FCF=0x%04X, Seq=%d, RSSI=%d",
                 target_dev->serial_no.c_str(), (int)buf_len, fcf, seq, pkt.rssi);
      }
    }

    // Setup AES-128-CCM Decryption:
    // Nonce = frame[0..12] (13 bytes), AAD = frame[0..15] (16 bytes MAC header)
    uint8_t nonce[13];
    memcpy(nonce, buffer_data, 13);
    uint8_t aad[16];
    memcpy(aad, buffer_data, 16);

    size_t cipher_len = buf_len - 16 - 4;
    const uint8_t *ciphertext = buffer_data + 16;
    const uint8_t *mic = buffer_data + buf_len - 4;

    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    const uint8_t *key_to_use = target_dev->has_op_key ? target_dev->op_key : pairing_key;
    const uint8_t *decrypted_key = key_to_use;

    std::vector<uint8_t> decrypted(cipher_len);
    mbedtls_ccm_context ccm;
    mbedtls_ccm_init(&ccm);
    mbedtls_ccm_setkey(&ccm, MBEDTLS_CIPHER_ID_AES, key_to_use, 128);
    int res = mbedtls_ccm_auth_decrypt(&ccm, cipher_len, nonce, 13, aad, 16, ciphertext, decrypted.data(), mic, 4);
    mbedtls_ccm_free(&ccm);

    if (res != 0) {
      // If operational key failed, try pairing key as fallback
      if (key_to_use != pairing_key) {
        mbedtls_ccm_init(&ccm);
        mbedtls_ccm_setkey(&ccm, MBEDTLS_CIPHER_ID_AES, pairing_key, 128);
        res = mbedtls_ccm_auth_decrypt(&ccm, cipher_len, nonce, 13, aad, 16, ciphertext, decrypted.data(), mic, 4);
        mbedtls_ccm_free(&ccm);
        if (res == 0) {
          decrypted_key = pairing_key;
        }
      }
      if (res != 0) {
        if (fcf == 0xE849 || fcf == 0xE859) {
          ESP_LOGD(TAG, "[RF Broadcast] Ignoring foreign broadcast frame (auth res=%d)", res);
        } else {
          ESP_LOGW(TAG, "[RF Crypto Failed] Decryption/auth failed (res=%d) for %s", res, target_dev->serial_no.c_str());
        }
        xSemaphoreGiveRecursive(this->devices_mutex_);
        return; // Decryption / Authentication failed
      }
    }

    if (!is_dup_rf) {
      ESP_LOGI(TAG, "[RF Decrypted] %s: Authenticated Plaintext len=%d", target_dev->serial_no.c_str(), (int)decrypted.size());
      std::string pt_hex = "";
      char hbuf[4];
      for (size_t i = 0; i < decrypted.size(); i++) {
        snprintf(hbuf, sizeof(hbuf), "%02X", decrypted[i]);
        pt_hex += hbuf;
      }
      ESP_LOGD(TAG, "[RF Plaintext HEX] %s: %s", target_dev->serial_no.c_str(), pt_hex.c_str());
    }

    // Reconstitute complete 8-byte Source MAC address in wire LE format
    uint8_t src_mac[8];
    if (fcf == 0xE849 || fcf == 0xE859) {
      // In 802.15.4 Broadcast frames, Source MAC is 8 bytes at buffer_data[5..12] in LE format
      memcpy(src_mac, buffer_data + 5, 8);
    } else {
      // Unicast: buffer_data[11..15] is src_mac[0..4] in LE, decrypted[0..2] is src_mac[5..7] in LE
      src_mac[0] = buffer_data[11];
      src_mac[1] = buffer_data[12];
      src_mac[2] = buffer_data[13];
      src_mac[3] = buffer_data[14];
      src_mac[4] = buffer_data[15];
      src_mac[5] = decrypted[0];
      src_mac[6] = decrypted[1];
      src_mac[7] = decrypted[2];
    }

    if (!is_dup_rf) {
      ESP_LOGI(TAG, "[RF Source MAC] %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X",
               src_mac[0], src_mac[1], src_mac[2], src_mac[3],
               src_mac[4], src_mac[5], src_mac[6], src_mac[7]);
    }

    // 6LoWPAN Fragment Reassembly (FRAG1: 0xC0..0xC7, FRAGN: 0xE0..0xE7)
    if (decrypted.size() >= 14 && (decrypted[8] & 0xF8) == 0xC0) {
      uint16_t d_size = (((uint16_t)(decrypted[8] & 0x07)) << 8) | decrypted[9];
      uint16_t d_tag = ((uint16_t)decrypted[10] << 8) | decrypted[11];
      size_t data_len = decrypted.size() >= 14 ? (decrypted.size() - 14) : 0; // Strip 12B header + 2B trailing Kermit CRC
      target_dev->frag_tag = d_tag;
      target_dev->frag_total_len = d_size;
      target_dev->frag_start_ts = millis();
      target_dev->frag_buf.assign(decrypted.begin(), decrypted.begin() + 8);
      target_dev->frag_buf.insert(target_dev->frag_buf.end(), decrypted.begin() + 12, decrypted.begin() + 12 + data_len);
      target_dev->frag_next_offset = (uint16_t)(data_len / 8);
      ESP_LOGI(TAG, "✓ [6LoWPAN FRAG1] %s: tag=0x%04X, size=%u, chunk=%u, next_off=%u",
               target_dev->serial_no.c_str(), d_tag, d_size, (unsigned int)data_len, target_dev->frag_next_offset);
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    } else if (decrypted.size() >= 15 && (decrypted[8] & 0xF8) == 0xE0) {
      uint16_t d_size = (((uint16_t)(decrypted[8] & 0x07)) << 8) | decrypted[9];
      uint16_t d_tag = ((uint16_t)decrypted[10] << 8) | decrypted[11];
      uint8_t d_offset = decrypted[12];
      size_t data_len = decrypted.size() >= 15 ? (decrypted.size() - 15) : 0; // Strip 13B header + 2B trailing Kermit CRC
      if (target_dev->frag_tag == d_tag && (millis() - target_dev->frag_start_ts < 30000)) {
        size_t byte_offset = 8 + ((size_t)d_offset * 8);
        if (target_dev->frag_buf.size() < byte_offset) {
          target_dev->frag_buf.resize(byte_offset, 0);
        }
        if (target_dev->frag_buf.size() < byte_offset + data_len) {
          target_dev->frag_buf.resize(byte_offset + data_len);
        }
        memcpy(target_dev->frag_buf.data() + byte_offset, decrypted.data() + 13, data_len);

        ESP_LOGI(TAG, "✓ [6LoWPAN FRAGN] %s: tag=0x%04X, offset=%u, chunk=%u, total=%u/%u",
                 target_dev->serial_no.c_str(), d_tag, d_offset, (unsigned int)data_len,
                 (unsigned int)(target_dev->frag_buf.size() - 8), target_dev->frag_total_len);
        if (target_dev->frag_buf.size() - 8 >= target_dev->frag_total_len) {
          target_dev->frag_buf.resize(8 + target_dev->frag_total_len);
          decrypted = target_dev->frag_buf;
          target_dev->frag_buf.clear();
          target_dev->frag_tag = 0;
          ESP_LOGI(TAG, "✓ Reassembled complete 6LoWPAN packet (%u bytes) for %s", (unsigned int)decrypted.size(), target_dev->serial_no.c_str());
        } else {
          xSemaphoreGiveRecursive(this->devices_mutex_);
          return;
        }
      } else {
        xSemaphoreGiveRecursive(this->devices_mutex_);
        return;
      }
    }

    // Handle ICMPv6 packets (Echo Reply 0x81, Echo Request 0x80, NS 0x87, NA 0x88, RA 0x86, RS 0x85).
    // Dispatch-aware scan: unicast plaintext has 8-byte prefix (MAC tail + proto + seq counter)
    // followed by a 6LoWPAN dispatch byte. 0x7E/0xF0 = UDP (CoAP), 0x7B/0x7A = ICMPv6 compressed.
    // Only scan for ICMPv6 types AFTER the dispatch byte to avoid false positives from the
    // sequence counter LSB (byte[4]) which cycles through 0x80-0x88 during normal operation.
    bool is_icmpv6 = false;
    uint8_t icmp_type = 0;
    size_t icmp_scan_start = 0;
    if (decrypted.size() >= 9 && decrypted[3] == 0x04 && decrypted[8] == 0x7E) {
      // Unicast CoAP frame (dispatch 0x7E = 6LoWPAN UDP) — NOT ICMPv6, skip scan entirely
      is_icmpv6 = false;
    } else if (decrypted.size() >= 9 && decrypted[3] == 0x04 &&
               (decrypted[8] == 0x7B || decrypted[8] == 0x7A)) {
      // Unicast ICMPv6 frame — scan from byte 9 onward (after dispatch + IPHC header)
      icmp_scan_start = 9;
      for (size_t i = icmp_scan_start; i < icmp_scan_start + 10 && i + 1 < decrypted.size(); i++) {
        uint8_t t = decrypted[i];
        if ((t == 0x80 || t == 0x81 || t == 0x85 || t == 0x86 || t == 0x87 || t == 0x88) && decrypted[i + 1] == 0x00) {
          is_icmpv6 = true;
          icmp_type = t;
          break;
        }
      }
    } else {
      // Broadcast frame or unknown structure — scan from byte 2 (skip 2-byte padding)
      icmp_scan_start = 2;
      for (size_t i = icmp_scan_start; i < 20 && i + 1 < decrypted.size(); i++) {
        uint8_t t = decrypted[i];
        if ((t == 0x80 || t == 0x81 || t == 0x85 || t == 0x86 || t == 0x87 || t == 0x88) && decrypted[i + 1] == 0x00) {
          is_icmpv6 = true;
          icmp_type = t;
          break;
        }
      }
    }

    if (is_icmpv6) {
      if (!target_dev->ib_mac_known) {
        memcpy(target_dev->ib_mac, src_mac, 8);
        target_dev->ib_mac_known = true;
      }

      if (icmp_type == 0x86) { // Router Advertisement (RA / RPL DIO beacon)
        if (target_dev->pairing_state == STATE_PAIR_BROADCAST_RS) {
          uint16_t dest_pan = buffer_data[3] | ((uint16_t)buffer_data[4] << 8);
          target_dev->ib_pan_id = (dest_pan == 0xFFFF) ? 0xABCD : dest_pan;
          target_dev->beacon_seq_ = buffer_data[2];
          target_dev->seq_num = buffer_data[2]; // Seed operational seq from RA frame
          target_dev->pairing_state = STATE_PAIR_UNICAST_RS;
          target_dev->pair_tx_count_ = 0;
          target_dev->last_pair_tx_time_ = 0;
          ESP_LOGI(TAG, "%s: Broadcast RA received. PAN=0x%04X, IB MAC=%02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X -> Starting Unicast Echo Request",
                   target_dev->serial_no.c_str(), target_dev->ib_pan_id,
                   target_dev->ib_mac[0], target_dev->ib_mac[1], target_dev->ib_mac[2], target_dev->ib_mac[3],
                   target_dev->ib_mac[4], target_dev->ib_mac[5], target_dev->ib_mac[6], target_dev->ib_mac[7]);
        } else {
          ESP_LOGI(TAG, "[RF Mesh RA] Router Advertisement (RA/DIO) beacon from Bridge %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X (Seq=%d, Plaintext=%dB)",
                   src_mac[0], src_mac[1], src_mac[2], src_mac[3], src_mac[4], src_mac[5], src_mac[6], src_mac[7], seq, (int)decrypted.size());
        }
      } else if (icmp_type == 0x85) { // Router Solicitation (RS / RPL DIS beacon)
        ESP_LOGI(TAG, "[RF Mesh RS] Router Solicitation (RS/DIS) from Peer %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X (Seq=%d, Plaintext=%dB)",
                 src_mac[0], src_mac[1], src_mac[2], src_mac[3], src_mac[4], src_mac[5], src_mac[6], src_mac[7], seq, (int)decrypted.size());
      } else if (icmp_type == 0x88) { // Neighbor Advertisement
        ESP_LOGI(TAG, "[RF Mesh NA] Neighbor Advertisement from %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X (Seq=%d)",
                 src_mac[0], src_mac[1], src_mac[2], src_mac[3], src_mac[4], src_mac[5], src_mac[6], src_mac[7], seq);
      } else if (icmp_type == 0x81) { // Echo Reply
        if (target_dev->pairing_state == STATE_PAIR_UNICAST_RS) {
          target_dev->pairing_state = STATE_PAIRING_TOKEN;
          target_dev->pair_tx_count_ = 0;
          target_dev->last_pair_tx_time_ = millis();
          ESP_LOGI(TAG, "%s: Echo Reply (0x81) received from IB. Transitioning to STATE_PAIRING_TOKEN — waiting for /d/pair...", target_dev->serial_no.c_str());
        } else {
          ESP_LOGD(TAG, "[RF ICMPv6] %s: Echo Reply (0x81) received from IB", target_dev->serial_no.c_str());
        }
      } else if (icmp_type == 0x87) { // Neighbor Solicitation
        target_dev->ib_pan_id = target_dev->get_ib_pan();
        if (target_dev->pairing_state == STATE_PAIR_BROADCAST_RS) {
          target_dev->pairing_state = STATE_PAIR_UNICAST_RS;
          target_dev->pair_tx_count_ = 0;
          target_dev->last_pair_tx_time_ = 0;
        } else if (target_dev->pairing_state == STATE_PAIR_UNICAST_RS || target_dev->pairing_state == STATE_PAIRING_TOKEN) {
          target_dev->pairing_state = STATE_PAIRED;
          target_dev->pair_tx_count_ = 0;
          target_dev->last_telemetry_ts = 0; // Triggers initial telemetry & time sync upon completing Neighbor Discovery
          this->save_to_nvs();
          ESP_LOGI(TAG, "✓ Neighbor Discovery complete for %s. Transitioning to STATE_PAIRED.", target_dev->serial_no.c_str());
        }
        ESP_LOGI(TAG, "[RF IPv6] %s: Neighbor Solicitation (0x87) received (PAN: 0x%04X). Sending Neighbor Advertisement...", target_dev->serial_no.c_str(), target_dev->ib_pan_id);
        this->send_neighbor_advertisement(target_dev, decrypted_key);
      } else if (icmp_type == 0x80) { // Echo Request
        ESP_LOGI(TAG, "[RF ICMPv6] %s: Echo Request (0x80) received from IB. Sending Echo Reply (0x81)...", target_dev->serial_no.c_str());
        this->send_echo_reply(target_dev, decrypted, decrypted_key);
      }

      xSemaphoreGiveRecursive(this->devices_mutex_);
      return; // Consumed as ICMPv6 frame — do not process as CoAP
    }

    // Direct search for TLV 0x12 (16 bytes key) or 0x07 (16 bytes enc key) anywhere in decrypted frame during pairing
    if (target_dev->pairing_state == STATE_PAIR_UNICAST_RS || target_dev->pairing_state == STATE_PAIR_BROADCAST_RS || !target_dev->has_op_key) {
      bool direct_key_found = false;
      uint8_t extracted_key[16]{0};
      for (size_t i = 3; i + 17 <= decrypted.size(); i++) {
        if (decrypted[i] == 0x12 && decrypted[i+1] == 0x10) {
          memcpy(extracted_key, &decrypted[i+2], 16);
          direct_key_found = true;
          ESP_LOGI(TAG, "[Direct Scan TLV 0x12] Found plaintext operational key at offset %u", (unsigned)i);
          break;
        } else if (decrypted[i] == 0x07 && decrypted[i+1] == 0x10) {
          if (target_dev->has_factory_key) {
            mbedtls_aes_context aes;
            mbedtls_aes_init(&aes);
            mbedtls_aes_setkey_dec(&aes, target_dev->factory_key, 128);
            mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_DECRYPT, &decrypted[i+2], extracted_key);
            mbedtls_aes_free(&aes);
            ESP_LOGI(TAG, "[Direct Scan TLV 0x07] Decrypted operational key using Factory Key at offset %u", (unsigned)i);
          } else {
            memcpy(extracted_key, &decrypted[i+2], 16);
          }
          direct_key_found = true;
          break;
        }
      }

      if (direct_key_found) {
        memcpy(target_dev->op_key, extracted_key, 16);
        target_dev->has_op_key = true;
        target_dev->pairing_state = STATE_PAIRING_TOKEN; // Wait for Bridge to initiate Neighbor Discovery
        this->save_to_nvs();
        ESP_LOGI(TAG, "✓ Extracted operational RF key from IB for %s. Awaiting Neighbor Discovery...", target_dev->serial_no.c_str());

        if (!target_dev->ib_mac_known) {
          memcpy(target_dev->ib_mac, src_mac, 8);
          uint16_t in_pan = buffer_data[3] | ((uint16_t)buffer_data[4] << 8);
          target_dev->ib_pan_id = (in_pan != 0xFFFF && in_pan != 0x0000) ? in_pan : 0xABCD;
          target_dev->ib_mac_known = true;
        }

        // Find incoming MID for ACK from CoAP header (0x40 0x02 <MID_H> <MID_L>)
        uint16_t found_mid = 0x4002;
        for (size_t s = 3; s + 4 <= decrypted.size(); s++) {
          if (decrypted[s] == 0x40 && (decrypted[s+1] == 0x02 || decrypted[s+1] == 0x01 || decrypted[s+1] == 0x03)) {
            found_mid = ((uint16_t)decrypted[s+2] << 8) | decrypted[s+3];
            break;
          }
        }
        ESP_LOGI(TAG, "[Pairing] Replying to Bridge /d/pair MID=0x%04X with 2.04 Changed ACK", found_mid);

        this->send_pair_ack_204(target_dev, found_mid);
        xSemaphoreGiveRecursive(this->devices_mutex_);
        return;
      }
    }

    // Deterministic 6LoWPAN / UDP Header decoding for CoAP offset:
    size_t coap_offset = 0;
    uint16_t incoming_src_port = 4005;
    if (decrypted.size() >= 12) {
      if (decrypted[8] == 0x7E) {
        if (decrypted[9] == 0x33 && (decrypted[10] & 0xF0) == 0xF0 && decrypted.size() >= 13) {
          incoming_src_port = ((uint16_t)decrypted[11] << 8) | decrypted[12];
        }
        if (decrypted[9] == 0x33 && decrypted[10] == 0xF0 && decrypted.size() >= 21) {
          coap_offset = 17; // 8B prefix + 1B 0x7E + 6B UDP NHC + 2B UDP Csum
        } else if (decrypted[9] == 0xF7 && decrypted[10] == 0x00 && decrypted[11] == 0xF0 && decrypted.size() >= 22) {
          coap_offset = 18;
        } else if (decrypted[9] == 0xF5 && decrypted[10] == 0x00 && decrypted.size() >= 30) {
          coap_offset = 26;
        }
      }
    }

    if (coap_offset == 0) {
      for (size_t s = 14; s + 4 <= decrypted.size(); s++) {
        uint8_t h = decrypted[s];
        uint8_t code = decrypted[s+1];
        if ((h & 0xC0) == 0x40 && (code <= 4 || (code >= 64 && code <= 160))) {
          coap_offset = s;
          break;
        }
      }
    }

    if (coap_offset == 0 || coap_offset + 4 > decrypted.size()) {
      ESP_LOGD(TAG, "[RF Non-CoAP] %s: No CoAP header detected", target_dev->serial_no.c_str());
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    uint8_t coap_code = decrypted[coap_offset + 1];
    uint16_t coap_mid = ((uint16_t)decrypted[coap_offset + 2] << 8) | decrypted[coap_offset + 3];

    uint32_t now_ms = millis();
    bool is_dup = (coap_mid == target_dev->last_rx_coap_mid && coap_code == target_dev->last_rx_coap_code && (now_ms - target_dev->last_rx_coap_ts < 30000));
    target_dev->last_rx_coap_mid = coap_mid;
    target_dev->last_rx_coap_code = coap_code;
    target_dev->last_rx_coap_ts = now_ms;

    if (is_dup) {
      ESP_LOGD(TAG, "[CoAP RX Dup] %s: Duplicate response MID=0x%04X, Code=%d (0x%02X)", target_dev->serial_no.c_str(), coap_mid, coap_code, coap_code);
    } else {
      ESP_LOGI(TAG, "[CoAP RX] %s: Code=%d (0x%02X), MID=0x%04X", target_dev->serial_no.c_str(), coap_code, coap_code, coap_mid);
    }

    uint8_t coap_tkl = decrypted[coap_offset] & 0x0F;
    std::vector<uint8_t> incoming_token;
    if (coap_tkl > 0 && coap_offset + 4 + coap_tkl <= decrypted.size()) {
      incoming_token.assign(decrypted.begin() + coap_offset + 4, decrypted.begin() + coap_offset + 4 + coap_tkl);
    }

    // Extract Session Token (Option 2048) if present in incoming CoAP options
    {
      size_t opt_idx = coap_offset + 4 + coap_tkl;
      uint16_t current_opt = 0;
      while (opt_idx < decrypted.size() && decrypted[opt_idx] != 0xFF) {
        uint8_t opt_hdr = decrypted[opt_idx++];
        uint16_t opt_delta = (opt_hdr >> 4) & 0x0F;
        uint16_t opt_len = opt_hdr & 0x0F;
        if (opt_delta == 13 && opt_idx < decrypted.size()) {
          opt_delta = 13 + decrypted[opt_idx++];
        } else if (opt_delta == 14 && opt_idx + 1 < decrypted.size()) {
          opt_delta = 269 + (((uint16_t)decrypted[opt_idx] << 8) | decrypted[opt_idx + 1]);
          opt_idx += 2;
        }
        if (opt_len == 13 && opt_idx < decrypted.size()) {
          opt_len = 13 + decrypted[opt_idx++];
        } else if (opt_len == 14 && opt_idx + 1 < decrypted.size()) {
          opt_len = 269 + (((uint16_t)decrypted[opt_idx] << 8) | decrypted[opt_idx + 1]);
          opt_idx += 2;
        }
        current_opt += opt_delta;
        if (current_opt == 2048 && opt_len == 8 && opt_idx + 8 <= decrypted.size()) {
          bool token_changed = !target_dev->has_session_token || (memcmp(target_dev->session_token, &decrypted[opt_idx], 8) != 0);
          memcpy(target_dev->session_token, &decrypted[opt_idx], 8);
          target_dev->has_session_token = true;
          if (token_changed) {
            ESP_LOGI(TAG, "✓ Extracted active Session Token (Option 2048) for %s: %02X%02X%02X%02X%02X%02X%02X%02X",
                     target_dev->serial_no.c_str(),
                     target_dev->session_token[0], target_dev->session_token[1], target_dev->session_token[2], target_dev->session_token[3],
                     target_dev->session_token[4], target_dev->session_token[5], target_dev->session_token[6], target_dev->session_token[7]);
          }
        }
        opt_idx += opt_len;
      }
    }

    // Clear matching pending request (ACK / response received)
    for (auto it = target_dev->pending_requests.begin(); it != target_dev->pending_requests.end(); ++it) {
      if (it->mid == coap_mid) {
        target_dev->pending_requests.erase(it);
        break;
      }
    }

    // Handle startup sequence strict ACK gating:
    if (coap_mid == 0x9000 && (coap_code == 68 || coap_code == 65 || coap_code == 69)) {
      if (target_dev->startup_stage == 2 && !target_dev->stage_ack_received) {
        target_dev->stage_ack_received = true;
        target_dev->last_startup_step_ms = millis();
        // Clear all earlier handshake requests from pending_requests
        for (auto it = target_dev->pending_requests.begin(); it != target_dev->pending_requests.end(); ) {
          if (it->mid == 0x9000) it = target_dev->pending_requests.erase(it);
          else ++it;
        }
        ESP_LOGI(TAG, "✓ %s: Stage 2 (GET d/config) confirmed. Will advance to Stage 3 in 1000ms...", target_dev->serial_no.c_str());
      }
    } else if (coap_mid == 0x9001 && (coap_code == 68 || coap_code == 65 || coap_code == 69)) {
      if (target_dev->startup_stage == 3 && !target_dev->stage_ack_received) {
        target_dev->stage_ack_received = true;
        target_dev->last_startup_step_ms = millis();
        // Clear all earlier handshake requests (0x9000 and 0x9001)
        for (auto it = target_dev->pending_requests.begin(); it != target_dev->pending_requests.end(); ) {
          if (it->mid == 0x9000 || it->mid == 0x9001) it = target_dev->pending_requests.erase(it);
          else ++it;
        }
        ESP_LOGI(TAG, "✓ %s: Stage 3 (PUT d/sen) confirmed. Will advance to Stage 4 in 1000ms...", target_dev->serial_no.c_str());
      }
    } else if (coap_mid == 0x9002 && (coap_code == 68 || coap_code == 65 || coap_code == 69)) {
      if (target_dev->startup_stage == 4 && !target_dev->stage_ack_received) {
        target_dev->stage_ack_received = true;
        target_dev->last_startup_step_ms = millis();
        // Clear all earlier handshake requests (0x9000..0x9002)
        for (auto it = target_dev->pending_requests.begin(); it != target_dev->pending_requests.end(); ) {
          if (it->mid >= 0x9000 && it->mid <= 0x9002) it = target_dev->pending_requests.erase(it);
          else ++it;
        }
        ESP_LOGI(TAG, "✓ %s: Stage 4 (PUT d/err) confirmed. Will advance to Stage 5 in 1000ms...", target_dev->serial_no.c_str());
      }
    } else if (coap_mid == 0x9003 && (coap_code == 69 || coap_code == 68 || coap_code == 65)) {
      uint32_t server_unix_time = 0;
      size_t p_time = coap_offset + 4 + coap_tkl;
      while (p_time < decrypted.size() && decrypted[p_time] != 0xFF) p_time++;
      if (p_time < decrypted.size() && decrypted[p_time] == 0xFF) {
        size_t payload_len = decrypted.size() - (p_time + 1);
        const uint8_t *pl = decrypted.data() + p_time + 1;

        // Try raw 4-byte Little-Endian or Big-Endian Unix epoch
        if (payload_len >= 4) {
          uint32_t t_le = pl[0] | ((uint32_t)pl[1] << 8) | ((uint32_t)pl[2] << 16) | ((uint32_t)pl[3] << 24);
          uint32_t t_be = ((uint32_t)pl[0] << 24) | ((uint32_t)pl[1] << 16) | ((uint32_t)pl[2] << 8) | pl[3];
          if (t_le >= 1600000000UL && t_le <= 2200000000UL) {
            server_unix_time = t_le;
          } else if (t_be >= 1600000000UL && t_be <= 2200000000UL) {
            server_unix_time = t_be;
          }
        }

        // Try TLV payload with offset search for valid Unix timestamp
        if (server_unix_time == 0 && payload_len >= 5) {
          for (size_t i = 0; i + 4 <= payload_len; i++) {
            uint32_t t_le = pl[i] | ((uint32_t)pl[i+1] << 8) | ((uint32_t)pl[i+2] << 16) | ((uint32_t)pl[i+3] << 24);
            uint32_t t_be = ((uint32_t)pl[i] << 24) | ((uint32_t)pl[i+1] << 16) | ((uint32_t)pl[i+2] << 8) | pl[i+3];
            if (t_le >= 1600000000UL && t_le <= 2200000000UL) {
              server_unix_time = t_le;
              break;
            } else if (t_be >= 1600000000UL && t_be <= 2200000000UL) {
              server_unix_time = t_be;
              break;
            }
          }
        }
      }

      if (target_dev->startup_stage < 6) {
        target_dev->startup_stage = 6; // Complete
        target_dev->stage_ack_received = false;
        target_dev->last_startup_step_ms = millis();
        uint32_t now_sec = (uint32_t)(esp_timer_get_time() / 1000000ULL);
        target_dev->last_telemetry_ts = now_sec;
        target_dev->last_config_check_ts = now_sec;
        target_dev->last_token_refresh_ts = now_sec;
        target_dev->last_link_probe_ts = now_sec;
        target_dev->last_time_sync_ts = now_sec;
        target_dev->server_time_s = server_unix_time;
        // Clear all handshake requests (0x9000..0x9003)
        for (auto it = target_dev->pending_requests.begin(); it != target_dev->pending_requests.end(); ) {
          if (it->mid >= 0x9000 && it->mid <= 0x9003) it = target_dev->pending_requests.erase(it);
          else ++it;
        }
        if (server_unix_time > 0) {
          ESP_LOGI(TAG, "✓ %s: Stage 5 (GET time) complete. Synced server Unix time = %u. Startup handshake verified and complete.",
                   target_dev->serial_no.c_str(), (unsigned int)server_unix_time);
        } else {
          ESP_LOGI(TAG, "✓ %s: Stage 5 (GET time) complete. Startup handshake verified and complete.", target_dev->serial_no.c_str());
        }
      }
    }

    // Handle Inbound POST /auth/token from Bridge (Session Token Negotiation)
    std::string dec_str_all(decrypted.begin(), decrypted.end());
    if (coap_code == 2 && (dec_str_all.find("token") != std::string::npos || dec_str_all.find("auth") != std::string::npos)) {
      ESP_LOGI(TAG, "✓ Received POST /auth/token (MID=0x%04X) from Bridge for %s", coap_mid, target_dev->serial_no.c_str());
      size_t payload_start_tok = 0;
      for (size_t s = coap_offset + 4; s < decrypted.size(); s++) {
        if (decrypted[s] == 0xFF) { payload_start_tok = s + 1; break; }
      }
      if (payload_start_tok > 0) {
        for (size_t i = payload_start_tok; i + 10 < decrypted.size(); i++) {
          uint16_t fid = ((uint16_t)decrypted[i] << 8) | decrypted[i+1];
          uint8_t flen = decrypted[i+2];
          if ((fid == 0x0007 || fid == 0x025E) && flen >= 8) {
            bool token_changed = !target_dev->has_session_token || (memcmp(target_dev->session_token, &decrypted[i+3], 8) != 0);
            memcpy(target_dev->session_token, &decrypted[i+3], 8);
            target_dev->has_session_token = true;
            if (token_changed) {
              ESP_LOGI(TAG, "✓ Extracted session token for %s", target_dev->serial_no.c_str());
            }
            break;
          }
          if (i + 3 + flen <= decrypted.size()) i += 2 + flen;
        }
      }
      const uint8_t *key_to_use = target_dev->has_op_key ? target_dev->op_key : pairing_key;
      this->send_coap_ack(target_dev, coap_mid, 68 /* 2.04 Changed */, key_to_use, src_mac, {}, false, incoming_token, incoming_src_port);

      // If waiting in Stage 1, advance to Stage 2 immediately upon receiving token:
      if (target_dev->startup_stage == 1) {
        target_dev->startup_stage = 2;
        target_dev->last_startup_step_ms = millis();
        ESP_LOGI(TAG, "✓ %s: Auth token negotiated. Advancing to Stage 2 (PUT d/config)...", target_dev->serial_no.c_str());
        this->send_device_config_put(target_dev);
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    // Handle Pairing & Key Provisioning:
    // Supports native IB POST /d/pair (TLVs 0x12/0x07) and CoAP responses (FIDs 0x0262/0x0155)
    std::string dec_str_pair(decrypted.begin(), decrypted.end());
    if (coap_code == 2 && dec_str_pair.find("pair") != std::string::npos && target_dev->has_op_key) {
      ESP_LOGI(TAG, "[Pairing] IB retransmitted /d/pair MID=0x%04X for %s — re-sending 2.04 Changed ACK", coap_mid, target_dev->serial_no.c_str());
      this->send_pair_ack_204(target_dev, coap_mid, src_mac, incoming_token, incoming_src_port);
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    if ((target_dev->pairing_state == STATE_PAIR_UNICAST_RS || target_dev->pairing_state == STATE_PAIR_BROADCAST_RS || target_dev->pairing_state == STATE_PAIRING_TOKEN || !target_dev->has_op_key) &&
        (coap_code == 2 /* POST */ || coap_code == 69 || coap_code == 67 || coap_code == 65 || coap_code == 68)) {
      bool key_found = false;
      uint8_t extracted_key[16]{0};

      // 1. Scan for native 1-byte TLVs: 0x12 (plaintext key) or 0x07 (encrypted key) with length 16 (0x10)
      for (size_t i = coap_offset; i + 17 < decrypted.size(); i++) {
        if (decrypted[i] == 0x12 && decrypted[i+1] == 0x10) {
          memcpy(extracted_key, &decrypted[i+2], 16);
          key_found = true;
          ESP_LOGI(TAG, "[Pairing TLV 0x12] Found plaintext operational key in /d/pair payload");
          break;
        } else if (decrypted[i] == 0x07 && decrypted[i+1] == 0x10) {
          if (target_dev->has_factory_key) {
            mbedtls_aes_context aes;
            mbedtls_aes_init(&aes);
            mbedtls_aes_setkey_dec(&aes, target_dev->factory_key, 128);
            mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_DECRYPT, &decrypted[i+2], extracted_key);
            mbedtls_aes_free(&aes);
            ESP_LOGI(TAG, "[Pairing TLV 0x07] Decrypted operational key using device Factory Key");
          } else {
            memcpy(extracted_key, &decrypted[i+2], 16);
            ESP_LOGI(TAG, "[Pairing TLV 0x07] Extracted raw operational key payload");
          }
          key_found = true;
          break;
        }
      }

      // 2. Scan for standard 2-byte TLVs: FID 0x0262 (server key) or FID 0x0155 (rf_key) with length 16
      if (!key_found) {
        size_t payload_start_key = 0;
        for (size_t s = coap_offset + 4; s < decrypted.size(); s++) {
          if (decrypted[s] == 0xFF) { payload_start_key = s + 1; break; }
        }
        if (payload_start_key == 0) payload_start_key = coap_offset + 4;
        for (size_t i = payload_start_key; i + 18 < decrypted.size(); i++) {
          uint16_t fid = ((uint16_t)decrypted[i] << 8) | decrypted[i+1];
          uint8_t flen = decrypted[i+2];
          if ((fid == 0x0262 || fid == 0x0155) && flen == 16) {
            memcpy(extracted_key, &decrypted[i+3], 16);
            key_found = true;
            ESP_LOGI(TAG, "[Pairing FID 0x%04X] Found operational key in CoAP payload", fid);
            break;
          }
          if (i + 3 + flen <= decrypted.size()) i += 2 + flen;
        }
      }

      if (key_found) {
        if (target_dev->has_op_key && memcmp(target_dev->op_key, extracted_key, 16) == 0 && target_dev->pairing_state != STATE_PAIR_UNICAST_RS && target_dev->pairing_state != STATE_PAIR_BROADCAST_RS) {
          // IB retransmitted /d/pair (e.g. didn't hear our 2.04 ACK yet)
          ESP_LOGI(TAG, "[Pairing] IB retransmitted /d/pair for %s — re-sending 2.04 Changed ACK", target_dev->serial_no.c_str());
          this->send_pair_ack_204(target_dev, coap_mid, src_mac, incoming_token, incoming_src_port);
          xSemaphoreGiveRecursive(this->devices_mutex_);
          return;
        }

        memcpy(target_dev->op_key, extracted_key, 16);
        target_dev->has_op_key = true;
        target_dev->pairing_state = STATE_PAIRED;
        target_dev->last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);
        this->save_to_nvs();
        ESP_LOGI(TAG, "✓ Extracted operational RF key from IB for %s", target_dev->serial_no.c_str());

        if (!target_dev->ib_mac_known) {
          target_dev->ib_mac[0] = buffer_data[11];
          target_dev->ib_mac[1] = buffer_data[12];
          target_dev->ib_mac[2] = buffer_data[13];
          target_dev->ib_mac[3] = buffer_data[14];
          target_dev->ib_mac[4] = buffer_data[15];
          target_dev->ib_mac[5] = decrypted[0];
          target_dev->ib_mac[6] = decrypted[1];
          target_dev->ib_mac[7] = decrypted[2];
          uint16_t in_pan = buffer_data[3] | ((uint16_t)buffer_data[4] << 8);
          target_dev->ib_pan_id = (in_pan != 0xFFFF && in_pan != 0x0000) ? in_pan : 0xABCD;
          target_dev->ib_mac_known = true;
        }

        // Send 2.04 Changed ACK over RF under Operational Key to complete IB pairing registration
        this->send_pair_ack_204(target_dev, coap_mid, src_mac, incoming_token, incoming_src_port);
        xSemaphoreGiveRecursive(this->devices_mutex_);
        return;
      }
    }

    // Handle Pairing Step 2 / Token Refresh response (auth/token -> session token)
    // ws-server responds with FID 0x025E (session token, 8 bytes)
    if ((target_dev->pairing_state == STATE_PAIRING_TOKEN || target_dev->token_refresh_pending) && coap_code == 69) {
      size_t payload_start_tok = 0;
      for (size_t s = coap_offset + 4; s < decrypted.size(); s++) {
        if (decrypted[s] == 0xFF) { payload_start_tok = s + 1; break; }
      }
      if (payload_start_tok == 0) payload_start_tok = coap_offset + 4;
      for (size_t i = payload_start_tok; i + 10 < decrypted.size(); i++) {
        uint16_t fid = ((uint16_t)decrypted[i] << 8) | decrypted[i+1];
        uint8_t flen = decrypted[i+2];
        if (fid == 0x025E && flen == 8) {
          memcpy(target_dev->session_token, &decrypted[i+3], 8);
          target_dev->has_session_token = true;
          if (target_dev->token_refresh_pending) {
            target_dev->token_refresh_pending = false;
            ESP_LOGI(TAG, "✓ Session token (FID 0x025E) refreshed for %s", target_dev->serial_no.c_str());
          } else {
            target_dev->pairing_state = STATE_PAIRED;
            ESP_LOGI(TAG, "✓ Paired %s. Executing onboarding sequence...", target_dev->serial_no.c_str());
            this->send_fw_state_put(target_dev);
            this->send_config_get(target_dev);
            this->send_actuator_put(target_dev);
            this->send_error_flags_put(target_dev);
            this->send_telemetry_put(target_dev, target_dev->target_temp_celsius, target_dev->target_humidity_pct, target_dev->target_battery_mv);
          }
          this->save_to_nvs();
          xSemaphoreGiveRecursive(this->devices_mutex_);
          return;
        }
        if (i + 3 + flen <= decrypted.size()) i += 2 + flen; // Skip to next TLV
      }
    }

    // Handle incoming CoAP requests from IB or peer nodes
    // CoAP Codes: 1=GET, 3=PUT, 68=2.04 Changed, 69=2.05 Content
    if (coap_code == 1 || coap_code == 3 || coap_code == 69 || coap_code == 68) {
      size_t payload_start = 0;
      size_t opt_walker = coap_offset + 4 + coap_tkl;
      uint16_t current_opt = 0;
      std::string incoming_uri_path = "";

      while (opt_walker < decrypted.size()) {
        if (decrypted[opt_walker] == 0xFF) {
          payload_start = opt_walker + 1;
          break;
        }
        uint8_t opt_hdr = decrypted[opt_walker++];
        uint16_t opt_delta = (opt_hdr >> 4) & 0x0F;
        uint16_t opt_len = opt_hdr & 0x0F;
        if (opt_delta == 13 && opt_walker < decrypted.size()) {
          opt_delta = 13 + decrypted[opt_walker++];
        } else if (opt_delta == 14 && opt_walker + 1 < decrypted.size()) {
          opt_delta = 269 + (((uint16_t)decrypted[opt_walker] << 8) | decrypted[opt_walker + 1]);
          opt_walker += 2;
        }
        if (opt_len == 13 && opt_walker < decrypted.size()) {
          opt_len = 13 + decrypted[opt_walker++];
        } else if (opt_len == 14 && opt_walker + 1 < decrypted.size()) {
          opt_len = 269 + (((uint16_t)decrypted[opt_walker] << 8) | decrypted[opt_walker + 1]);
          opt_walker += 2;
        }
        current_opt += opt_delta;
        if (current_opt == 11 && opt_walker + opt_len <= decrypted.size()) { // Option 11: Uri-Path
          std::string segment((const char*)&decrypted[opt_walker], opt_len);
          if (!incoming_uri_path.empty()) incoming_uri_path += "/";
          incoming_uri_path += segment;
        }
        opt_walker += opt_len;
      }

      if (!incoming_uri_path.empty()) {
        ESP_LOGI(TAG, "[CoAP RX Path] %s: Code=%d (0x%02X), MID=0x%04X, Path=\"%s\"",
                 target_dev->serial_no.c_str(), coap_code, coap_code, coap_mid, incoming_uri_path.c_str());
      }

      // 1. Inbound GET requests from IB (e.g. GET /d/info or GET d/{serial}/sen)
      if (coap_code == 1) { // GET
        bool is_pairing_frame = (decrypted.size() > 8 && decrypted[8] == 0x7E);
        std::string dec_str(decrypted.begin(), decrypted.end());

        std::vector<uint8_t> resp_payload;
        if (incoming_uri_path.find("info") != std::string::npos || incoming_uri_path.find("fw") != std::string::npos || dec_str.find("info") != std::string::npos || dec_str.find("fw") != std::string::npos) {
          resp_payload = build_d_fw_state_payload(target_dev);
          ESP_LOGI(TAG, "✓ Inbound GET /d/info answered with 2.05 Content (%u bytes) for %s",
                   (unsigned int)resp_payload.size(), target_dev->serial_no.c_str());
        } else {
          resp_payload = build_d_sen_payload(target_dev->target_temp_celsius, target_dev->target_humidity_pct,
                                             target_dev->target_battery_mv, target_dev->target_ambient_light,
                                             target_dev->reset_counter);
          ESP_LOGI(TAG, "✓ Inbound GET poll answered with 2.05 Content (%u bytes) for %s",
                   (unsigned int)resp_payload.size(), target_dev->serial_no.c_str());
        }

        const uint8_t *key_to_use = decrypted_key;
        this->send_coap_ack(target_dev, coap_mid, 69 /* 2.05 Content */, key_to_use, src_mac, resp_payload, is_pairing_frame, incoming_token, incoming_src_port);
        xSemaphoreGiveRecursive(this->devices_mutex_);
        return;
      }

      // Check if inbound URI indicates a Zone Configuration push (e.g. "h/<home>/z/6/config" or "z/6/config")
      if (incoming_uri_path.find("/z/") != std::string::npos || incoming_uri_path.rfind("z/", 0) == 0) {
        size_t z_pos = incoming_uri_path.find("/z/");
        if (z_pos == std::string::npos && incoming_uri_path.rfind("z/", 0) == 0) z_pos = 0;
        else if (z_pos != std::string::npos) z_pos += 3;
        if (z_pos < incoming_uri_path.length()) {
          int parsed_zid = atoi(&incoming_uri_path[z_pos]);
          if (parsed_zid > 0 && parsed_zid < 255 && parsed_zid != target_dev->zone_id) {
            target_dev->zone_id = (uint8_t)parsed_zid;
            ESP_LOGI(TAG, "✓ %s: Inbound Zone Config Path updated assigned Zone ID to %u", target_dev->serial_no.c_str(), (unsigned int)target_dev->zone_id);
            this->save_to_nvs();
          }
        }
      }

      // 2. Parse TLVs from incoming payload (PUT config, PUT z/p, 2.05 Content, 2.04 Changed)
      if (payload_start > 0) {
        bool peers_changed = false;
        bool zone_temp_updated = false;
        size_t p = payload_start;
        size_t max_p = decrypted.size();

        while (p + 3 <= max_p) {
          uint16_t fid = ((uint16_t)decrypted[p] << 8) | decrypted[p+1];
          uint8_t flen = decrypted[p+2];
          if (p + 3 + flen > max_p) break;

          if (fid == 0x015e && flen >= 2) {
            uint8_t role = decrypted[p+3];
            uint8_t zid = decrypted[p+4];
            // Role codes:
            // 0x0B = RU Leader & Controller (Measuring Leader)
            // 0x0D = Device is Measuring Leader (Bridge/HW/VA)
            // 0x09 = Wireless Temperature Sensor (Measuring Leader)
            // 0x03 = RU Member/Follower in zone (another device is measuring leader)
            // 0x05 = VA in zone
            // 0x02 = Remote zone
            if (role != 0x02 && zid != 0) {
              bool changed = (target_dev->zone_id != zid || target_dev->zone_role != role);
              target_dev->zone_id = zid;
              target_dev->zone_role = role;
              target_dev->is_measuring_leader = (role == 0x0B || role == 0x0D || role == 0x09);
              if (changed) {
                target_dev->zone_peer_ipv6s.clear();
                target_dev->zone_peer_macs.clear();
                peers_changed = true;
                ESP_LOGI(TAG, "✓ %s: Assigned to Zone %u (Role 0x%02X: %s)",
                         target_dev->serial_no.c_str(), (unsigned int)zid, (unsigned int)role,
                         target_dev->is_measuring_leader ? "Measuring Leader" : "Zone Member/Follower");
              }
            }
          } else if (fid == 0x0158) {
            uint16_t val = (flen >= 2) ? (((uint16_t)decrypted[p+3] << 8) | decrypted[p+4]) : decrypted[p+3];
            ESP_LOGD(TAG, "%s: UI flags (0x0158) = 0x%04X", target_dev->serial_no.c_str(), val);
          } else if ((fid == 0x8400 || fid == 0x8200 || fid == 0x8000 || fid == 0x63a0 || fid == 0x6040 || fid == 0x01D4 || fid == 0x01D5) && flen > 0) {
            // Zone peer URI (e.g. coap://[fe80::21b:c500:0000:0001]/z/p)
            std::string uri((const char*)&decrypted[p+3], flen);
            bool is_clean_ascii = true;
            for (char c : uri) {
              if (c < 32 || c > 126) { is_clean_ascii = false; break; }
            }
            if (is_clean_ascii && uri.length() > 10 && (uri.find("coap://[fe80:") != std::string::npos || uri.find("fe80::") != std::string::npos)) {
              bool known = false;
              for (const auto &existing : target_dev->zone_peer_ipv6s) {
                if (existing == uri) { known = true; break; }
              }
              if (!known) {
                target_dev->zone_peer_ipv6s.push_back(uri);
                std::vector<uint8_t> peer_mac(8, 0);
                this->derive_mac_from_ipv6(uri, peer_mac.data());
                target_dev->zone_peer_macs.push_back(peer_mac);
                peers_changed = true;
                ESP_LOGI(TAG, "✓ %s: Discovered zone peer: %s", target_dev->serial_no.c_str(), uri.c_str());
              }
            }
          } else if (fid == 0x4060 && flen >= 2) {
            // Inbound Zone Target Temperature PUT from Zone Leader / App
            int16_t raw_temp = ((int16_t)decrypted[p+3] << 8) | decrypted[p+4];
            target_dev->target_temp_celsius = raw_temp / 100.0f;
            zone_temp_updated = true;
            ESP_LOGI(TAG, "✓ Received zone target temperature update: %.2f°C for %s", target_dev->target_temp_celsius, target_dev->serial_no.c_str());
          } else if (fid == 0x012D && flen >= 2 && !target_dev->is_measuring_leader) {
            int16_t raw_temp = ((int16_t)decrypted[p+3] << 8) | decrypted[p+4];
            ESP_LOGI(TAG, "✓ Received zone measured temp from leader: %.2f°C for %s", raw_temp / 100.0f, target_dev->serial_no.c_str());
          }
          p += 3 + flen;
        }

        if (peers_changed || zone_temp_updated) {
          this->save_to_nvs();
          if (peers_changed) {
            ESP_LOGI(TAG, "✓ %s: Zone %u Peer List (%u total):",
                     target_dev->serial_no.c_str(), (unsigned int)target_dev->zone_id, (unsigned int)target_dev->zone_peer_ipv6s.size());
            for (const auto &p_uri : target_dev->zone_peer_ipv6s) {
              ESP_LOGI(TAG, "    └─ Peer: %s", p_uri.c_str());
            }
          }
        }
      }

      // Send 2.04 Changed ACK for all incoming PUT requests (with or without payload)
      if (coap_code == 3) {
        const uint8_t *key_to_use = decrypted_key;
        this->send_coap_ack(target_dev, coap_mid, 68 /* 2.04 Changed */, key_to_use, src_mac, {}, false, incoming_token, incoming_src_port);
      }
    }
    xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  uint8_t read_reg(uint8_t addr) {
    this->enable();
    this->write_byte(addr & 0x7F);
    uint8_t val = this->read_byte();
    this->disable();
    return val;
  }

  void write_reg(uint8_t addr, uint8_t val) {
    this->enable();
    this->write_byte(addr | 0x80);
    this->write_byte(val);
    this->disable();
  }

  // -------------------------------------------------------------------------
  // NVRAM Management & REST Status Helpers
  // -------------------------------------------------------------------------

  EmulatedDevice *find_device(const std::string &serial_no) {
    for (auto &dev : this->devices_) {
      if (dev.serial_no == serial_no) return &dev;
    }
    return nullptr;
  }

  void load_from_nvs() {
    if (this->devices_mutex_ != nullptr) xSemaphoreTakeRecursive(this->devices_mutex_, portMAX_DELAY);
    this->devices_.clear();
    
    nvs_handle_t handle;
    esp_err_t err = nvs_open("tado_emul", NVS_READWRITE, &handle);
    if (err == ESP_OK) {
      uint32_t count = 0;
      nvs_get_u32(handle, "count", &count);
      ESP_LOGI(TAG, "Loading %u emulated RU devices from NVRAM...", (unsigned int)count);

      for (uint32_t i = 0; i < count; i++) {
        char key[16];
        snprintf(key, sizeof(key), "dev_%u", (unsigned int)i);
        size_t required_size = 0;
        if (nvs_get_str(handle, key, nullptr, &required_size) == ESP_OK && required_size > 0) {
          std::vector<char> buf(required_size);
          nvs_get_str(handle, key, buf.data(), &required_size);

          std::string line(buf.data());
          std::vector<std::string> tokens;
          size_t p_idx = 0;
          while (p_idx <= line.length()) {
            size_t comma = line.find(',', p_idx);
            if (comma == std::string::npos) {
              tokens.push_back(line.substr(p_idx));
              break;
            } else {
              tokens.push_back(line.substr(p_idx, comma - p_idx));
              p_idx = comma + 1;
            }
          }

          if (tokens.size() >= 6) {
            EmulatedDevice dev;
            dev.serial_no = tokens[0];
            if (!tokens[1].empty() && tokens[1] != "-") dev.ipv6_address = tokens[1];
            if (tokens[2].length() == 32 && tokens[2] != "-") {
              dev.has_op_key = true;
              this->hex_to_bytes(tokens[2].c_str(), dev.op_key, 16);
            }
            if (tokens[3].length() == 16 && tokens[3] != "-") {
              dev.has_session_token = true;
              this->hex_to_bytes(tokens[3].c_str(), dev.session_token, 8);
            }
            dev.home_id = (uint32_t)strtoul(tokens[4].c_str(), nullptr, 10);
            dev.zone_id = (uint32_t)strtoul(tokens[5].c_str(), nullptr, 10);
            if (tokens.size() >= 7) {
              dev.pairing_state = static_cast<PairingState>(strtoul(tokens[6].c_str(), nullptr, 10));
            }

            char fact_key[20];
            snprintf(fact_key, sizeof(fact_key), "fact_%u", (unsigned int)i);
            size_t f_size = 0;
            if (nvs_get_str(handle, fact_key, nullptr, &f_size) == ESP_OK && f_size == 33) {
              std::vector<char> f_buf(f_size);
              nvs_get_str(handle, fact_key, f_buf.data(), &f_size);
              dev.has_factory_key = true;
              this->hex_to_bytes(f_buf.data(), dev.factory_key, 16);
            }

            if (!dev.ipv6_address.empty()) {
              this->derive_mac_from_ipv6(dev.ipv6_address, dev.mac_addr);
            } else {
              this->derive_mac_from_serial(dev.serial_no, dev.mac_addr);
            }
            dev.derive_short_addr();

            // Load persisted zone peer IPv6s
            char peers_key[20];
            snprintf(peers_key, sizeof(peers_key), "peers_%u", (unsigned int)i);
            size_t p_size = 0;
            if (nvs_get_str(handle, peers_key, nullptr, &p_size) == ESP_OK && p_size > 0) {
              std::vector<char> p_buf(p_size);
              nvs_get_str(handle, peers_key, p_buf.data(), &p_size);
              std::string peers_str(p_buf.data());
              size_t p_start = 0;
              while (p_start < peers_str.length()) {
                size_t comma = peers_str.find(';', p_start);
                std::string ip = (comma == std::string::npos) ? peers_str.substr(p_start) : peers_str.substr(p_start, comma - p_start);
                if (!ip.empty()) {
                  dev.zone_peer_ipv6s.push_back(ip);
                  std::vector<uint8_t> p_mac(8, 0xFF);
                  this->derive_mac_from_ipv6(ip, p_mac.data());
                  dev.zone_peer_macs.push_back(p_mac);
                }
                if (comma == std::string::npos) break;
                p_start = comma + 1;
              }
            }

            // Load persisted IB MAC & PAN
            char ib_key[20];
            snprintf(ib_key, sizeof(ib_key), "ib_%u", (unsigned int)i);
            size_t ib_size = 0;
            if (nvs_get_str(handle, ib_key, nullptr, &ib_size) == ESP_OK && ib_size > 0) {
              std::vector<char> ib_buf(ib_size);
              nvs_get_str(handle, ib_key, ib_buf.data(), &ib_size);
              char ib_hex[20]{0};
              unsigned int pan_val = 0xFFFF;
              if (sscanf(ib_buf.data(), "%[^,],%u", ib_hex, &pan_val) >= 1) {
                if (strlen(ib_hex) == 16) {
                  dev.ib_mac_known = true;
                  this->hex_to_bytes(ib_hex, dev.ib_mac, 8);
                  dev.ib_pan_id = (uint16_t)pan_val;
                }
              }
            }

            dev.last_telemetry_ts = 0; // Triggers immediate initial telemetry & time sync upon boot
            dev.last_config_check_ts = 0;
            dev.last_token_refresh_ts = 0;
            dev.last_time_sync_ts = 0;

            ESP_LOGI(TAG, "✓ %s loaded from NVS: Zone=%u, Role=0x%02X (%s), Peers=%u",
                     dev.serial_no.c_str(), (unsigned int)dev.zone_id, (unsigned int)dev.zone_role,
                     dev.is_measuring_leader ? "Measuring Leader" : "Zone Member",
                     (unsigned int)dev.zone_peer_ipv6s.size());
            for (const auto &p_uri : dev.zone_peer_ipv6s) {
              ESP_LOGI(TAG, "    └─ Peer: %s", p_uri.c_str());
            }

            this->devices_.push_back(dev);
          }
        }
      }
      nvs_close(handle);
    }
    if (this->devices_mutex_ != nullptr) xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  void save_to_nvs() {
    if (this->devices_mutex_ != nullptr) xSemaphoreTakeRecursive(this->devices_mutex_, portMAX_DELAY);
    nvs_handle_t handle;
    if (nvs_open("tado_emul", NVS_READWRITE, &handle) == ESP_OK) {
      nvs_set_u32(handle, "count", (uint32_t)this->devices_.size());
      for (size_t i = 0; i < this->devices_.size(); i++) {
        char key[16];
        snprintf(key, sizeof(key), "dev_%u", (unsigned int)i);
        char op_hex[33]{0}, tok_hex[17]{0};
        this->bytes_to_hex(this->devices_[i].op_key, 16, op_hex);
        this->bytes_to_hex(this->devices_[i].session_token, 8, tok_hex);

        std::string ip_field = this->devices_[i].ipv6_address.empty() ? "-" : this->devices_[i].ipv6_address;
        std::string op_field = this->devices_[i].has_op_key ? op_hex : "-";
        std::string tok_field = this->devices_[i].has_session_token ? tok_hex : "-";

        char val[256];
        snprintf(val, sizeof(val), "%s,%s,%s,%s,%u,%u,%u",
                 this->devices_[i].serial_no.c_str(),
                 ip_field.c_str(),
                 op_field.c_str(),
                 tok_field.c_str(),
                 (unsigned int)this->devices_[i].home_id,
                 (unsigned int)this->devices_[i].zone_id,
                 (unsigned int)this->devices_[i].pairing_state);
        nvs_set_str(handle, key, val);

        // Save factory key
        char fact_key[20];
        snprintf(fact_key, sizeof(fact_key), "fact_%u", (unsigned int)i);
        if (this->devices_[i].has_factory_key) {
          char fact_hex[33]{0};
          this->bytes_to_hex(this->devices_[i].factory_key, 16, fact_hex);
          nvs_set_str(handle, fact_key, fact_hex);
        }

        // Save IB MAC & PAN ID
        char ib_k[20];
        snprintf(ib_k, sizeof(ib_k), "ib_%u", (unsigned int)i);
        if (this->devices_[i].ib_mac_known) {
          char ib_hex[17]{0};
          this->bytes_to_hex(this->devices_[i].ib_mac, 8, ib_hex);
          char ib_val[32];
          snprintf(ib_val, sizeof(ib_val), "%s,%u", ib_hex, (unsigned int)this->devices_[i].ib_pan_id);
          nvs_set_str(handle, ib_k, ib_val);
        }

        // Save zone peers
        char peers_key[20];
        snprintf(peers_key, sizeof(peers_key), "peers_%u", (unsigned int)i);
        std::string peers_val = "";
        for (size_t p = 0; p < this->devices_[i].zone_peer_ipv6s.size(); p++) {
          if (p > 0) peers_val += ";";
          peers_val += this->devices_[i].zone_peer_ipv6s[p];
        }
        nvs_set_str(handle, peers_key, peers_val.c_str());
      }
      nvs_commit(handle);
      nvs_close(handle);
    }
    if (this->devices_mutex_ != nullptr) xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  void remove_device_nvs(const std::string &serial) {
    if (this->devices_mutex_ != nullptr) xSemaphoreTakeRecursive(this->devices_mutex_, portMAX_DELAY);
    for (auto it = this->devices_.begin(); it != this->devices_.end(); ++it) {
      if (it->serial_no == serial) {
        ESP_LOGI(TAG, "Removing device %s from NVRAM", serial.c_str());
        this->devices_.erase(it);
        break;
      }
    }
    nvs_handle_t handle;
    if (nvs_open("tado_emul", NVS_READWRITE, &handle) == ESP_OK) {
      nvs_erase_all(handle);
      nvs_commit(handle);
      nvs_close(handle);
    }
    this->save_to_nvs();
    if (this->devices_mutex_ != nullptr) xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  void clear_all_nvs() {
    if (this->devices_mutex_ != nullptr) xSemaphoreTakeRecursive(this->devices_mutex_, portMAX_DELAY);
    ESP_LOGI(TAG, "Erasing ALL emulated devices from NVRAM and in-memory registry");
    this->devices_.clear();
    nvs_handle_t handle;
    if (nvs_open("tado_emul", NVS_READWRITE, &handle) == ESP_OK) {
      nvs_erase_all(handle);
      nvs_commit(handle);
      nvs_close(handle);
    }
    if (this->devices_mutex_ != nullptr) xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  void derive_mac_from_ipv6(const std::string &ipv6_in, uint8_t *mac) {
    std::string ipv6 = ipv6_in;
    size_t bstart = ipv6.find('[');
    size_t bend = ipv6.find(']');
    if (bstart != std::string::npos && bend != std::string::npos) {
      ipv6 = ipv6.substr(bstart + 1, bend - bstart - 1);
    }
    std::vector<std::string> tokens;
    size_t pos = 0;
    while (pos < ipv6.length()) {
      size_t colon = ipv6.find(':', pos);
      std::string part = (colon == std::string::npos) ? ipv6.substr(pos) : ipv6.substr(pos, colon - pos);
      if (!part.empty()) tokens.push_back(part);
      if (colon == std::string::npos) break;
      pos = colon + 1;
    }
    if (tokens.size() < 4) return;
    uint16_t groups[4];
    for (int i = 0; i < 4; i++) {
      groups[i] = (uint16_t)strtoul(tokens[tokens.size() - 4 + i].c_str(), nullptr, 16);
    }
    // Convert to Little-Endian Wire Format: mac[0] = LSB, mac[7] = MSB
    mac[7] = ((groups[0] >> 8) & 0xFF) ^ 0x02;
    mac[6] = groups[0] & 0xFF;
    mac[5] = (groups[1] >> 8) & 0xFF;
    mac[4] = groups[1] & 0xFF;
    mac[3] = (groups[2] >> 8) & 0xFF;
    mac[2] = groups[2] & 0xFF;
    mac[1] = (groups[3] >> 8) & 0xFF;
    mac[0] = groups[3] & 0xFF;
  }

  void derive_mac_from_serial(const std::string &serial, uint8_t *mac) {
    // Little-Endian Wire Format: mac[0..3] = serial suffix LE, mac[4..7] = 0x07, 0xC5, 0x1B, 0x00
    uint32_t num = 0;
    if (serial.length() > 2) {
      num = (uint32_t)strtoul(serial.substr(2).c_str(), nullptr, 10);
    }
    mac[0] = num & 0xFF;
    mac[1] = (num >> 8) & 0xFF;
    mac[2] = (num >> 16) & 0xFF;
    mac[3] = (num >> 24) & 0xFF;
    mac[4] = 0x07;
    mac[5] = 0xC5;
    mac[6] = 0x1B;
    mac[7] = 0x00;
  }

  void hex_to_bytes(const char *hex, uint8_t *bytes, size_t len) {
    for (size_t i = 0; i < len; i++) {
      sscanf(hex + (i * 2), "%02hhx", &bytes[i]);
    }
  }

  void bytes_to_hex(const uint8_t *bytes, size_t len, char *hex) {
    for (size_t i = 0; i < len; i++) {
      snprintf(hex + (i * 2), 3, "%02x", bytes[i]);
    }
  }

  void handle_status_request(AsyncWebServerRequest *request) {
    std::string json = "{\"status\":\"ONLINE\",\"radio\":\"SX1276\",\"channel\":" + std::to_string(this->channel_) + ",\"devices\":[";
    if (this->devices_mutex_ != nullptr && xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
      for (size_t i = 0; i < this->devices_.size(); i++) {
        if (i > 0) json += ",";
        json += "{\"serial\":\"" + this->devices_[i].serial_no + "\",\"home_id\":" + std::to_string(this->devices_[i].home_id) + ",\"zone_id\":" + std::to_string(this->devices_[i].zone_id) + ",\"state\":" + std::to_string(static_cast<uint32_t>(this->devices_[i].pairing_state)) + ",\"temp\":" + std::to_string(this->devices_[i].target_temp_celsius) + ",\"humidity\":" + std::to_string(this->devices_[i].target_humidity_pct) + "}";
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
    }
    json += "]}";
    request->send(200, "application/json", json.c_str());
  }

  void handle_cmd_request(AsyncWebServerRequest *request, const std::string &body) {
    if (body.empty()) {
      request->send(400, "application/json", "{\"error\":\"Empty body\"}");
      return;
    }

    if (this->devices_mutex_ != nullptr && xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(200)) == pdTRUE) {
      // 1. Command: send_telemetry
      if (body.find("send_telemetry") != std::string::npos || json_has_key(body, "telemetry")) {
        std::string ser = json_extract_str(body, "serial");
        for (auto &dev : this->devices_) {
          if (ser.empty() || dev.serial_no == ser || body.find(dev.serial_no) != std::string::npos) {
            if (json_has_key(body, "temp_celsius")) dev.target_temp_celsius = (float)json_extract_num(body, "temp_celsius", dev.target_temp_celsius);
            if (json_has_key(body, "humidity_percent")) dev.target_humidity_pct = (float)json_extract_num(body, "humidity_percent", dev.target_humidity_pct);
            if (json_has_key(body, "battery_mv")) dev.target_battery_mv = (uint16_t)json_extract_num(body, "battery_mv", dev.target_battery_mv);

            this->send_telemetry_put(&dev, dev.target_temp_celsius, dev.target_humidity_pct, dev.target_battery_mv);
            xSemaphoreGiveRecursive(this->devices_mutex_);
            request->send(200, "application/json", "{\"ok\":true,\"message\":\"Telemetry dispatched over RF\"}");
            return;
          }
        }
        xSemaphoreGiveRecursive(this->devices_mutex_);
        request->send(404, "application/json", "{\"error\":\"Emulated device not found\"}");
        return;
      }
      // 2. Command: pair / pair_device
      else if (json_has_key(body, "pair") || body.find("pair_device") != std::string::npos) {
        std::string new_ser = json_extract_str(body, "serial");
        if (new_ser.empty()) {
          new_ser = "RU" + std::to_string(2400000000ULL + (millis() % 90000000ULL));
        }
        std::string ipv6_str = json_extract_str(body, "ipv6");
        uint32_t home_id = (uint32_t)json_extract_num(body, "home_id", 0);
        uint32_t zone_id = (uint32_t)json_extract_num(body, "zone_id", 0);
        std::string fact_str = json_extract_str(body, "factory_key");
        std::string op_str = json_extract_str(body, "op_key");
        std::string ib_ipv6_str = json_extract_str(body, "ib_ipv6");

        EmulatedDevice *existing = this->find_device(new_ser);
        if (!existing) {
          EmulatedDevice new_dev;
          new_dev.serial_no = new_ser;
          new_dev.ipv6_address = ipv6_str;
          new_dev.home_id = home_id;
          new_dev.zone_id = zone_id;
          if (fact_str.length() == 32) {
            new_dev.has_factory_key = true;
            this->hex_to_bytes(fact_str.c_str(), new_dev.factory_key, 16);
          }
          if (op_str.length() == 32) {
            new_dev.has_op_key = true;
            new_dev.pairing_state = STATE_PAIRED;
            this->hex_to_bytes(op_str.c_str(), new_dev.op_key, 16);
          }
          if (!ipv6_str.empty()) {
            this->derive_mac_from_ipv6(ipv6_str, new_dev.mac_addr);
          } else {
            this->derive_mac_from_serial(new_ser, new_dev.mac_addr);
          }
          new_dev.derive_short_addr();
          this->devices_.push_back(new_dev);
          existing = &this->devices_.back();
        } else {
          if (home_id) existing->home_id = home_id;
          if (zone_id) existing->zone_id = zone_id;
          if (fact_str.length() == 32) {
            existing->has_factory_key = true;
            this->hex_to_bytes(fact_str.c_str(), existing->factory_key, 16);
          }
          if (op_str.length() == 32) {
            existing->has_op_key = true;
            existing->pairing_state = STATE_PAIRED;
            this->hex_to_bytes(op_str.c_str(), existing->op_key, 16);
          }
          if (!ipv6_str.empty()) {
            existing->ipv6_address = ipv6_str;
            this->derive_mac_from_ipv6(ipv6_str, existing->mac_addr);
            existing->derive_short_addr();
          }
        }
        if (!ib_ipv6_str.empty()) {
          existing->ib_mac_known = true;
          this->derive_mac_from_ipv6(ib_ipv6_str, existing->ib_mac);
          existing->ib_pan_id = existing->ib_mac[0] | ((uint16_t)existing->ib_mac[1] << 8);
        }
        ESP_LOGI(TAG, "[REST RPC] Pair command processed for %s (Home=%lu, Zone=%lu)", existing->serial_no.c_str(), (unsigned long)existing->home_id, (unsigned long)existing->zone_id);
        ESP_LOGI(TAG, "[REST RPC] %s DevMAC (LE): %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X (Short: 0x%04X, IPv6: %s)",
                 existing->serial_no.c_str(),
                 existing->mac_addr[0], existing->mac_addr[1], existing->mac_addr[2], existing->mac_addr[3],
                 existing->mac_addr[4], existing->mac_addr[5], existing->mac_addr[6], existing->mac_addr[7],
                 existing->short_addr, existing->ipv6_address.c_str());
        if (existing->ib_mac_known) {
          ESP_LOGI(TAG, "[REST RPC] %s Target IBMAC (LE): %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X (PAN: 0x%04X)",
                   existing->serial_no.c_str(),
                   existing->ib_mac[0], existing->ib_mac[1], existing->ib_mac[2], existing->ib_mac[3],
                   existing->ib_mac[4], existing->ib_mac[5], existing->ib_mac[6], existing->ib_mac[7],
                   existing->ib_pan_id);
        }
        bool force_pair = (body.find("\"force_pair\":true") != std::string::npos || body.find("\"force\":true") != std::string::npos || body.find("\"re_pair\":true") != std::string::npos);
        if (force_pair) {
          existing->has_op_key = false;
          existing->pairing_state = STATE_IDLE;
        }

        if (existing->has_op_key) {
          ESP_LOGI(TAG, "[REST RPC] %s already has operational key.", existing->serial_no.c_str());
        } else {
          ESP_LOGI(TAG, "[REST RPC] %s starting pairing handshake via STATE_PAIR_BROADCAST_RS", existing->serial_no.c_str());
          existing->pairing_state = STATE_PAIR_BROADCAST_RS;
          existing->pair_tx_count_ = 0;
          existing->last_pair_tx_time_ = 0;
          this->send_broadcast_rs_packet(existing);
        }
        xSemaphoreGiveRecursive(this->devices_mutex_);
        request->send(200, "application/json", "{\"ok\":true,\"message\":\"Pairing initiated over RF\"}");
        return;
      }
      // 3. Command: remove / remove_device
      else if (json_has_key(body, "remove") || body.find("remove_device") != std::string::npos) {
        std::string ser = json_extract_str(body, "serial");
        if (!ser.empty()) {
          this->remove_device_nvs(ser);
          xSemaphoreGiveRecursive(this->devices_mutex_);
          request->send(200, "application/json", "{\"ok\":true,\"message\":\"Device removed from NVRAM\"}");
          return;
        }
      }
      // 4. Command: clear_nvs / clear_all
      else if (json_has_key(body, "clear_nvs") || json_has_key(body, "clear_all") || body.find("clear_nvs") != std::string::npos || body.find("clear_nvram") != std::string::npos) {
        this->clear_all_nvs();
        xSemaphoreGiveRecursive(this->devices_mutex_);
        request->send(200, "application/json", "{\"ok\":true,\"message\":\"All emulated devices cleared from NVRAM\"}");
        return;
      }
      // 5. Command: reboot / restart
      else if (json_has_key(body, "reboot") || json_has_key(body, "restart") || body.find("reboot") != std::string::npos) {
        xSemaphoreGiveRecursive(this->devices_mutex_);
        request->send(200, "application/json", "{\"ok\":true,\"message\":\"Rebooting ESP32...\"}");
        this->set_timeout(500, []() {
          ESP_LOGI(TAG, "Rebooting ESP32 upon REST RPC request...");
          esp_restart();
        });
        return;
      }
      // 6. Command: clear_and_reboot
      else if (json_has_key(body, "clear_and_reboot")) {
        this->clear_all_nvs();
        xSemaphoreGiveRecursive(this->devices_mutex_);
        request->send(200, "application/json", "{\"ok\":true,\"message\":\"NVRAM cleared. Rebooting ESP32...\"}");
        this->set_timeout(500, []() {
          ESP_LOGI(TAG, "Rebooting ESP32 after NVRAM clear...");
          esp_restart();
        });
        return;
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
    }
    request->send(200, "application/json", "{\"ok\":true,\"message\":\"Command processed\"}");
  }

  void fetch_initial_telemetry_from_server(EmulatedDevice *dev) {
    if (this->server_url_.empty() || dev == nullptr) return;
    std::string url = this->server_url_ + "/setup/emulated/devices/" + dev->serial_no + "/state";

    char buffer[1024]{0};
    esp_http_client_config_t http_cfg = {};
    http_cfg.url = url.c_str();
    http_cfg.method = HTTP_METHOD_GET;
    http_cfg.timeout_ms = 3000;
    esp_http_client_handle_t client = esp_http_client_init(&http_cfg);
    if (client != nullptr) {
      if (!this->api_key_.empty()) {
        esp_http_client_set_header(client, "X-ESP-API-Key", this->api_key_.c_str());
      }
      esp_err_t err = esp_http_client_open(client, 0);
      if (err == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int read_bytes = esp_http_client_read_response(client, buffer, sizeof(buffer) - 1);
        if (read_bytes > 0) {
          buffer[read_bytes] = '\0';
          std::string resp(buffer);
          if (json_has_key(resp, "temp_celsius")) {
            float t = (float)json_extract_num(resp, "temp_celsius", dev->target_temp_celsius);
            if (t > -20.0f && t < 60.0f) dev->target_temp_celsius = t;
          }
          if (json_has_key(resp, "humidity_percent")) {
            float h = (float)json_extract_num(resp, "humidity_percent", dev->target_humidity_pct);
            if (h >= 0.0f && h <= 100.0f) dev->target_humidity_pct = h;
          }
          if (json_has_key(resp, "battery_mv")) {
            uint16_t b = (uint16_t)json_extract_num(resp, "battery_mv", dev->target_battery_mv);
            if (b >= 2000 && b <= 5000) dev->target_battery_mv = b;
          }
          if (json_has_key(resp, "zone_id")) {
            uint16_t zid = (uint16_t)json_extract_num(resp, "zone_id", dev->zone_id);
            if (zid > 0) dev->zone_id = zid;
          }
          if (json_has_key(resp, "fw_version")) {
            dev->fw_version = (uint16_t)json_extract_num(resp, "fw_version", dev->fw_version);
          }
          if (json_has_key(resp, "fw_other_slot")) {
            dev->fw_other_slot = (uint16_t)json_extract_num(resp, "fw_other_slot", dev->fw_other_slot);
          }
          if (json_has_key(resp, "fw_build_id")) {
            std::string b_id = json_extract_str(resp, "fw_build_id");
            if (!b_id.empty()) dev->fw_build_id = b_id;
          }
          if (json_has_key(resp, "device_type_code")) {
            dev->dev_type_code = (uint8_t)json_extract_num(resp, "device_type_code", dev->dev_type_code);
          }
          if (json_has_key(resp, "slot_num")) {
            dev->slot_num = (uint8_t)json_extract_num(resp, "slot_num", dev->slot_num);
          }
          if (json_has_key(resp, "field_01a0")) {
            dev->field_01a0 = (uint8_t)json_extract_num(resp, "field_01a0", dev->field_01a0);
          }
          if (json_has_key(resp, "field_003b")) {
            dev->field_003b = (uint8_t)json_extract_num(resp, "field_003b", dev->field_003b);
          }
          if (json_has_key(resp, "field_003c")) {
            dev->field_003c = (uint8_t)json_extract_num(resp, "field_003c", dev->field_003c);
          }
          if (json_has_key(resp, "field_014c")) {
            dev->field_014c = (uint8_t)json_extract_num(resp, "field_014c", dev->field_014c);
          }
          if (json_has_key(resp, "peers")) {
            auto server_peers = json_extract_str_array(resp, "peers");
            for (const auto &p_uri : server_peers) {
              bool known = false;
              for (const auto &ex : dev->zone_peer_ipv6s) {
                if (ex == p_uri) { known = true; break; }
              }
              if (!known) {
                dev->zone_peer_ipv6s.push_back(p_uri);
                std::vector<uint8_t> p_mac(8, 0xFF);
                this->derive_mac_from_ipv6(p_uri, p_mac.data());
                dev->zone_peer_macs.push_back(p_mac);
                ESP_LOGI(TAG, "✓ %s: Synced zone peer from server: %s", dev->serial_no.c_str(), p_uri.c_str());
              }
            }
          }
          ESP_LOGI(TAG, "✓ %s: Synced real metadata from server: Temp=%.2fC, Hum=%.1f%%, Batt=%umV, FW=%u (build %s), Slot=%u, Zone=%u, Peers=%u",
                   dev->serial_no.c_str(), dev->target_temp_celsius, dev->target_humidity_pct, dev->target_battery_mv, dev->fw_version, dev->fw_build_id.c_str(), dev->slot_num, (unsigned int)dev->zone_id, (unsigned int)dev->zone_peer_ipv6s.size());
          this->save_to_nvs();
        }
      }
      esp_http_client_cleanup(client);
    }
  }

 protected:
  InternalGPIOPin *dio0_pin_{nullptr};
  InternalGPIOPin *rst_pin_{nullptr};
  int channel_{26};
  web_server_base::WebServerBase *base_{nullptr};
  std::string server_url_{""};
  std::string api_key_{""};
  std::vector<EmulatedDevice> devices_;
  SemaphoreHandle_t spi_mutex_{nullptr};
  SemaphoreHandle_t devices_mutex_{nullptr};
  TaskHandle_t radio_task_handle_{nullptr};
  TaskHandle_t processing_task_handle_{nullptr};
  QueueHandle_t packet_queue_{nullptr};
  uint32_t last_rx_time_{0};
  uint32_t last_fifo_check_{0};
};

}  // namespace tado_emulator
}  // namespace esphome
