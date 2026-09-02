/**
 * @file radio_sx1276.h
 * @brief Semtech SX1276 sub-GHz transceiver HAL for ESPHome / ESP32.
 */

#pragma once

#include <esphome/core/component.h>
#include <esphome/core/hal.h>
#include <esphome/components/spi/spi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <vector>

namespace esphome {
namespace tado_emulator {

// SX1276 FSK/OOK Register Map
enum SX1276Reg : uint8_t {
  REG_FIFO = 0x00,
  REG_OP_MODE = 0x01,
  REG_BITRATE_MSB = 0x02,
  REG_BITRATE_LSB = 0x03,
  REG_FDEV_MSB = 0x04,
  REG_FDEV_LSB = 0x05,
  REG_FRF_MSB = 0x06,
  REG_FRF_MID = 0x07,
  REG_FRF_LSB = 0x08,
  REG_PA_CONFIG = 0x09,
  REG_PARAMP = 0x0A,
  REG_OCP = 0x0B,
  REG_LNA = 0x0C,
  REG_RX_CONFIG = 0x0D,
  REG_RSSICONFIG = 0x0E,
  REG_RSSICOLLISION = 0x0F,
  REG_RSSITHRESH = 0x10,
  REG_RSSIVALUE = 0x11,
  REG_RX_BW = 0x12,
  REG_AFC_BW = 0x13,
  REG_PREAMBLE_DETECT = 0x1F,
  REG_RX_TIMEOUT_1 = 0x20,
  REG_RX_TIMEOUT_2 = 0x21,
  REG_RX_TIMEOUT_3 = 0x22,
  REG_SYNC_CONFIG = 0x27,
  REG_SYNC_VALUE_1 = 0x28,
  REG_SYNC_VALUE_2 = 0x29,
  REG_SYNC_VALUE_3 = 0x2A,
  REG_SYNC_VALUE_4 = 0x2B,
  REG_PACKET_CONFIG_1 = 0x30,
  REG_PACKET_CONFIG_2 = 0x31,
  REG_PAYLOAD_LENGTH = 0x32,
  REG_FIFO_THRESH = 0x35,
  REG_SEQ_CONFIG_1 = 0x36,
  REG_SEQ_CONFIG_2 = 0x37,
  REG_TIMER_RESOL = 0x38,
  REG_TIMER1_COEF = 0x39,
  REG_TIMER2_COEF = 0x3A,
  REG_IMAGE_CAL = 0x3B,
  REG_IRQ_FLAGS_1 = 0x3E,
  REG_IRQ_FLAGS_2 = 0x3F,
  REG_DIO_MAPPING_1 = 0x40,
  REG_DIO_MAPPING_2 = 0x41,
  REG_VERSION = 0x42,
  REG_PA_DAC = 0x4D
};

struct RxPacket {
  uint8_t length{0};
  uint8_t data[256]{0};
  int16_t rssi{0};
  uint32_t timestamp_ms{0};
};

using TadoSPIDevice = spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW,
                                       spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_8MHZ>;

class SX1276Radio {
 public:
  explicit SX1276Radio(TadoSPIDevice *spi = nullptr);

  void set_spi_device(TadoSPIDevice *spi) { spi_ = spi; }
  void set_rst_pin(InternalGPIOPin *pin) { rst_pin_ = pin; }
  void set_dio0_pin(InternalGPIOPin *pin) { dio0_pin_ = pin; }
  void set_channel(uint8_t ch) { channel_ = ch; }
  void set_fast_fifo_drain(bool en) { fast_fifo_drain_ = en; }

  bool init_radio();
  void reset_hardware();

  uint8_t read_reg(uint8_t reg);
  void write_reg(uint8_t reg, uint8_t val);
  void read_buf(uint8_t reg, uint8_t *buf, size_t len);
  void write_buf(uint8_t reg, const uint8_t *buf, size_t len);

  bool send_frame(const uint8_t *frame, size_t len);
  bool read_rx_packet(RxPacket &pkt);

  SemaphoreHandle_t get_spi_mutex() const { return spi_mutex_; }

 private:
  TadoSPIDevice *spi_{nullptr};
  InternalGPIOPin *rst_pin_{nullptr};
  InternalGPIOPin *dio0_pin_{nullptr};
  uint8_t channel_{26};
  bool fast_fifo_drain_{true};
  SemaphoreHandle_t spi_mutex_{nullptr};
};

} // namespace tado_emulator
} // namespace esphome
