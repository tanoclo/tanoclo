/**
 * @file tado_emulator.cpp
 * @brief Implementation of TadoEmulatorComponent ESPHome coordinator.
 */

#include "tado_emulator.h"
#include <esphome/core/log.h>
#include <nvs_flash.h>
#include <nvs.h>
#include <esp_timer.h>

namespace esphome {
namespace tado_emulator {

static const char *const TAG = "tado_emulator";

TadoEmulatorComponent::TadoEmulatorComponent() {
  devices_mutex_ = xSemaphoreCreateRecursiveMutex();
}

void IRAM_ATTR TadoEmulatorComponent::dio0_isr(TadoEmulatorComponent *arg) {
  if (arg && arg->radio_task_handle_) {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    vTaskNotifyGiveFromISR(arg->radio_task_handle_, &xHigherPriorityTaskWoken);
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
  }
}

void TadoEmulatorComponent::radio_task_entry(void *param) {
  auto *self = static_cast<TadoEmulatorComponent *>(param);
  while (true) {
    uint32_t wait_ticks = pdMS_TO_TICKS(self->fast_fifo_drain_ ? 1 : 10);
    ulTaskNotifyTake(pdTRUE, wait_ticks > 0 ? wait_ticks : 1);
    self->radio_read_fifo();
  }
}

void TadoEmulatorComponent::processing_task_entry(void *param) {
  auto *self = static_cast<TadoEmulatorComponent *>(param);
  RxPacket pkt;
  while (true) {
    if (xQueueReceive(self->rx_queue_, &pkt, portMAX_DELAY) == pdTRUE) {
      self->process_queued_packet(pkt);
      vTaskDelay(0);
    }
  }
}

void TadoEmulatorComponent::radio_read_fifo() {
  RxPacket pkt;
  while (radio_.read_rx_packet(pkt)) {
    if (rx_queue_ != nullptr) {
      xQueueSend(rx_queue_, &pkt, 0);
    }
  }
}

bool TadoEmulatorComponent::transmit_frame(const std::vector<uint8_t> &frame) {
  if (frame.empty()) return false;
  ESP_LOGD(TAG, "TX frame len=%d [0..3]=%02X %02X %02X %02X", (int)frame.size(),
           frame[0], frame.size() > 1 ? frame[1] : 0, frame.size() > 2 ? frame[2] : 0, frame.size() > 3 ? frame[3] : 0);
  return radio_.send_frame(frame.data(), frame.size());
}

void TadoEmulatorComponent::setup() {
  ESP_LOGI(TAG, "Initializing TaNoClo Tado Device Emulator...");

  // Setup SPI and Radio Hardware
  this->spi_setup();
  radio_.set_spi_device(this);
  radio_.set_rst_pin(rst_pin_);
  radio_.set_dio0_pin(dio0_pin_);
  radio_.set_channel(channel_);
  radio_.set_fast_fifo_drain(fast_fifo_drain_);

  if (!radio_.init_radio()) {
    ESP_LOGE(TAG, "Failed to initialize SX1276 radio!");
    this->mark_failed();
    return;
  }

  // Attach DIO0 interrupt
  if (dio0_pin_ != nullptr) {
    dio0_pin_->setup();
    dio0_pin_->attach_interrupt(TadoEmulatorComponent::dio0_isr, this, gpio::INTERRUPT_RISING_EDGE);
  }

  // Create Rx Queue
  rx_queue_ = xQueueCreate(16, sizeof(RxPacket));

  // Create FreeRTOS Tasks
  xTaskCreatePinnedToCore(radio_task_entry, "tado_radio_rx", 4096, this, 5, &radio_task_handle_, 0);
  xTaskCreatePinnedToCore(processing_task_entry, "tado_proc", 8192, this, 1, &processing_task_handle_, 1);

  // Load registered emulated devices from NVS
  load_from_nvs();

  // Register Web Server REST API Handlers
  auto *ws = base_ ? base_ : web_server_base::global_web_server_base;
  if (ws != nullptr) {
    ws->init();
    ws->add_handler_without_auth(this);
    ESP_LOGI(TAG, "REST API endpoints registered on Web Server (/api/status, /api/cmd)");
  }
}

void TadoEmulatorComponent::loop() {
  uint32_t now_ms = millis();
  uint32_t now_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);

