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
#include "esphome/core/preferences.h"
#include <esp_system.h>
#ifdef ESP_IDF_VERSION_MAJOR
#if ESP_IDF_VERSION_MAJOR >= 4
#include <esp_mac.h>
#endif
#endif
#include <mbedtls/ccm.h>
#include <mbedtls/aes.h>
#include <mbedtls/md.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <freertos/queue.h>
#include <HTTPClient.h>
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
  STATE_PAIRING_KEY = 1,   // POST auth/key over RF
  STATE_PAIRING_TOKEN = 2, // POST auth/token over RF
  STATE_PAIRED = 3,        // Fully operational
  STATE_FAILED = 4
};

/**
 * Tracks an unACKed CoAP CON request for retry with exponential backoff
 */
struct PendingRequest {
  uint16_t mid;
  uint32_t sent_ts;
  uint8_t retry_count;
  std::vector<uint8_t> frame; // Full RF frame for retransmission
};

/**
 * Structure representing an emulated Tado Room Unit (RU) device in NVRAM
 */
struct EmulatedDevice {
  std::string serial_no;
  std::string ipv6_address;
  uint8_t mac_addr[8]{0};
  uint8_t op_key[16]{0};
  uint8_t session_token[8]{0};
  bool has_op_key{false};
  bool has_session_token{false};
  uint32_t home_id{0};
  uint32_t zone_id{0};
  PairingState pairing_state{STATE_IDLE};
  uint16_t coap_mid{0x9000};
  uint8_t seq_num{0};
  uint32_t last_telemetry_ts{0};
  uint32_t last_config_check_ts{0};
  uint32_t last_token_refresh_ts{0};
  uint32_t last_time_sync_ts{0};
  std::string current_etag;

  // Discovered peer IPv6 addresses & MACs in the same zone
  std::vector<std::string> zone_peer_ipv6s;
  std::vector<std::vector<uint8_t>> zone_peer_macs;

  // Cached sensor telemetry values
  float target_temp_celsius{21.5f};
  float target_humidity_pct{50.0f};
  uint16_t target_battery_mv{4080}; // Default full battery
  uint8_t target_ambient_light{6};  // Default normal ambient light

  // CoAP CON retry tracking
  bool token_refresh_pending{false};
  std::vector<PendingRequest> pending_requests;
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
  void set_server_base(web_server_base::WebServerBase *base) { this->base_ = base; }
  void set_server_url(const std::string &url) { this->server_url_ = url; }
  void set_api_key(const std::string &key) { this->api_key_ = key; }

  void setup() override {
    ESP_LOGI(TAG, "Initializing TaNoClo ESP32 Multi-Device RU Emulator (TTGO LoRa32 SX1276)...");
    this->spi_setup();
    this->spi_mutex_ = xSemaphoreCreateMutex();
    this->devices_mutex_ = xSemaphoreCreateRecursiveMutex();

    this->init_hardware();
    this->load_from_nvs();

    if (this->base_ != nullptr) {
      this->base_->init();
      this->base_->get_server()->addHandler(this);
    }

    // Start background radio handling FreeRTOS task
    xTaskCreatePinnedToCore(TadoEmulatorComponent::radio_task_entry, "tado_emul_radio", 4096, this, 5, &this->radio_task_handle_, 1);
  }

