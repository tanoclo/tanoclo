/**
 * @file tado_emulator.h
 * @brief High-level ESPHome component coordinating radio HAL, state machine, REST API, and NVS.
 */

#pragma once

#include "radio_sx1276.h"
#include "ru_state_machine.h"
#include <esphome/core/component.h>
#include <esphome/components/web_server_base/web_server_base.h>
#include <vector>
#include <string>

namespace esphome {
namespace tado_emulator {

class TadoEmulatorComponent : public Component,
                            public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW,
                                                  spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_8MHZ>,
                            public AsyncWebHandler {
 public:
  TadoEmulatorComponent();

  // Pins & Configuration setters called from Python codegen
  void set_rst_pin(InternalGPIOPin *pin) { rst_pin_ = pin; }
  void set_dio0_pin(InternalGPIOPin *pin) { dio0_pin_ = pin; }
  void set_channel(uint8_t ch) { channel_ = ch; }
  void set_fast_fifo_drain(bool en) { fast_fifo_drain_ = en; }
  void set_auto_mac_ack(bool en) { auto_mac_ack_ = en; }
  void set_server_url(const std::string &url) { server_url_ = url; }
  void set_api_key(const std::string &key) { api_key_ = key; }
  void set_server_base(web_server_base::WebServerBase *base) { base_ = base; }

  // ESPHome Lifecycle
  void setup() override;
  void loop() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  // AsyncWebHandler Interface for REST API (/api/status, /api/cmd)
  bool canHandle(AsyncWebServerRequest *request) const override;
  void handleRequest(AsyncWebServerRequest *request) override;
  void handleBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) override;
  bool isRequestHandlerTrivial() const override { return false; }

  // Device Management
  void add_device(const EmulatedDeviceConfig &cfg);
  RUStateMachine *find_device(const std::string &serial);

  // NVS Persistence
  void save_to_nvs();
  void load_from_nvs();

  // Internal Radio & Processing Tasks
  static void IRAM_ATTR dio0_isr(TadoEmulatorComponent *arg);
  static void radio_task_entry(void *param);
  static void processing_task_entry(void *param);

  void radio_read_fifo();
  void process_queued_packet(const RxPacket &pkt);
  bool transmit_frame(const std::vector<uint8_t> &frame);

 private:
  InternalGPIOPin *rst_pin_{nullptr};
  InternalGPIOPin *dio0_pin_{nullptr};
  uint8_t channel_{26};
  bool fast_fifo_drain_{true};
  bool auto_mac_ack_{true};
  std::string server_url_;
  std::string api_key_;
  web_server_base::WebServerBase *base_{nullptr};

  SX1276Radio radio_;
  std::vector<RUStateMachine> devices_;
  SemaphoreHandle_t devices_mutex_{nullptr};

  QueueHandle_t rx_queue_{nullptr};
  TaskHandle_t radio_task_handle_{nullptr};
  TaskHandle_t processing_task_handle_{nullptr};

  std::string pending_body_;

  void handle_cmd_request(AsyncWebServerRequest *request, const std::string &body);
  void handle_status_request(AsyncWebServerRequest *request);
};

} // namespace tado_emulator
} // namespace esphome