  if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
    for (auto &dev : devices_) {
      std::vector<std::vector<uint8_t>> outbound;
      dev.tick(now_ms, now_s, outbound);
      for (const auto &frame : outbound) {
        transmit_frame(frame);
      }
    }
    xSemaphoreGiveRecursive(devices_mutex_);
  }
}

void TadoEmulatorComponent::process_queued_packet(const RxPacket &pkt) {
  if (pkt.length < 5) return;

  // 1. Check for CSL Strobe Beacons
  if (protocol::is_csl_beacon(pkt.data, pkt.length)) {
    uint8_t seq;
    uint16_t pan, dst_short, cd;
    if (protocol::parse_csl_beacon(pkt.data, pkt.length, seq, pan, dst_short, cd)) {
      if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(10)) == pdTRUE) {
        for (auto &dev : devices_) {
          std::vector<std::vector<uint8_t>> outbound;
          dev.process_csl_strobe(seq, dst_short, cd, outbound);
          for (const auto &frame : outbound) {
            transmit_frame(frame);
          }
        }
        xSemaphoreGiveRecursive(devices_mutex_);
      }
    }
    return;
  }

  // 2. Parse MAC Header
  ParsedMac mac;
  if (!protocol::parse_mac_header(pkt.data, pkt.length, nullptr, 0, mac)) {
    return;
  }

  if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
    for (auto &dev : devices_) {
      const auto &cfg = dev.get_config();

      // Check if frame matches device destination MAC or is broadcast
      bool match = mac.is_broadcast;
      if (!match) {
        match = (std::memcmp(cfg.mac_addr, mac.dst_mac, 6) == 0) ||
                (cfg.short_addr == (mac.dst_mac[0] | ((uint16_t)mac.dst_mac[1] << 8)));
      }

      if (match) {
        std::vector<uint8_t> decrypted;
        bool dec_ok = false;
        const char *used_key = nullptr;

        const uint8_t *active_key = PAIRING_KEY;
        // Try op_key first if device has operational key
        if (cfg.has_op_key && protocol::decrypt_ccm(pkt.data, pkt.length, cfg.op_key, decrypted)) {
          dec_ok = true;
          used_key = "OP";
          active_key = cfg.op_key;
        } else if (protocol::decrypt_ccm(pkt.data, pkt.length, PAIRING_KEY, decrypted)) {
          dec_ok = true;
          used_key = "PAIRING";
          active_key = PAIRING_KEY;
        }

        if (dec_ok) {
          ESP_LOGI(TAG, "Decrypted RX frame len=%d for dev=%s (key=%s)", (int)decrypted.size(),
                   cfg.serial_no.c_str(), used_key);
          bool was_operational = (cfg.state == STATE_OPERATIONAL);
          std::vector<std::vector<uint8_t>> outbound;
          dev.process_inbound_decrypted(mac, decrypted.data(), decrypted.size(), outbound, active_key);
          if (!was_operational && dev.get_config().state == STATE_OPERATIONAL) {
            save_to_nvs();
            ESP_LOGI(TAG, "Device %s successfully paired and saved to NVS!", cfg.serial_no.c_str());
          }
          for (const auto &frame : outbound) {
            transmit_frame(frame);
          }
        }
      }
    }
    xSemaphoreGiveRecursive(devices_mutex_);
  }
}

void TadoEmulatorComponent::add_device(const EmulatedDeviceConfig &cfg) {
  if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
    devices_.emplace_back(cfg);
    xSemaphoreGiveRecursive(devices_mutex_);
  }
}

RUStateMachine *TadoEmulatorComponent::find_device(const std::string &serial) {
  for (auto &dev : devices_) {
    if (dev.get_config().serial_no == serial) return &dev;
  }
  return nullptr;
}

