/**
 * @file ru_state_machine.h
 * @brief Room Unit event-driven finite state machine.
 */

#pragma once

#include "rf_protocol.h"
#include <string>
#include <vector>

namespace esphome {
namespace tado_emulator {

enum RUState : uint8_t {
  STATE_UNASSOCIATED = 0,
  STATE_PAIR_BROADCAST_RS = 1,
  STATE_PAIR_UNICAST_RS = 2,
  STATE_PAIRING_TOKEN = 3,
  STATE_ONBOARD_FW_STATE = 4,
  STATE_ONBOARD_CONFIG = 5,
  STATE_ONBOARD_ACT = 6,
  STATE_ONBOARD_ERR = 7,
  STATE_ONBOARD_SEN = 8,
  STATE_OPERATIONAL = 9,
  STATE_FAILED = 10
};

// RFC 7252 §4.2 CON retransmission entry
struct PendingCON {
  uint16_t mid{0};
  std::vector<uint8_t> frame;
  uint32_t next_tx_ms{0};
  uint32_t timeout_ms{2000};  // ACK_TIMEOUT = 2s, doubles each retry
  uint8_t retries{0};
  static constexpr uint8_t MAX_RETRANSMIT = 4;
};

struct EmulatedDeviceConfig {
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
  RUState state{STATE_UNASSOCIATED};
  uint8_t ib_mac[8]{0};
  bool ib_mac_known{false};

  // Cached sensor telemetry values
  float target_temp_celsius{21.5f};
  float target_humidity_pct{50.0f};
  uint16_t target_battery_mv{4500};     // 3xAAA nominal full = 4500 mV
  uint16_t target_ambient_light{6249};
  bool child_lock{false};

  // Timing and Sequence Tracking
  uint8_t seq_num{1};
  uint16_t coap_mid{0x4000};
  uint32_t last_telemetry_ts{0};
  uint32_t last_pair_tx_time_{0};
  uint8_t pair_tx_count_{0};
  uint32_t idle_fallback_s{900};        // 15 minutes idle fallback interval

  // CON retransmission queue (RFC 7252 §4.2)
  std::vector<PendingCON> pending_cons;

  uint16_t short_addr{0};

  void derive_short_addr() {
    short_addr = mac_addr[0] | ((uint16_t)mac_addr[1] << 8);
  }
};

class RUStateMachine {
 public:
  explicit RUStateMachine(const EmulatedDeviceConfig &cfg);

  const EmulatedDeviceConfig &get_config() const { return config_; }
  EmulatedDeviceConfig &get_config_mut() { return config_; }

  // High-level command triggers
  void trigger_telemetry(float temp_c, float hum_pct, uint16_t battery_mv,
                         std::vector<std::vector<uint8_t>> &outbound_frames);
  void trigger_pairing(std::vector<std::vector<uint8_t>> &outbound_frames);

  // Periodic tick (checks idle fallback and pairing retransmissions)
  void tick(uint32_t now_ms, uint32_t now_s, std::vector<std::vector<uint8_t>> &outbound_frames);

  // Inbound packet dispatch
  void process_inbound_decrypted(const ParsedMac &mac, const uint8_t *decrypted, size_t len,
                                 std::vector<std::vector<uint8_t>> &outbound_frames,
                                 const uint8_t *rx_key = nullptr);
  void process_csl_strobe(uint8_t strobe_seq, uint16_t dst_short, uint16_t countdown,
                          std::vector<std::vector<uint8_t>> &outbound_frames);

  // Frame building helpers
  std::vector<uint8_t> build_encrypted_coap_frame(uint8_t type, uint8_t code, const std::string &path,
                                                  const uint8_t *payload, size_t payload_len,
                                                  const uint8_t *dest_mac = nullptr,
                                                  int32_t block2_num = -1, uint8_t block2_szx = 4);
  std::vector<uint8_t> build_encrypted_icmp_frame(const std::vector<uint8_t> &pt_icmp,
                                                  const uint8_t *dest_mac = nullptr,
                                                  const uint8_t *key_override = nullptr);

 private:
  EmulatedDeviceConfig config_;

  void handle_coap_message(const ParsedCoAP &coap, const ParsedMac &mac,
                           std::vector<std::vector<uint8_t>> &outbound_frames,
                           const uint8_t *rx_key = nullptr);
  void begin_onboarding(std::vector<std::vector<uint8_t>> &outbound_frames);
  void advance_onboarding(std::vector<std::vector<uint8_t>> &outbound_frames);
};

} // namespace tado_emulator
} // namespace esphome
