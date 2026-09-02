/**
 * @file radio_sx1276.cpp
 * @brief Implementation of SX1276 sub-GHz transceiver HAL.
 */

#include "radio_sx1276.h"
#include <esphome/core/log.h>
#include <algorithm>

namespace esphome {
namespace tado_emulator {

static const char *const TAG = "tado_radio";

SX1276Radio::SX1276Radio(TadoSPIDevice *spi) : spi_(spi) {
  spi_mutex_ = xSemaphoreCreateMutex();
}

uint8_t SX1276Radio::read_reg(uint8_t reg) {
  if (!spi_) return 0;
  spi_->enable();
  spi_->transfer_byte(reg & 0x7F);
  uint8_t val = spi_->transfer_byte(0x00);
  spi_->disable();
  return val;
}

void SX1276Radio::write_reg(uint8_t reg, uint8_t val) {
  if (!spi_) return;
  spi_->enable();
  spi_->transfer_byte(reg | 0x80);
  spi_->transfer_byte(val);
  spi_->disable();
}

void SX1276Radio::read_buf(uint8_t reg, uint8_t *buf, size_t len) {
  if (!spi_ || !buf || len == 0) return;
  spi_->enable();
  spi_->transfer_byte(reg & 0x7F);
  for (size_t i = 0; i < len; i++) {
    buf[i] = spi_->transfer_byte(0x00);
  }
  spi_->disable();
}

void SX1276Radio::write_buf(uint8_t reg, const uint8_t *buf, size_t len) {
  if (!spi_ || !buf || len == 0) return;
  spi_->enable();
  spi_->transfer_byte(reg | 0x80);
  for (size_t i = 0; i < len; i++) {
    spi_->transfer_byte(buf[i]);
  }
  spi_->disable();
}

void SX1276Radio::reset_hardware() {
  if (rst_pin_ != nullptr) {
    rst_pin_->setup();
    rst_pin_->digital_write(false);
    delay(10);
    rst_pin_->digital_write(true);
    delay(20);
  }
}

bool SX1276Radio::init_radio() {
  if (xSemaphoreTake(spi_mutex_, pdMS_TO_TICKS(500)) != pdTRUE) {
    ESP_LOGE(TAG, "Failed to take SPI mutex during radio init");
    return false;
  }

  reset_hardware();

  uint8_t version = read_reg(REG_VERSION);
  ESP_LOGI(TAG, "SX1276 Silicon Version: 0x%02X", version);
  if (version != 0x12 && version != 0x22) {
    ESP_LOGW(TAG, "Unexpected SX1276 version 0x%02X (expected 0x12)", version);
  }

  // Put in Sleep mode, then FSK mode
  write_reg(REG_OP_MODE, 0x00); // Sleep, FSK
  delay(10);
  write_reg(REG_OP_MODE, 0x01); // STDBY, FSK
  delay(10);

  // Bitrate: 50 kbps (matches native CC110L reference)
  write_reg(REG_BITRATE_MSB, 0x02);
  write_reg(REG_BITRATE_LSB, 0x80);

  // Frequency Deviation: 25 kHz
  write_reg(REG_FDEV_MSB, 0x01);
  write_reg(REG_FDEV_LSB, 0x9A);

  // Carrier Frequency: Channel 26 = 868.323 MHz
  uint32_t f_hz = 863125000UL + ((uint32_t)channel_ * 199951UL);
  uint32_t frf = (uint32_t)((double)f_hz / 61.03515625 + 0.5);
  write_reg(REG_FRF_MSB, (frf >> 16) & 0xFF);
  write_reg(REG_FRF_MID, (frf >> 8) & 0xFF);
  write_reg(REG_FRF_LSB, frf & 0xFF);

  // LNA: Maximum gain + LNA Boost
  write_reg(REG_LNA, 0x23);

  // RX Config: AfcAutoOn, AgcAutoOn, RxTrigger=PreambleDetect+RSSI
  write_reg(REG_RX_CONFIG, 0x1E);

  // Receiver Bandwidth: 100 kHz
  write_reg(REG_RX_BW, 0x0A);
  // AFC Bandwidth: 166.67 kHz
  write_reg(REG_AFC_BW, 0x01);

  // AFC auto-clear on RX start
  write_reg(0x1A, 0x20);
  // RSSI Threshold: -105 dBm
  write_reg(REG_RSSITHRESH, 0xD2);

  // TX Preamble: 4 bytes
  write_reg(0x25, 0x00);
  write_reg(0x26, 0x04);

  // 3-byte preamble detection, tolerance=10
  write_reg(REG_PREAMBLE_DETECT, 0xCA);

  // Sync Word: D3 91 D3 91 (4-byte matches CC110L)
  write_reg(REG_SYNC_CONFIG, 0x73);
  write_reg(REG_SYNC_VALUE_1, 0xD3);
  write_reg(REG_SYNC_VALUE_2, 0x91);
  write_reg(REG_SYNC_VALUE_3, 0xD3);
  write_reg(REG_SYNC_VALUE_4, 0x91);

  // Packet Config: Variable length, CRC ON, CCITT CRC
  write_reg(REG_PACKET_CONFIG_1, 0x99);
  write_reg(REG_PACKET_CONFIG_2, 0x40);
  write_reg(REG_PAYLOAD_LENGTH, 0x7F); // Max 127 bytes

  // PA_BOOST at maximum output power
  write_reg(REG_PA_CONFIG, 0x8F);
  // GFSK shaping BT=1.0
  write_reg(REG_PARAMP, 0x29);
  // Map DIO2 to SyncAddress
  write_reg(REG_DIO_MAPPING_1, 0x0C);
  // FIFO Threshold = 14, TxStartCondition = FIFO Not Empty
  write_reg(REG_FIFO_THRESH, 0x8E);

  // Continuous Receive Mode
  write_reg(REG_OP_MODE, 0x05);

  xSemaphoreGive(spi_mutex_);
  ESP_LOGI(TAG, "SX1276 Transceiver configured on Channel %d (%.3f MHz)", channel_, f_hz / 1e6);
  return true;
}

bool SX1276Radio::send_frame(const uint8_t *frame, size_t len) {
  if (!frame || len == 0 || len > 255) return false;

  if (xSemaphoreTake(spi_mutex_, pdMS_TO_TICKS(100)) != pdTRUE) return false;

  // Defer if actively receiving a frame
  uint32_t defer_start = millis();
  while ((read_reg(REG_IRQ_FLAGS_1) & 0x1A) && (millis() - defer_start < 5)) {
    delayMicroseconds(100);
  }

  // Switch to STDBY
  write_reg(REG_OP_MODE, 0x01);
  delayMicroseconds(150);

  // Flush leftover FIFO bytes
  int flush_count = 0;
  while (!(read_reg(REG_IRQ_FLAGS_2) & 0x40) && flush_count < 64) {
    read_reg(REG_FIFO);
    flush_count++;
  }
  write_reg(REG_IRQ_FLAGS_2, 0x10);

  // Pre-load FIFO with length byte + up to 63 bytes
  if (!spi_) { xSemaphoreGive(spi_mutex_); return false; }
  spi_->enable();
  spi_->transfer_byte(REG_FIFO | 0x80);
  spi_->transfer_byte((uint8_t)len);
  size_t initial_chunk = std::min(len, (size_t)63);
  for (size_t i = 0; i < initial_chunk; i++) {
    spi_->transfer_byte(frame[i]);
  }
  size_t written = initial_chunk;
  spi_->disable();

  // TX mode
  write_reg(REG_OP_MODE, 0x03);

  // Stream remaining bytes into FIFO as space opens.
  // RegIrqFlags2 (0x3F):
  // Bit 5 (0x20) = FifoLevel (1 when > FifoThreshold bytes in FIFO)
  // When FifoLevel is 0, FIFO has at most FifoThreshold (14) bytes.
  // Exactly 64 - 14 = 50 bytes are guaranteed free in the FIFO!
  // Burst-write next chunk (up to 32 bytes) strictly when FifoLevel is 0.
  while (written < len) {
    uint8_t irq2 = read_reg(REG_IRQ_FLAGS_2);

    if (!(irq2 & 0x20)) { // FifoLevel == 0 (<= 14 bytes remaining in FIFO)
      size_t batch = std::min(len - written, (size_t)32);
      spi_->enable();
      spi_->transfer_byte(REG_FIFO | 0x80);
      for (size_t b = 0; b < batch; b++) {
        spi_->transfer_byte(frame[written++]);
      }
      spi_->disable();
    } else {
      // FIFO still has > 14 bytes; wait for transmitter to drain
      delayMicroseconds(20);
    }
  }

  // Wait for PacketSent (irq2 & 0x08)
  uint32_t start_tx = millis();
  while (!(read_reg(REG_IRQ_FLAGS_2) & 0x08)) {
    if (millis() - start_tx > 50) {
      ESP_LOGW(TAG, "SX1276 TX timeout");
      break;
    }
    delayMicroseconds(50);
  }

  // Clear PacketSent and return to Continuous RX
  write_reg(REG_IRQ_FLAGS_2, 0x08);
  write_reg(REG_OP_MODE, 0x05);

  xSemaphoreGive(spi_mutex_);
  return true;
}

bool SX1276Radio::read_rx_packet(RxPacket &pkt) {
  if (xSemaphoreTake(spi_mutex_, pdMS_TO_TICKS(5)) != pdTRUE) return false;

  uint8_t irq1 = read_reg(REG_IRQ_FLAGS_1);
  uint8_t irq2 = read_reg(REG_IRQ_FLAGS_2);

  if (irq2 & 0x10) { // FifoOverrun
    write_reg(REG_IRQ_FLAGS_2, 0x10);
    write_reg(REG_RX_CONFIG, 0x5E);
    xSemaphoreGive(spi_mutex_);
    return false;
  }

  if (irq2 & 0x40) { // FifoEmpty
    xSemaphoreGive(spi_mutex_);
    return false;
  }

  // Read length byte
  uint8_t len = read_reg(REG_FIFO);
  if (len == 0 || len > 128) {
    // Corrupt length, flush FIFO
    int fl = 0;
    while (!(read_reg(REG_IRQ_FLAGS_2) & 0x40) && fl < 64) {
      read_reg(REG_FIFO);
      fl++;
    }
    write_reg(REG_IRQ_FLAGS_2, 0x10);
    xSemaphoreGive(spi_mutex_);
    return false;
  }

  pkt.length = len;
  pkt.timestamp_ms = millis();
  pkt.rssi = -(int16_t)(read_reg(REG_RSSIVALUE) / 2);

  size_t bytes_read = 0;
  uint32_t start_drain = millis();
  while (bytes_read < len) {
    if (!(read_reg(REG_IRQ_FLAGS_2) & 0x40)) {
      pkt.data[bytes_read++] = read_reg(REG_FIFO);
    } else {
      if (millis() - start_drain > 15) break;
      delayMicroseconds(50);
    }
  }

  write_reg(REG_IRQ_FLAGS_2, 0x10); // Clear FIFO flags
  xSemaphoreGive(spi_mutex_);
  return (bytes_read == len);
}

} // namespace tado_emulator
} // namespace esphome