// ---------------------------------------------------------------------------
// NVS Persistence
// ---------------------------------------------------------------------------

void TadoEmulatorComponent::save_to_nvs() {
  nvs_handle_t handle;
  esp_err_t err = nvs_open("tado_emul", NVS_READWRITE, &handle);
  if (err != ESP_OK) return;

  if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
    uint32_t count = devices_.size();
    nvs_set_u32(handle, "dev_count", count);

    for (uint32_t i = 0; i < count; i++) {
      std::string prefix = "d" + std::to_string(i) + "_";
      const auto &cfg = devices_[i].get_config();
      nvs_set_str(handle, (prefix + "ser").c_str(), cfg.serial_no.c_str());
      nvs_set_blob(handle, (prefix + "mac").c_str(), cfg.mac_addr, 8);
      nvs_set_blob(handle, (prefix + "opk").c_str(), cfg.op_key, 16);
      nvs_set_blob(handle, (prefix + "fak").c_str(), cfg.factory_key, 16);
      nvs_set_blob(handle, (prefix + "tok").c_str(), cfg.session_token, 8);
      nvs_set_u8(handle, (prefix + "st").c_str(), (uint8_t)cfg.state);
      nvs_set_u32(handle, (prefix + "hid").c_str(), cfg.home_id);
      nvs_set_u32(handle, (prefix + "zid").c_str(), cfg.zone_id);
      nvs_set_blob(handle, (prefix + "ibm").c_str(), cfg.ib_mac, 8);
    }

    nvs_commit(handle);
    nvs_close(handle);
    xSemaphoreGiveRecursive(devices_mutex_);
  }
}

void TadoEmulatorComponent::load_from_nvs() {
  nvs_handle_t handle;
  esp_err_t err = nvs_open("tado_emul", NVS_READONLY, &handle);
  if (err != ESP_OK) return;

  uint32_t count = 0;
  nvs_get_u32(handle, "dev_count", &count);

  if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
    devices_.clear();
    for (uint32_t i = 0; i < count; i++) {
      std::string prefix = "d" + std::to_string(i) + "_";
      EmulatedDeviceConfig cfg;
      char sbuf[32]{0};
      size_t slen = sizeof(sbuf);
      if (nvs_get_str(handle, (prefix + "ser").c_str(), sbuf, &slen) == ESP_OK) {
        cfg.serial_no = sbuf;
      }
      size_t blen = 8;
      nvs_get_blob(handle, (prefix + "mac").c_str(), cfg.mac_addr, &blen);
      blen = 16;
      if (nvs_get_blob(handle, (prefix + "opk").c_str(), cfg.op_key, &blen) == ESP_OK) cfg.has_op_key = true;
      blen = 16;
      if (nvs_get_blob(handle, (prefix + "fak").c_str(), cfg.factory_key, &blen) == ESP_OK) cfg.has_factory_key = true;
      blen = 8;
      if (nvs_get_blob(handle, (prefix + "tok").c_str(), cfg.session_token, &blen) == ESP_OK) cfg.has_session_token = true;
      uint8_t st = 0;
      nvs_get_u8(handle, (prefix + "st").c_str(), &st);
      cfg.state = (RUState)st;
      nvs_get_u32(handle, (prefix + "hid").c_str(), &cfg.home_id);
      nvs_get_u32(handle, (prefix + "zid").c_str(), &cfg.zone_id);
      blen = 8;
      if (nvs_get_blob(handle, (prefix + "ibm").c_str(), cfg.ib_mac, &blen) == ESP_OK) cfg.ib_mac_known = true;

      cfg.derive_short_addr();
      devices_.emplace_back(cfg);
    }
    nvs_close(handle);
    xSemaphoreGiveRecursive(devices_mutex_);
  }
}

// ---------------------------------------------------------------------------
// AsyncWebHandler REST API
// ---------------------------------------------------------------------------