  void loop() override {
    if (this->devices_mutex_ == nullptr) return;
    if (xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
      uint32_t now = millis() / 1000;
      for (auto &dev : this->devices_) {
        if (dev.pairing_state == STATE_PAIRED) {
          // 1. Periodic Telemetry Heartbeat (15 mins / 900s)
          if (now - dev.last_telemetry_ts >= 900) {
            dev.last_telemetry_ts = now;
            this->send_telemetry_put(&dev, dev.target_temp_celsius, dev.target_humidity_pct, dev.target_battery_mv);
            if (dev.zone_id != 0) {
              this->send_zone_p_put(&dev);
            }
          }
          // 2. Periodic Config ETag Check (1 hour / 3600s)
          if (now - dev.last_config_check_ts >= 3600) {
            dev.last_config_check_ts = now;
            this->send_config_get(&dev);
          }
          // 3. Periodic Session Token Refresh (24 hours / 86400s)
          if (now - dev.last_token_refresh_ts >= 86400) {
            dev.last_token_refresh_ts = now;
            this->send_auth_token_request(&dev);
          }
          // 4. Periodic Time Sync (24 hours / 86400s)
          if (now - dev.last_time_sync_ts >= 86400) {
            dev.last_time_sync_ts = now;
            this->send_time_get(&dev);
          }
        }
        // 5. CoAP CON retry with exponential backoff (2s, 4s, 8s, 16s)
        for (auto it = dev.pending_requests.begin(); it != dev.pending_requests.end(); ) {
          uint32_t elapsed = now - it->sent_ts;
          uint32_t timeout = 2u << it->retry_count; // 2, 4, 8, 16 seconds
          if (elapsed >= timeout) {
            if (it->retry_count >= 4) {
              ESP_LOGW(TAG, "[RF] %s: MID=0x%04X abandoned after 4 retries",
                       dev.serial_no.c_str(), it->mid);
              it = dev.pending_requests.erase(it);
            } else {
              it->retry_count++;
              it->sent_ts = now;
              ESP_LOGI(TAG, "[RF] %s: Retry #%u for MID=0x%04X (backoff %us)",
                       dev.serial_no.c_str(), it->retry_count, it->mid, 2u << it->retry_count);
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

  bool canHandle(AsyncWebServerRequest *request) override {
    return request->url() == "/api/cmd" || request->url() == "/api/status";
  }

  bool isRequestHandlerTrivial() override { return false; }

  void handleBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) override {
    if (index == 0) {
      request->_tempObject = new std::string();
    }
    if (request->_tempObject != nullptr) {
      auto *body = static_cast<std::string *>(request->_tempObject);
      body->append(reinterpret_cast<const char *>(data), len);
    }
  }

  void handleRequest(AsyncWebServerRequest *request) override {
    std::string body_str;
    if (request->_tempObject != nullptr) {
      auto *body_ptr = static_cast<std::string *>(request->_tempObject);
      body_str = *body_ptr;
      delete body_ptr;
      request->_tempObject = nullptr;
    }

    if (request->url() == "/api/status" && request->method() == HTTP_GET) {
      this->handle_status_request(request);
      return;
    }

    if (request->url() == "/api/cmd" && request->method() == HTTP_POST) {
      if (!this->api_key_.empty()) {
        if (!request->hasHeader("X-ESP-API-Key") || request->getHeader("X-ESP-API-Key")->value().c_str() != this->api_key_) {
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
   * Builds d/sen TLV payload based on real captured Room Unit measurements:
   * 0x012d: temperature_ambient (int16, degC * 100)
   * 0x012e: aux_temperature_1 (int16, follows ambient)
   * 0x0135: humidity_percent (int16, % * 100)
   * 0x0162: battery_mv (uint16, mV)
   * 0x0136: ambient_light_level (uint8, default 6)
   */
  static std::vector<uint8_t> build_d_sen_payload(float temp_c, float humidity_pct, uint16_t battery_mv, uint8_t light_level = 6) {
    std::vector<uint8_t> tlv;
    int16_t temp_val = (int16_t)(temp_c * 100.0f);
    int16_t aux_temp_val = temp_val; // Aux temperature follows ambient sensor
    int16_t hum_val = (int16_t)(humidity_pct * 100.0f);

    append_tlv_uint16(tlv, 0x0162, battery_mv);
    append_tlv_int16(tlv, 0x012d, temp_val);
    append_tlv_int16(tlv, 0x012e, aux_temp_val);
    append_tlv_int16(tlv, 0x0135, hum_val);
    append_tlv_uint16(tlv, 0x0136, (uint16_t)light_level);
    return tlv;
  }

  /**
   * Builds d/fw/state payload with exact captured 10 TLVs for RU:
   * fw_version_active: 13762, firmware_build_id: "c54baf8", slot: 1, etc.
   */
  static std::vector<uint8_t> build_d_fw_state_payload() {
    std::vector<uint8_t> tlv;
    append_tlv_uint8(tlv, 0x01a0, 8);
    append_tlv_uint16(tlv, 0x003a, 13762);
    append_tlv_uint8(tlv, 0x003b, 14);
    append_tlv_uint16(tlv, 0x0035, 13059);
    append_tlv_uint16(tlv, 0x0039, 13762);
    append_tlv_uint8(tlv, 0x0036, 10);
    append_tlv_uint8(tlv, 0x003c, 14);
    append_tlv_string(tlv, 0x0210, "c54baf8");
    append_tlv_uint8(tlv, 0x0180, 1);
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

  void send_telemetry_put(EmulatedDevice *dev, float temp_c, float hum_pct, uint16_t battery_mv) {
    dev->target_temp_celsius = temp_c;
    dev->target_humidity_pct = hum_pct;
    dev->target_battery_mv = battery_mv;

    std::vector<uint8_t> payload = build_d_sen_payload(temp_c, hum_pct, battery_mv, dev->target_ambient_light);
    std::string path = "d/" + dev->serial_no + "/sen";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
    ESP_LOGI(TAG, "[RF TX] %s: PUT %s (Temp=%.2fC, Hum=%.1f%%, Batt=%umV)",
             dev->serial_no.c_str(), path.c_str(), temp_c, hum_pct, battery_mv);
  }

  void send_fw_state_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_fw_state_payload();
    std::string path = "d/" + dev->serial_no + "/fw/state";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
    ESP_LOGI(TAG, "[RF TX] %s: PUT %s (Reported Firmware Version 13762)", dev->serial_no.c_str(), path.c_str());
  }

  void send_actuator_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_act_payload();
    std::string path = "d/" + dev->serial_no + "/act";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
    ESP_LOGI(TAG, "[RF TX] %s: PUT %s", dev->serial_no.c_str(), path.c_str());
  }

  void send_error_flags_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_d_err_payload();
    std::string path = "d/" + dev->serial_no + "/err";
    this->send_coap_request(dev, 3 /* PUT */, path, payload);
    ESP_LOGI(TAG, "[RF TX] %s: PUT %s (0 errors)", dev->serial_no.c_str(), path.c_str());
  }

  void send_zone_p_put(EmulatedDevice *dev) {
    std::vector<uint8_t> payload = build_z_p_payload(dev->target_temp_celsius);
    
    // 1. Broadcast / Internet Bridge transmission
    this->send_coap_request(dev, 3 /* PUT */, "z/p", payload);
    ESP_LOGI(TAG, "[RF TX] %s: PUT z/p -> IB/Broadcast (Zone %.2fC)",
             dev->serial_no.c_str(), dev->target_temp_celsius);

    // 2. Unicast transmission to all peer VA devices in the zone
    for (const auto &peer_mac : dev->zone_peer_macs) {
      if (peer_mac.size() == 8) {
        this->send_coap_raw_dest(dev, 3 /* PUT */, "z/p", payload, dev->op_key, true, peer_mac.data());
        ESP_LOGI(TAG, "[RF TX] %s: PUT z/p -> Peer VA MAC %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X",
                 dev->serial_no.c_str(),
                 peer_mac[0], peer_mac[1], peer_mac[2], peer_mac[3],
                 peer_mac[4], peer_mac[5], peer_mac[6], peer_mac[7]);
      }
    }
  }

  void send_config_get(EmulatedDevice *dev) {
    std::string path = "d/" + dev->serial_no + "/config";
    this->send_coap_request(dev, 1 /* GET */, path, {});
    ESP_LOGI(TAG, "[RF TX] %s: GET %s", dev->serial_no.c_str(), path.c_str());
  }

  void send_time_get(EmulatedDevice *dev) {
    this->send_coap_request(dev, 1 /* GET */, "time", {});
    ESP_LOGI(TAG, "[RF TX] %s: GET time", dev->serial_no.c_str());
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

    // Static Tado Pairing Key: "tado pairing key"
    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    this->send_coap_raw(dev, 2 /* POST */, "auth/key", payload, pairing_key, false);
    ESP_LOGI(TAG, "[RF TX] %s: POST auth/key (Pairing Step 1)", dev->serial_no.c_str());
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
    const uint8_t bcast_mac[8] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    this->send_coap_raw_dest(dev, code, path, payload, key, use_token, bcast_mac);
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

    // Option 2048 (Session Token) if applicable
    // Delta from option 11 = 2048 - 11 = 2037; extended 2-byte: 2037 - 269 = 1768 = 0x06E8
    if (use_token && dev->has_session_token) {
      coap.push_back(0xE8); // Delta=14(ext 2-byte), Length=8
      coap.push_back(0x06); // Extended delta MSB (1768 >> 8)
      coap.push_back(0xE8); // Extended delta LSB (1768 & 0xFF)
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
    // Destination PAN ID (frame[3..4] in LE: dest_mac[7], dest_mac[6])
    if (dest_mac && (dest_mac[0] != 0xFF || dest_mac[7] != 0xFF)) {
      frame_header[3] = dest_mac[7];
      frame_header[4] = dest_mac[6];
      // Destination MAC Suffix (6 Bytes in LE: dest_mac[5..0])
      frame_header[5] = dest_mac[5];
      frame_header[6] = dest_mac[4];
      frame_header[7] = dest_mac[3];
      frame_header[8] = dest_mac[2];
      frame_header[9] = dest_mac[1];
      frame_header[10] = dest_mac[0];
    } else {
      memset(frame_header + 3, 0xFF, 8);
    }
    // Source MAC Prefix (2 Bytes in LE: dev->mac_addr[7], dev->mac_addr[6])
    frame_header[11] = dev->mac_addr[7];
    frame_header[12] = dev->mac_addr[6];
    // Source MAC Middle (3 Bytes in LE: dev->mac_addr[5..3])
    frame_header[13] = dev->mac_addr[5];
    frame_header[14] = dev->mac_addr[4];
    frame_header[15] = dev->mac_addr[3];

    // 2. Build Plaintext (Hidden Address Tail + Inner Header + Dispatch + 6LoWPAN NHC + CoAP)
    std::vector<uint8_t> pt;
    // Source MAC Tail (3 Bytes in LE: dev->mac_addr[2..0] = OUI 0xC5, 0x1B, 0x00, hidden in ciphertext)
    pt.push_back(dev->mac_addr[2]);
    pt.push_back(dev->mac_addr[1]);
    pt.push_back(dev->mac_addr[0]);
    // Inner Protocol Header (0x04 = Operational/Standard)
    pt.push_back(0x04);
    pt.push_back(frame_seq);

    bool is_pairing = (dev->pairing_state == STATE_PAIRING_KEY || path == "auth/key");
    if (is_pairing) {
      // Tado Custom Dispatch: Pairing mode (0x00F0, 0x007E)
      pt.push_back(0xF0); pt.push_back(0x00); pt.push_back(0x00); pt.push_back(0x7E);
      // 6LoWPAN UDP NHC Header (6 Bytes: client port 5683 -> IB pairing port 4005 + 2 Bytes UDP checksum)
      pt.push_back(0x33); pt.push_back(0xF0); pt.push_back(0x16); pt.push_back(0x33); pt.push_back(0x0F); pt.push_back(0xA5);
      pt.push_back(0x00); pt.push_back(0x00); // UDP Checksum
    } else {
      // Tado Custom Dispatch: Operational mode (0x0000, 0x007A)
      pt.push_back(0x00); pt.push_back(0x00); pt.push_back(0x00); pt.push_back(0x7A);
      // 6LoWPAN UDP NHC Header (7 Bytes: operational CoAP ports 5683 <-> 5683)
      pt.push_back(0xF7); pt.push_back(0x00); pt.push_back(0xF0); pt.push_back(0x16); pt.push_back(0x33); pt.push_back(0x16); pt.push_back(0x33);
    }

    // Append CoAP Datagram
    pt.insert(pt.end(), coap.begin(), coap.end());

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

    // Register pending request for CoAP CON retry
    PendingRequest pr;
    pr.mid = mid;
    pr.sent_ts = millis() / 1000;
    pr.retry_count = 0;
    pr.frame = frame;
    dev->pending_requests.push_back(pr);

    // Transmit frame over SX1276 RF
    this->send_raw_rf_frame(frame);
  }

  void send_raw_rf_frame(const std::vector<uint8_t> &frame) {
    if (xSemaphoreTake(this->spi_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
      this->write_reg(REG_OP_MODE, 0x01); // Standby
      this->write_reg(REG_FIFO, (uint8_t)frame.size());
      for (uint8_t b : frame) {
        this->write_reg(REG_FIFO, b);
      }
      this->write_reg(REG_OP_MODE, 0x03); // Transmit
      delay(10);
      this->write_reg(REG_OP_MODE, 0x05); // Return to Continuous RX
      xSemaphoreGive(this->spi_mutex_);
    }
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

      // Frequency Deviation: 25 kHz -> 0x019A
      this->write_reg(REG_FDEV_MSB, 0x01);
      this->write_reg(REG_FDEV_LSB, 0x9A);

      // Frequency: 868.323 MHz (Channel 26) -> 0xD9, 0x14, 0xBC
      this->write_reg(REG_FRF_MSB, 0xD9);
      this->write_reg(REG_FRF_MID, 0x14);
      this->write_reg(REG_FRF_LSB, 0xBC);

      // Receiver Bandwidth: 100 kHz
      this->write_reg(REG_RX_BW, 0x0A);
      this->write_reg(REG_AFC_BW, 0x0A);

      // Sync Word: 0x550F7100
      this->write_reg(REG_SYNC_CONFIG, 0x93);
      this->write_reg(REG_SYNC_VALUE_1, 0x55);
      this->write_reg(REG_SYNC_VALUE_2, 0x0F);
      this->write_reg(REG_SYNC_VALUE_3, 0x71);
      this->write_reg(REG_SYNC_VALUE_4, 0x00);

      // Packet Config: Variable length, CRC on, whitening on
      this->write_reg(REG_PACKET_CONFIG_1, 0x98);
      this->write_reg(REG_PACKET_CONFIG_2, 0x40);
      this->write_reg(REG_PAYLOAD_LENGTH, 0x40);

      // Continuous Receive Mode
      this->write_reg(REG_OP_MODE, 0x05);
      xSemaphoreGive(this->spi_mutex_);
      ESP_LOGI(TAG, "SX1276 Transceiver configured for 868.323 MHz FSK (Channel 26)");
    }

    if (this->dio0_pin_ != nullptr) {
      this->dio0_pin_->setup();
      auto *expose_pin = static_cast<ExposeInternalPin *>(this->dio0_pin_);
      expose_pin->attach_interrupt(TadoEmulatorComponent::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
    }
  }

  static void radio_task_entry(void *param) {
    auto *self = static_cast<TadoEmulatorComponent *>(param);
    while (true) {
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      self->process_incoming_packet();
    }
  }

  void process_incoming_packet() {
    std::vector<uint8_t> buffer;
    if (xSemaphoreTake(this->spi_mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
      uint8_t len = this->read_reg(REG_FIFO);
      if (len > 0 && len <= 128) {
        buffer.resize(len);
        for (int i = 0; i < len; i++) {
          buffer[i] = this->read_reg(REG_FIFO);
        }
      }
      this->write_reg(REG_IRQ_FLAGS_2, 0x10); // Clear RX FIFO
      xSemaphoreGive(this->spi_mutex_);
    }

    // Minimum packet length: 16 bytes cleartext header + 1 byte ciphertext + 4 bytes MIC
    if (buffer.size() < 21) return;

    // Check IEEE 802.15.4 FCF (0xEC69 / Security Enabled bit 0x08)
    uint16_t fcf = buffer[0] | ((uint16_t)buffer[1] << 8);
    if (!(fcf & 0x08)) return; // Discard non-encrypted frames (e.g. beacons / ACKs)

    uint8_t seq = buffer[2];

    // Destination Extended Address (8 bytes): frame[3..4] (PAN ID) + frame[5..10] (MAC Suffix)
    uint8_t dest_mac[8];
    dest_mac[0] = buffer[3];
    dest_mac[1] = buffer[4];
    memcpy(dest_mac + 2, buffer.data() + 5, 6);

    if (xSemaphoreTakeRecursive(this->devices_mutex_, pdMS_TO_TICKS(100)) != pdTRUE) return;

    // Find matching emulated device by destination MAC
    EmulatedDevice *target_dev = nullptr;
    for (auto &dev : this->devices_) {
      if (memcmp(dev.mac_addr, dest_mac, 8) == 0) {
        target_dev = &dev;
        break;
      }
    }
    // Fallback: check broadcast destination (0xFF...)
    if (!target_dev && !this->devices_.empty()) {
      bool is_broadcast = true;
      for (int i = 3; i <= 10; i++) { if (buffer[i] != 0xFF) { is_broadcast = false; break; } }
      if (is_broadcast) target_dev = &this->devices_[0];
    }
    if (!target_dev) {
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    // Setup AES-128-CCM Decryption:
    // Nonce = frame[0..12] (13 bytes), AAD = frame[0..15] (16 bytes MAC header)
    uint8_t nonce[13];
    memcpy(nonce, buffer.data(), 13);
    uint8_t aad[16];
    memcpy(aad, buffer.data(), 16);

    size_t cipher_len = buffer.size() - 16 - 4;
    const uint8_t *ciphertext = buffer.data() + 16;
    const uint8_t *mic = buffer.data() + buffer.size() - 4;

    const uint8_t *key_to_use = target_dev->has_op_key ? target_dev->op_key : nullptr;
    const uint8_t pairing_key[16] = {0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69, 0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79};
    if (target_dev->pairing_state == STATE_PAIRING_KEY) {
      key_to_use = pairing_key;
    }
    if (!key_to_use) {
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

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
      }
      if (res != 0) {
        xSemaphoreGiveRecursive(this->devices_mutex_);
        return; // Decryption / Authentication failed
      }
    }

    // Decrypted Plaintext Layout per rf_protocol.md §4:
    // plaintext[0..2]  = Source MAC Tail (3 bytes)
    // plaintext[3]     = Inner Protocol Header (0x04)
    // plaintext[4]     = Sequence Number
    // plaintext[5..8]  = Tado Custom Dispatch (4 bytes)
    // plaintext[9..]   = 6LoWPAN UDP NHC Header -> CoAP Datagram
    if (decrypted.size() < 16 || decrypted[3] != 0x04) {
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    // Reconstitute complete 8-byte Source MAC address
    uint8_t src_mac[8];
    src_mac[0] = buffer[11];
    src_mac[1] = buffer[12];
    src_mac[2] = buffer[13];
    src_mac[3] = buffer[14];
    src_mac[4] = buffer[15];
    src_mac[5] = decrypted[0];
    src_mac[6] = decrypted[1];
    src_mac[7] = decrypted[2];

    // Determine CoAP message start offset past 6LoWPAN NHC header
    size_t coap_offset = 16; // Standard 7-byte NHC (offset 9 + 7 = 16)
    if (decrypted[9] == 0x33) {
      coap_offset = 15; // 6-byte NHC for pairing (offset 9 + 6 = 15)
    } else if (decrypted[9] != 0xF7) {
      // Dynamic scan for CoAP Header byte (Ver 1 = 0x40..0x7F)
      for (size_t s = 9; s + 4 <= decrypted.size(); s++) {
        if ((decrypted[s] & 0xC0) == 0x40 && decrypted[s+1] >= 1 && decrypted[s+1] <= 160) {
          coap_offset = s;
          break;
        }
      }
    }

    if (coap_offset + 4 > decrypted.size()) {
      xSemaphoreGiveRecursive(this->devices_mutex_);
      return;
    }

    uint8_t coap_code = decrypted[coap_offset + 1];
    uint16_t coap_mid = ((uint16_t)decrypted[coap_offset + 2] << 8) | decrypted[coap_offset + 3];

    // Clear matching pending request (ACK / response received)
    for (auto it = target_dev->pending_requests.begin(); it != target_dev->pending_requests.end(); ++it) {
      if (it->mid == coap_mid) {
        target_dev->pending_requests.erase(it);
        break;
      }
    }

    // Handle Pairing Step 1 response (auth/key -> extracts operational AES-128 key)
    if (target_dev->pairing_state == STATE_PAIRING_KEY && (coap_code == 69 || coap_code == 67 || coap_code == 65)) {
      for (size_t i = coap_offset + 4; i + 18 < decrypted.size(); i++) {
        if ((decrypted[i] == 0x00 && (decrypted[i+1] == 0x01 || decrypted[i+1] == 0x02 || decrypted[i+1] == 0x03)) && decrypted[i+2] == 16) {
          memcpy(target_dev->op_key, &decrypted[i+3], 16);
          target_dev->has_op_key = true;
          this->save_to_nvs();
          ESP_LOGI(TAG, "✓ Received operational key for %s. Progressing to auth/token", target_dev->serial_no.c_str());
          this->send_auth_token_request(target_dev);
          xSemaphoreGiveRecursive(this->devices_mutex_);
          return;
        }
      }
    }

    // Handle Pairing Step 2 / Token Refresh response (auth/token -> session token)
    if ((target_dev->pairing_state == STATE_PAIRING_TOKEN || target_dev->token_refresh_pending) && coap_code == 69) {
      for (size_t i = coap_offset + 4; i + 10 < decrypted.size(); i++) {
        if (decrypted[i] == 0x00 && decrypted[i+1] == 0x06 && decrypted[i+2] == 8) {
          memcpy(target_dev->session_token, &decrypted[i+3], 8);
          target_dev->has_session_token = true;
          if (target_dev->token_refresh_pending) {
            target_dev->token_refresh_pending = false;
            ESP_LOGI(TAG, "✓ Session token refreshed for %s", target_dev->serial_no.c_str());
          } else {
            target_dev->pairing_state = STATE_PAIRED;
            ESP_LOGI(TAG, "✓ Paired %s! Executing onboarding sequence...", target_dev->serial_no.c_str());
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
      }
    }

    // Handle config response / push — parse TLVs for zone assignment and peer URIs
    if (coap_code == 69 || coap_code == 68) { // 2.05 Content or 2.04 Changed
      size_t payload_start = 0;
      for (size_t i = coap_offset + 4; i < decrypted.size(); i++) {
        if (decrypted[i] == 0xFF) { payload_start = i + 1; break; }
      }
      if (payload_start > 0) {
        bool peers_changed = false;
        size_t p = payload_start;
        while (p + 3 < decrypted.size()) {
          uint16_t fid = ((uint16_t)decrypted[p] << 8) | decrypted[p+1];
          uint8_t flen = decrypted[p+2];
          if (p + 3 + flen > decrypted.size()) break;

          if (fid == 0x0158) {
            uint16_t val = (flen >= 2) ? (((uint16_t)decrypted[p+3] << 8) | decrypted[p+4]) : decrypted[p+3];
            if (val == 0 && target_dev->zone_id == 0) {
              std::string removed_serial = target_dev->serial_no;
              ESP_LOGI(TAG, "Unassociate command received for %s. Erasing from NVRAM.", removed_serial.c_str());
              this->remove_device_nvs(removed_serial);
              xSemaphoreGiveRecursive(this->devices_mutex_);

              // If server_url_ is configured, notify ws-server webhook of unassociation
              if (!this->server_url_.empty()) {
                std::string url = this->server_url_ + "/setup/emulated/notify-removed";
                std::string post_data = "{\"serial\":\"" + removed_serial + "\"}";
                HTTPClient http;
                http.begin(url.c_str());
                http.addHeader("Content-Type", "application/json");
                if (!this->api_key_.empty()) {
                  http.addHeader("X-ESP-API-Key", this->api_key_.c_str());
                }
                http.POST(post_data.c_str());
                http.end();
              }
              return;
            } else if (val != 0) {
              target_dev->zone_id = val;
            }
          } else if (fid == 0x8400 && flen > 0) {
            // Zone peer URI (e.g. coap://[fe80::21b:c500:0000:0001]/z/p)
            std::string uri((const char*)&decrypted[p+3], flen);
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
              ESP_LOGI(TAG, "Discovered zone peer: %s", uri.c_str());
            }
          }
          p += 3 + flen;
        }
        if (peers_changed || target_dev->zone_id != 0) {
          this->save_to_nvs();
        }
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
    Preferences prefs;
    prefs.begin("tado_emul", false);
    uint32_t count = prefs.getUInt("count", 0);
    ESP_LOGI(TAG, "Loading %u emulated RU devices from NVRAM...", count);

    for (uint32_t i = 0; i < count; i++) {
      char key[16];
      snprintf(key, sizeof(key), "dev_%u", i);
      String json = prefs.getString(key, "");
      if (json.length() > 0) {
        EmulatedDevice dev;
        char ser[32], ipv6[48], op[36], tok[20];
        uint32_t st = 0;
        int parsed = sscanf(json.c_str(), "%[^,],%[^,],%[^,],%[^,],%u,%u,%u",
                            ser, ipv6, op, tok, &dev.home_id, &dev.zone_id, &st);
        if (parsed >= 6) {
          dev.serial_no = ser;
          dev.ipv6_address = ipv6;
          dev.pairing_state = static_cast<PairingState>(st);
          if (strlen(op) == 32) {
            dev.has_op_key = true;
            this->hex_to_bytes(op, dev.op_key, 16);
          }
          if (strlen(tok) == 16) {
            dev.has_session_token = true;
            this->hex_to_bytes(tok, dev.session_token, 8);
          }
          if (!dev.ipv6_address.empty()) {
            this->derive_mac_from_ipv6(dev.ipv6_address, dev.mac_addr);
          } else {
            this->derive_mac_from_serial(dev.serial_no, dev.mac_addr);
          }

          // Load persisted zone peer IPv6s
          char peers_key[20];
          snprintf(peers_key, sizeof(peers_key), "peers_%u", i);
          String peers_str = prefs.getString(peers_key, "");
          if (peers_str.length() > 0) {
            size_t p_start = 0;
            while (p_start < peers_str.length()) {
              int comma = peers_str.indexOf(';', p_start);
              String ip = (comma == -1) ? peers_str.substring(p_start) : peers_str.substring(p_start, comma);
              if (ip.length() > 0) {
                dev.zone_peer_ipv6s.push_back(ip.c_str());
                std::vector<uint8_t> p_mac(8, 0xFF);
                this->derive_mac_from_ipv6(ip.c_str(), p_mac.data());
                dev.zone_peer_macs.push_back(p_mac);
              }
              if (comma == -1) break;
              p_start = comma + 1;
            }
          }

          this->devices_.push_back(dev);
        }
      }
    }
    prefs.end();
    if (this->devices_mutex_ != nullptr) xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  void save_to_nvs() {
    if (this->devices_mutex_ != nullptr) xSemaphoreTakeRecursive(this->devices_mutex_, portMAX_DELAY);
    Preferences prefs;
    prefs.begin("tado_emul", false);
    prefs.putUInt("count", this->devices_.size());
    for (size_t i = 0; i < this->devices_.size(); i++) {
      char key[16];
      snprintf(key, sizeof(key), "dev_%u", (uint32_t)i);
      char op_hex[33]{0}, tok_hex[17]{0};
      this->bytes_to_hex(this->devices_[i].op_key, 16, op_hex);
      this->bytes_to_hex(this->devices_[i].session_token, 8, tok_hex);

      char val[256];
      snprintf(val, sizeof(val), "%s,%s,%s,%s,%u,%u,%u",
               this->devices_[i].serial_no.c_str(),
               this->devices_[i].ipv6_address.c_str(),
               op_hex, tok_hex,
               this->devices_[i].home_id,
               this->devices_[i].zone_id,
               static_cast<uint32_t>(this->devices_[i].pairing_state));
      prefs.putString(key, val);

      // Save zone peers
      char peers_key[20];
      snprintf(peers_key, sizeof(peers_key), "peers_%u", (uint32_t)i);
      std::string peers_val = "";
      for (size_t p = 0; p < this->devices_[i].zone_peer_ipv6s.size(); p++) {
        if (p > 0) peers_val += ";";
        peers_val += this->devices_[i].zone_peer_ipv6s[p];
      }
      prefs.putString(peers_key, peers_val.c_str());
    }
    prefs.end();
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
    Preferences prefs;
    prefs.begin("tado_emul", false);
    prefs.clear();
    prefs.end();
    this->save_to_nvs();
    if (this->devices_mutex_ != nullptr) xSemaphoreGiveRecursive(this->devices_mutex_);
  }

  void derive_mac_from_ipv6(const std::string &ipv6_or_uri, uint8_t *mac) {
    // Extract IPv6 from CoAP URI if present: coap://[fe80::...]/z/p
    std::string ipv6 = ipv6_or_uri;
    size_t bstart = ipv6.find('[');
    size_t bend = ipv6.find(']');
    if (bstart != std::string::npos && bend != std::string::npos) {
      ipv6 = ipv6.substr(bstart + 1, bend - bstart - 1);
    }
    // Parse interface identifier from fe80::AABB:CCDD:EEFF:GGHH
    size_t dcolon = ipv6.find("::");
    if (dcolon == std::string::npos) return;
    std::string suffix = ipv6.substr(dcolon + 2);
    uint16_t groups[4] = {0};
    int g = 0;
    size_t pos = 0;
    while (pos < suffix.length() && g < 4) {
      size_t colon = suffix.find(':', pos);
      std::string part = (colon == std::string::npos) ? suffix.substr(pos) : suffix.substr(pos, colon - pos);
      groups[g++] = (uint16_t)strtoul(part.c_str(), nullptr, 16);
      if (colon == std::string::npos) break;
      pos = colon + 1;
    }
    // EUI-64: flip universal/local bit (bit 6 of first byte)
    mac[0] = ((groups[0] >> 8) & 0xFF) ^ 0x02;
    mac[1] = groups[0] & 0xFF;
    mac[2] = (groups[1] >> 8) & 0xFF;
    mac[3] = groups[1] & 0xFF;
    mac[4] = (groups[2] >> 8) & 0xFF;
    mac[5] = groups[2] & 0xFF;
    mac[6] = (groups[3] >> 8) & 0xFF;
    mac[7] = groups[3] & 0xFF;
  }

  void derive_mac_from_serial(const std::string &serial, uint8_t *mac) {
    // Standard Tado Room Unit MAC prefix
    mac[0] = 0x00; mac[1] = 0x1B; mac[2] = 0xC5; mac[3] = 0x07;
    uint32_t num = 0;
    if (serial.length() > 2) {
      num = (uint32_t)strtoul(serial.substr(2).c_str(), nullptr, 10);
    }
    mac[4] = (num >> 24) & 0xFF;
    mac[5] = (num >> 16) & 0xFF;
    mac[6] = (num >> 8) & 0xFF;
    mac[7] = num & 0xFF;
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
      if (body.find("send_telemetry") != std::string::npos || body.find("\"telemetry\"") != std::string::npos) {
        std::string ser;
        size_t s_idx = body.find("\"serial\":");
        if (s_idx != std::string::npos) {
          size_t q1 = body.find('"', s_idx + 9);
          if (q1 != std::string::npos) {
            size_t q2 = body.find('"', q1 + 1);
            if (q2 != std::string::npos) ser = body.substr(q1 + 1, q2 - q1 - 1);
          }
        }
        for (auto &dev : this->devices_) {
          if (ser.empty() || dev.serial_no == ser || body.find(dev.serial_no) != std::string::npos) {
            size_t t_idx = body.find("temp_celsius\":");
            if (t_idx != std::string::npos) dev.target_temp_celsius = (float)atof(body.substr(t_idx + 14).c_str());
            size_t h_idx = body.find("humidity_percent\":");
            if (h_idx != std::string::npos) dev.target_humidity_pct = (float)atof(body.substr(h_idx + 18).c_str());
            size_t b_idx = body.find("battery_mv\":");
            if (b_idx != std::string::npos) dev.target_battery_mv = (uint16_t)atoi(body.substr(b_idx + 12).c_str());

            this->send_telemetry_put(&dev, dev.target_temp_celsius, dev.target_humidity_pct, dev.target_battery_mv);
            if (dev.zone_id != 0) {
              this->send_zone_p_put(&dev);
            }
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
      else if (body.find("\"pair\"") != std::string::npos || body.find("pair_device") != std::string::npos) {
        std::string new_ser = "RU" + std::to_string(2400000000ULL + (millis() % 90000000ULL));
        size_t s_idx = body.find("\"serial\":");
        if (s_idx != std::string::npos) {
          size_t q1 = body.find('"', s_idx + 9);
          if (q1 != std::string::npos) {
            size_t q2 = body.find('"', q1 + 1);
            if (q2 != std::string::npos) new_ser = body.substr(q1 + 1, q2 - q1 - 1);
          }
        }
        std::string ipv6_str;
        size_t ip_idx = body.find("\"ipv6\":");
        if (ip_idx != std::string::npos) {
          size_t q1 = body.find('"', ip_idx + 7);
          if (q1 != std::string::npos) {
            size_t q2 = body.find('"', q1 + 1);
            if (q2 != std::string::npos) ipv6_str = body.substr(q1 + 1, q2 - q1 - 1);
          }
        }
        uint32_t home_id = 0, zone_id = 0;
        size_t h_idx = body.find("\"home_id\":");
        if (h_idx != std::string::npos) home_id = (uint32_t)atoi(body.substr(h_idx + 10).c_str());
        size_t z_idx = body.find("\"zone_id\":");
        if (z_idx != std::string::npos) zone_id = (uint32_t)atoi(body.substr(z_idx + 10).c_str());

        EmulatedDevice *existing = this->find_device(new_ser);
        if (!existing) {
          EmulatedDevice new_dev;
          new_dev.serial_no = new_ser;
          new_dev.ipv6_address = ipv6_str;
          new_dev.home_id = home_id;
          new_dev.zone_id = zone_id;
          if (!ipv6_str.empty()) {
            this->derive_mac_from_ipv6(ipv6_str, new_dev.mac_addr);
          } else {
            this->derive_mac_from_serial(new_ser, new_dev.mac_addr);
          }
          this->devices_.push_back(new_dev);
          existing = &this->devices_.back();
        } else {
          if (home_id) existing->home_id = home_id;
          if (zone_id) existing->zone_id = zone_id;
          if (!ipv6_str.empty()) {
            existing->ipv6_address = ipv6_str;
            this->derive_mac_from_ipv6(ipv6_str, existing->mac_addr);
          }
        }
        this->save_to_nvs();
        this->send_auth_key_request(existing);
        xSemaphoreGiveRecursive(this->devices_mutex_);
        request->send(200, "application/json", "{\"ok\":true,\"message\":\"Pairing initiated over RF\"}");
        return;
      }
      // 3. Command: remove / remove_device
      else if (body.find("\"remove\"") != std::string::npos || body.find("remove_device") != std::string::npos) {
        std::string ser;
        size_t s_idx = body.find("\"serial\":");
        if (s_idx != std::string::npos) {
          size_t q1 = body.find('"', s_idx + 9);
          if (q1 != std::string::npos) {
            size_t q2 = body.find('"', q1 + 1);
            if (q2 != std::string::npos) ser = body.substr(q1 + 1, q2 - q1 - 1);
          }
        }
        if (!ser.empty()) {
          this->remove_device_nvs(ser);
          xSemaphoreGiveRecursive(this->devices_mutex_);
          request->send(200, "application/json", "{\"ok\":true,\"message\":\"Device removed from NVRAM\"}");
          return;
        }
      }
      xSemaphoreGiveRecursive(this->devices_mutex_);
    }
    request->send(200, "application/json", "{\"ok\":true,\"message\":\"Command processed\"}");
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
};

}  // namespace tado_emulator
}  // namespace esphome