bool TadoEmulatorComponent::canHandle(AsyncWebServerRequest *request) const {
#if USE_ESP32
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
#else
  const auto &url = request->url();
#endif
  if (url == "/api/status" || url == "/api/cmd") return true;
  return false;
}

void TadoEmulatorComponent::handleBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
  if (index == 0) pending_body_.clear();
  pending_body_.append((const char *)data, len);
}

void TadoEmulatorComponent::handleRequest(AsyncWebServerRequest *request) {
#if USE_ESP32
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  StringRef url = request->url_to(url_buf);
#else
  const auto &url = request->url();
#endif
  if (url == "/api/status") {
    handle_status_request(request);
  } else if (url == "/api/cmd") {
    std::string body = pending_body_;
    if (body.empty()) {
      if (request->hasArg("plain")) {
        body = request->arg("plain");
      } else if (request->hasArg("body")) {
        body = request->arg("body");
      }
    }
    handle_cmd_request(request, body);
    pending_body_.clear();
  } else {
    request->send(404, "text/plain", "Not Found");
  }
}

void TadoEmulatorComponent::handle_status_request(AsyncWebServerRequest *request) {
  std::string json = "{\"devices\":[";
  if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
    for (size_t i = 0; i < devices_.size(); i++) {
      if (i > 0) json += ",";
      const auto &cfg = devices_[i].get_config();
      json += "{\"serial\":\"" + cfg.serial_no + "\",";
      json += "\"state\":" + std::to_string((int)cfg.state) + ",";
      json += "\"temp\":" + std::to_string(cfg.target_temp_celsius) + ",";
      json += "\"hum\":" + std::to_string(cfg.target_humidity_pct) + ",";
      json += "\"bat\":" + std::to_string(cfg.target_battery_mv) + ",";
      json += "\"child_lock\":" + std::string(cfg.child_lock ? "true" : "false") + ",";
      json += "\"last_telemetry\":" + std::to_string(cfg.last_telemetry_ts) + "}";
    }
    xSemaphoreGiveRecursive(devices_mutex_);
  }
  json += "]}";
  request->send(200, "application/json", json.c_str());
}

static std::string url_decode(const std::string &in) {
  std::string out;
  out.reserve(in.length());
  for (size_t i = 0; i < in.length(); i++) {
    if (in[i] == '%' && i + 2 < in.length()) {
      auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      int v1 = hex(in[i + 1]), v2 = hex(in[i + 2]);
      if (v1 >= 0 && v2 >= 0) {
        out += (char)((v1 << 4) | v2);
        i += 2;
        continue;
      }
    } else if (in[i] == '+') {
      out += ' ';
    } else {
      out += in[i];
    }
  }
  return out;
}

static std::string json_get_str(const std::string &body, const std::string &key) {
  size_t k = body.find("\"" + key + "\"");
  if (k == std::string::npos) return "";
  size_t colon = body.find(':', k + key.length() + 2);
  if (colon == std::string::npos) return "";
  size_t q1 = body.find('"', colon + 1);
  if (q1 == std::string::npos) return "";
  size_t q2 = body.find('"', q1 + 1);
  if (q2 == std::string::npos) return "";
  return body.substr(q1 + 1, q2 - q1 - 1);
}

static double json_get_num(const std::string &body, const std::string &key, double def_val = 0.0) {
  size_t k = body.find("\"" + key + "\"");
  if (k == std::string::npos) return def_val;
  size_t colon = body.find(':', k + key.length() + 2);
  if (colon == std::string::npos) return def_val;
  size_t val_start = colon + 1;
  while (val_start < body.length() && (body[val_start] == ' ' || body[val_start] == '\t')) val_start++;
  if (val_start >= body.length()) return def_val;
  return atof(body.substr(val_start).c_str());
}

static void hex_to_bytes(const std::string &hex, uint8_t *bytes, size_t max_len) {
  size_t len = hex.length() / 2;
  if (len > max_len) len = max_len;
  for (size_t i = 0; i < len; i++) {
    auto h2b = [](char c) -> uint8_t {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return 0;
    };
    bytes[i] = (h2b(hex[i * 2]) << 4) | h2b(hex[i * 2 + 1]);
  }
}

void TadoEmulatorComponent::handle_cmd_request(AsyncWebServerRequest *request, const std::string &raw_body) {
  if (raw_body.empty()) {
    request->send(400, "application/json", "{\"error\":\"Empty body\"}");
    return;
  }

  std::string body = raw_body;
  if (body.rfind("plain=", 0) == 0) {
    body = url_decode(body.substr(6));
  } else if (body.find('%') != std::string::npos) {
    body = url_decode(body);
  }

  ESP_LOGI(TAG, "API CMD received: %s", body.c_str());

  // 1. send_telemetry
  if (body.find("send_telemetry") != std::string::npos || body.find("telemetry") != std::string::npos) {
    std::string ser = json_get_str(body, "serial");
    if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(200)) == pdTRUE) {
      for (auto &dev : devices_) {
        const auto &cfg = dev.get_config();
        if (ser.empty() || cfg.serial_no == ser || body.find(cfg.serial_no) != std::string::npos) {
          float temp = (float)json_get_num(body, "temp_celsius", cfg.target_temp_celsius);
          float hum = (float)json_get_num(body, "humidity_percent", cfg.target_humidity_pct);
          uint16_t bat = (uint16_t)json_get_num(body, "battery_mv", cfg.target_battery_mv);

          std::vector<std::vector<uint8_t>> outbound;
          dev.trigger_telemetry(temp, hum, bat, outbound);
          for (const auto &f : outbound) {
            transmit_frame(f);
          }
          xSemaphoreGiveRecursive(devices_mutex_);
          request->send(200, "application/json", "{\"ok\":true,\"message\":\"Telemetry dispatched over RF\"}");
          return;
        }
      }
      xSemaphoreGiveRecursive(devices_mutex_);
    }
    request->send(404, "application/json", "{\"error\":\"Emulated device not found\"}");
    return;
  }

  // 2. sync (Reboot recovery / credential restoration - no RF pairing)
  if (body.find("\"sync\"") != std::string::npos || body.find("cmd\":\"sync\"") != std::string::npos) {
    std::string ser = json_get_str(body, "serial");
    if (ser.empty()) {
      request->send(400, "application/json", "{\"error\":\"Missing serial for sync\"}");
      return;
    }

    EmulatedDeviceConfig cfg;
    cfg.serial_no = ser;
    cfg.ipv6_address = json_get_str(body, "ipv6");
    cfg.home_id = (uint32_t)json_get_num(body, "home_id", 0);
    cfg.zone_id = (uint32_t)json_get_num(body, "zone_id", 0);

    std::string mac_hex = json_get_str(body, "mac");
    if (!mac_hex.empty() && mac_hex.length() >= 16) {
      hex_to_bytes(mac_hex, cfg.mac_addr, 8);
    }
    cfg.derive_short_addr();

    std::string opk = json_get_str(body, "op_key");
    if (!opk.empty() && opk.length() >= 32) {
      hex_to_bytes(opk, cfg.op_key, 16);
      cfg.has_op_key = true;
      cfg.state = STATE_OPERATIONAL;
    }

    std::string fk = json_get_str(body, "factory_key");
    if (!fk.empty()) {
      hex_to_bytes(fk, cfg.factory_key, 16);
      cfg.has_factory_key = true;
    }

    std::string ib_mac_hex = json_get_str(body, "ib_mac");
    if (!ib_mac_hex.empty()) {
      hex_to_bytes(ib_mac_hex, cfg.ib_mac, 8);
      cfg.ib_mac_known = true;
    }

    if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
      for (auto it = devices_.begin(); it != devices_.end(); ++it) {
        if (it->get_config().serial_no == ser) {
          devices_.erase(it);
          break;
        }
      }
      devices_.emplace_back(cfg);
      save_to_nvs();
      xSemaphoreGiveRecursive(devices_mutex_);
      ESP_LOGI(TAG, "Device %s synced and operational", ser.c_str());
      request->send(200, "application/json", "{\"ok\":true,\"message\":\"Device synced\"}");
      return;
    }
  }

  // 3. pair / pair_device
  if (body.find("pair") != std::string::npos) {
    std::string new_ser = json_get_str(body, "serial");
    if (new_ser.empty()) new_ser = "RU" + std::to_string(2400000000ULL + (millis() % 90000000ULL));

    EmulatedDeviceConfig cfg;
    cfg.serial_no = new_ser;
    cfg.ipv6_address = json_get_str(body, "ipv6");
    cfg.home_id = (uint32_t)json_get_num(body, "home_id", 0);
    cfg.zone_id = (uint32_t)json_get_num(body, "zone_id", 0);
    cfg.state = STATE_PAIR_BROADCAST_RS;

    // 8-byte MAC address: use explicit "mac" from ws-server payload if provided
    std::string mac_hex = json_get_str(body, "mac");
    if (!mac_hex.empty() && mac_hex.length() >= 16) {
      hex_to_bytes(mac_hex, cfg.mac_addr, 8);
    } else {
      uint32_t num = 0;
      if (new_ser.length() > 2) {
        num = (uint32_t)strtoul(new_ser.substr(2).c_str(), nullptr, 10);
      }
      cfg.mac_addr[0] = num & 0xFF;
      cfg.mac_addr[1] = (num >> 8) & 0xFF;
      cfg.mac_addr[2] = (num >> 16) & 0xFF;
      cfg.mac_addr[3] = (num >> 24) & 0xFF;
      cfg.mac_addr[4] = 0x07;
      cfg.mac_addr[5] = 0xC5;
      cfg.mac_addr[6] = 0x1B;
      cfg.mac_addr[7] = 0x00;
    }
    cfg.derive_short_addr();

    std::string fk = json_get_str(body, "factory_key");
    if (!fk.empty()) {
      hex_to_bytes(fk, cfg.factory_key, 16);
      cfg.has_factory_key = true;
    }

    // Starting pairing discovers bridge via RF broadcast RS
    cfg.ib_mac_known = false;
    std::memset(cfg.ib_mac, 0, 8);
    cfg.state = STATE_PAIR_BROADCAST_RS;

    if (devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
      // If device already exists, remove it first
      for (auto it = devices_.begin(); it != devices_.end(); ++it) {
        if (it->get_config().serial_no == new_ser) {
          devices_.erase(it);
          break;
        }
      }
      devices_.emplace_back(cfg);
      auto &new_dev = devices_.back();
      std::vector<std::vector<uint8_t>> outbound;
      new_dev.trigger_pairing(outbound);
      for (const auto &f : outbound) {
        transmit_frame(f);
      }
      save_to_nvs();
      xSemaphoreGiveRecursive(devices_mutex_);
      ESP_LOGI(TAG, "Pairing initiated for %s over RF", new_ser.c_str());
      request->send(200, "application/json", "{\"ok\":true,\"message\":\"Pairing initiated\"}");
      return;
    }
  }

  // 3. remove / remove_device
  if (body.find("remove") != std::string::npos) {
    std::string ser = json_get_str(body, "serial");
    if (!ser.empty() && devices_mutex_ != nullptr && xSemaphoreTakeRecursive(devices_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
      for (auto it = devices_.begin(); it != devices_.end(); ++it) {
        if (it->get_config().serial_no == ser) {
          devices_.erase(it);
          save_to_nvs();
          ESP_LOGI(TAG, "Device %s removed from NVS", ser.c_str());
          xSemaphoreGiveRecursive(devices_mutex_);
          request->send(200, "application/json", "{\"ok\":true,\"message\":\"Device removed\"}");
          return;
        }
      }
      xSemaphoreGiveRecursive(devices_mutex_);
      request->send(404, "application/json", "{\"error\":\"Device not found\"}");
      return;
    }
  }

  request->send(400, "application/json", "{\"error\":\"Unknown command\"}");
}

} // namespace tado_emulator
} // namespace esphome
