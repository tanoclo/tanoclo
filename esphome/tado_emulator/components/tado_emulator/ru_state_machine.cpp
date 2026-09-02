/**
 * @file ru_state_machine.cpp
 * @brief Implementation of Room Unit event-driven finite state machine.
 */

#include "ru_state_machine.h"
#include <esp_timer.h>
#include <esphome/core/log.h>

namespace esphome {
namespace tado_emulator {

static const char *const TAG = "tado_ru_fsm";

RUStateMachine::RUStateMachine(const EmulatedDeviceConfig &cfg) : config_(cfg) {
  config_.derive_short_addr();
}

void RUStateMachine::trigger_telemetry(float temp_c, float hum_pct, uint16_t battery_mv,
                                      std::vector<std::vector<uint8_t>> &outbound_frames) {
  config_.target_temp_celsius = temp_c;
  config_.target_humidity_pct = hum_pct;
  config_.target_battery_mv = battery_mv;
  config_.last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);

  ESP_LOGI(TAG, "[%s] Trigger telemetry: temp=%.2fC hum=%.1f%% bat=%dmV",
           config_.serial_no.c_str(), temp_c, hum_pct, battery_mv);

  std::vector<uint8_t> tlv = protocol::build_d_sen_tlv(temp_c, hum_pct, battery_mv,
                                                      config_.target_ambient_light, 0, 0);

  std::string path = "d/" + config_.serial_no + "/sen";
  std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT, path,
                                                          tlv.data(), tlv.size(), config_.ib_mac);
  if (!frame.empty()) {
    outbound_frames.push_back(frame);
  }

  // If measuring leader, also emit zone periodic measurement
  if (config_.is_measuring_leader) {
    std::vector<uint8_t> z_tlv = protocol::build_z_p_tlv(temp_c, hum_pct);
    std::vector<uint8_t> z_frame = build_encrypted_coap_frame(COAP_TYPE_NON, COAP_CODE_PUT, "z/p",
                                                             z_tlv.data(), z_tlv.size(), config_.ib_mac);
    if (!z_frame.empty()) {
      outbound_frames.push_back(z_frame);
    }
  }
}

void RUStateMachine::trigger_pairing(std::vector<std::vector<uint8_t>> &outbound_frames) {
  config_.state = STATE_PAIR_BROADCAST_RS;
  config_.pair_tx_count_ = 0;
  config_.last_pair_tx_time_ = 0;
  config_.pending_cons.clear();

  // Must discover bridge via Broadcast Router Solicitation
  config_.ib_mac_known = false;
  std::memset(config_.ib_mac, 0, 8);

  ESP_LOGI(TAG, "[%s] trigger_pairing: Emitting broadcast Router Solicitation (RS)", config_.serial_no.c_str());
  std::vector<uint8_t> rs_pt = protocol::build_router_solicitation(config_.mac_addr, nullptr);
  std::vector<uint8_t> frame = build_encrypted_icmp_frame(rs_pt, nullptr);
  if (!frame.empty()) {
    outbound_frames.push_back(frame);
  }
}

void RUStateMachine::tick(uint32_t now_ms, uint32_t now_s, std::vector<std::vector<uint8_t>> &outbound_frames) {
  // 0. CON retransmission engine (RFC 7252 §4.2) — runs in ALL states
  for (auto it = config_.pending_cons.begin(); it != config_.pending_cons.end(); ) {
    if (now_ms >= it->next_tx_ms) {
      if (it->retries >= PendingCON::MAX_RETRANSMIT) {
        ESP_LOGW(TAG, "[%s] CON MID=0x%04X failed after %d retries",
                 config_.serial_no.c_str(), it->mid, it->retries);
        it = config_.pending_cons.erase(it);
        continue;
      }
      outbound_frames.push_back(it->frame);
      it->retries++;
      it->timeout_ms *= 2;  // Exponential backoff
      it->next_tx_ms = now_ms + it->timeout_ms;
      ESP_LOGD(TAG, "[%s] CON retransmit MID=0x%04X retry=%d next_in=%u ms",
               config_.serial_no.c_str(), it->mid, it->retries, (unsigned)it->timeout_ms);
      ++it;
    } else {
      ++it;
    }
  }

  // 1. Operational State: Idle Heartbeat Fallback
  if (config_.state == STATE_OPERATIONAL) {
    if (config_.last_telemetry_ts == 0) {
      config_.last_telemetry_ts = now_s;
    } else if (now_s - config_.last_telemetry_ts >= config_.idle_fallback_s) {
      // Idle fallback triggered! Transmit heartbeat with cached values
      trigger_telemetry(config_.target_temp_celsius, config_.target_humidity_pct,
                        config_.target_battery_mv, outbound_frames);
    }
    return;
  }

  // 2. Commissioning State: Discovery Phase (Broadcast RS every 2.5s)
  if (config_.state == STATE_PAIR_BROADCAST_RS) {
    if (now_ms - config_.last_pair_tx_time_ >= 2500) {
      config_.last_pair_tx_time_ = now_ms;
      config_.pair_tx_count_++;
      std::vector<uint8_t> rs_pt = protocol::build_router_solicitation(config_.mac_addr, nullptr);
      std::vector<uint8_t> frame = build_encrypted_icmp_frame(rs_pt, nullptr);
      if (!frame.empty()) outbound_frames.push_back(frame);

      if (config_.pair_tx_count_ >= 30) {
        config_.state = STATE_FAILED;
      }
    }
    return;
  }

  // 3. Unicast Phase: Unicast Echo Request (every 2.0s)
  if (config_.state == STATE_PAIR_UNICAST_RS) {
    if (now_ms - config_.last_pair_tx_time_ >= 2000) {
      config_.last_pair_tx_time_ = now_ms;
      config_.pair_tx_count_++;
      // Ping IB directly with ICMPv6 Echo Request
      std::vector<uint8_t> ping_body = {0x00, 0x01, 0x00, 0x01};
      std::vector<uint8_t> echo_pt = protocol::build_echo_request(0x1234, config_.pair_tx_count_,
                                                                 ping_body.data(), ping_body.size(),
                                                                 config_.mac_addr, config_.ib_mac);
      std::vector<uint8_t> frame = build_encrypted_icmp_frame(echo_pt, config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(frame);

      if (config_.pair_tx_count_ >= 30) {
        config_.state = STATE_FAILED;
      }
    }
    return;
  }

  // 4. Pairing Phase: Send POST auth/token (every 2.5s)
  if (config_.state == STATE_PAIRING_TOKEN) {
    if (now_ms - config_.last_pair_tx_time_ >= 2500) {
      config_.last_pair_tx_time_ = now_ms;
      config_.pair_tx_count_++;

      // 0x0260 (serial string) + 0x0007 (16-byte nonce challenge)
      std::vector<uint8_t> tlv;
      protocol::append_tlv_string(tlv, 0x0260, config_.serial_no);
      uint8_t nonce[16];
      for (int i = 0; i < 16; i++) nonce[i] = (uint8_t)rand();
      protocol::append_tlv_bytes(tlv, TLV_CLIENT_NONCE, nonce, 16);

      std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_POST, "auth/token",
                                                              tlv.data(), tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(frame);

      if (config_.pair_tx_count_ >= 30) {
        config_.state = STATE_FAILED;
      }
    }
    return;
  }

  // 5. Onboarding states: handled by CON retransmission engine above.
  //    Each state emits its initial CON in the transition handler, then
  //    the retransmission engine handles retries. ACK receipt advances state.
}

void RUStateMachine::process_inbound_decrypted(const ParsedMac &mac, const uint8_t *decrypted, size_t len,
                                              std::vector<std::vector<uint8_t>> &outbound_frames,
                                              const uint8_t *rx_key) {
  if (!decrypted || len < 4) return;

  // 1. Check for ICMPv6
  ParsedICMPv6 icmp;
  if (protocol::parse_icmpv6(decrypted, len, icmp)) {
    if (icmp.type == ICMPV6_TYPE_ECHO_REQUEST) {
      // Immediate Echo Reply (129)
      std::vector<uint8_t> reply_pt = protocol::build_echo_reply(icmp.identifier, icmp.sequence,
                                                                icmp.body.data(), icmp.body.size(),
                                                                config_.mac_addr, mac.src_mac);
      std::vector<uint8_t> frame = build_encrypted_icmp_frame(reply_pt, mac.src_mac, rx_key);
      if (!frame.empty()) outbound_frames.push_back(frame);
    } else if (icmp.type == ICMPV6_TYPE_ROUTER_ADVERT) {
      if (config_.state == STATE_PAIR_BROADCAST_RS) {
        std::memcpy(config_.ib_mac, mac.src_mac, 8);
        config_.ib_mac_known = true;
        config_.state = STATE_PAIR_UNICAST_RS;
        config_.pair_tx_count_ = 0;
        config_.last_pair_tx_time_ = 0;
        ESP_LOGI(TAG, "[%s] Received Router Advertisement from IB! Moving to STATE_PAIR_UNICAST_RS",
                 config_.serial_no.c_str());
      }
    } else if (icmp.type == ICMPV6_TYPE_NEIGHBOR_SOLICIT) {
      // Immediate Neighbor Advertisement (136)
      std::vector<uint8_t> na_pt = protocol::build_neighbor_advertisement(config_.mac_addr, mac.src_mac);
      std::vector<uint8_t> frame = build_encrypted_icmp_frame(na_pt, mac.src_mac, rx_key);
      if (!frame.empty()) outbound_frames.push_back(frame);
      ESP_LOGI(TAG, "[%s] Received Neighbor Solicitation from IB! Responded with Neighbor Advertisement (NA)",
               config_.serial_no.c_str());
    }
    return;
  }

  // 2. Check for CoAP
  uint16_t src_port = 5683, dst_port = 5683;
  int coap_off = protocol::find_coap_offset(decrypted, len, &src_port, &dst_port);
  if (coap_off != -1) {
    ParsedCoAP coap = protocol::parse_coap(decrypted + coap_off, len - coap_off);
    if (coap.ok) {
      coap.src_port = src_port;
      coap.dst_port = dst_port;
      handle_coap_message(coap, mac, outbound_frames, rx_key);
    }
  }
}

void RUStateMachine::process_csl_strobe(uint8_t strobe_seq, uint16_t dst_short, uint16_t countdown,
                                      std::vector<std::vector<uint8_t>> &outbound_frames) {
  if (config_.state != STATE_OPERATIONAL) return;
  if (config_.short_addr != dst_short) return;

  // Emit CSL Data Poll when strobe is near completion
  if (countdown <= 0x0040) {
    std::vector<uint8_t> poll = protocol::build_csl_data_poll(strobe_seq, dst_short,
                                                             config_.mac_addr, dst_short);
    outbound_frames.push_back(poll);
  }
}

void RUStateMachine::handle_coap_message(const ParsedCoAP &coap, const ParsedMac &mac,
                                         std::vector<std::vector<uint8_t>> &outbound_frames,
                                         const uint8_t *rx_key) {
  // ACK matching: cancel pending CON on any ACK/response matching MID
  if (coap.type == COAP_TYPE_ACK || coap.code >= 0x40) {
    for (auto it = config_.pending_cons.begin(); it != config_.pending_cons.end(); ++it) {
      if (it->mid == coap.mid) {
        ESP_LOGI(TAG, "[%s] ACK received for CON MID=0x%04X (state=%d)",
                 config_.serial_no.c_str(), coap.mid, config_.state);
        config_.pending_cons.erase(it);
        break;
      }
    }
  }

  // Case 1: Inbound POST /d/pair (Bridge pushing network credentials)
  if (coap.code == COAP_CODE_POST && coap.uri_path == "d/pair") {
    // Learn IB MAC from the bridge
    std::memcpy(config_.ib_mac, mac.src_mac, 8);
    config_.ib_mac_known = true;

    // Use 1-byte TLV parser with fallback to 2-byte
    auto tlvs = protocol::parse_tlvs_1byte(coap.payload.data(), coap.payload.size());
    if (tlvs.empty()) {
      tlvs = protocol::parse_tlvs(coap.payload.data(), coap.payload.size());
    }
    for (const auto &t : tlvs) {
      if ((t.tag == TLV_PAIRING_RAW_OP_KEY || t.tag == 0x0012 || t.tag == 0x12) && t.value.size() == 16) {
        // Plaintext operational key push (TLV 0x12)
        std::memcpy(config_.op_key, t.value.data(), 16);
        config_.has_op_key = true;
        ESP_LOGI(TAG, "[%s] Received plaintext OP_KEY from POST /d/pair (tag=0x%02X)",
                 config_.serial_no.c_str(), (uint8_t)t.tag);
      } else if ((t.tag == 0x0007 || t.tag == 0x07 || t.tag == TLV_REPORTED_RF_KEY) && t.value.size() == 16) {
        // Encrypted operational key push with factory key (TLV 0x07 via AES-128-ECB)
        if (config_.has_factory_key) {
          protocol::decrypt_aes128_ecb(t.value.data(), config_.factory_key, config_.op_key);
          config_.has_op_key = true;
          ESP_LOGI(TAG, "[%s] Decrypted OP_KEY from POST /d/pair using factory key", config_.serial_no.c_str());
        } else {
          std::memcpy(config_.op_key, t.value.data(), 16);
          config_.has_op_key = true;
        }
      }
    }

    // Also check if bridge sent session token in Option 2048 on POST /d/pair
    for (const auto &opt : coap.options) {
      if (opt.num == COAP_OPT_SESSION_TOKEN && opt.value.size() >= 4) {
        size_t tok_len = std::min((size_t)8, opt.value.size());
        std::memset(config_.session_token, 0, 8);
        std::memcpy(config_.session_token, opt.value.data(), tok_len);
        config_.has_session_token = true;
        break;
      }
    }

    // Reply with 2.04 Changed ACK using the key that encrypted the request
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E);
    std::vector<uint8_t> frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) outbound_frames.push_back(frame);

    // Re-entry guard: If already onboarding or operational, do NOT restart onboarding
    if (config_.state >= STATE_ONBOARD_FW_STATE) {
      ESP_LOGI(TAG, "[%s] Retransmitted 2.04 ACK for duplicate POST /d/pair (state=%d)",
               config_.serial_no.c_str(), config_.state);
      return;
    }

    if (config_.has_session_token) {
      // Skip auth/token, go directly to onboarding
      begin_onboarding(outbound_frames);
      return;
    }

    config_.state = STATE_PAIRING_TOKEN;
    config_.pair_tx_count_ = 0;
    config_.last_pair_tx_time_ = 0;
    ESP_LOGI(TAG, "[%s] Received POST /d/pair with op_key! Moving to STATE_PAIRING_TOKEN", config_.serial_no.c_str());
    return;
  }

  // Case 2: Inbound 2.05 Content response (e.g. session token for /auth/token)
  if (coap.code == COAP_CODE_CONTENT) {
    if (config_.state == STATE_PAIRING_TOKEN) {
      bool got_token = false;
      // Check Option 2048 (COAP_OPT_SESSION_TOKEN)
      for (const auto &opt : coap.options) {
        if (opt.num == COAP_OPT_SESSION_TOKEN && opt.value.size() >= 4) {
          size_t tok_len = std::min((size_t)8, opt.value.size());
          std::memset(config_.session_token, 0, 8);
          std::memcpy(config_.session_token, opt.value.data(), tok_len);
          config_.has_session_token = true;
          got_token = true;
          break;
        }
      }
      if (!got_token) {
        auto tlvs = protocol::parse_tlvs(coap.payload.data(), coap.payload.size());
        for (const auto &t : tlvs) {
          if (t.tag == 0x025E && t.value.size() >= 4) { // Session Token (TLV 0x025E)
            size_t tok_len = std::min((size_t)8, t.value.size());
            std::memset(config_.session_token, 0, 8);
            std::memcpy(config_.session_token, t.value.data(), tok_len);
            config_.has_session_token = true;
            got_token = true;
            break;
          }
        }
      }

      if (got_token) {
        begin_onboarding(outbound_frames);
      }
    }
    // Also handle GET /d/{serial}/config response during onboarding
    if (config_.state == STATE_ONBOARD_CONFIG) {
      // Config received, advance to actuator state
      advance_onboarding(outbound_frames);
    }
    return;
  }

  // Case 3: ACK for onboarding CON requests
  if (coap.type == COAP_TYPE_ACK && (coap.code == COAP_CODE_CHANGED || coap.code == COAP_CODE_EMPTY)) {
    if (config_.state >= STATE_ONBOARD_FW_STATE && config_.state <= STATE_ONBOARD_SEN) {
      advance_onboarding(outbound_frames);
      return;
    }
  }

  // Case 4: Inbound GET /time or /t
  if (coap.code == COAP_CODE_GET && (coap.uri_path == "time" || coap.uri_path == "t")) {
    uint32_t now_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    std::vector<uint8_t> time_tlv;
    protocol::append_tlv_u32(time_tlv, TLV_TIME_UTC, now_s);
    protocol::append_tlv_s16(time_tlv, TLV_TIME_TZ_OFFSET, 60); // UTC+1 (60 min)
    std::vector<uint8_t> ack_coap = protocol::serialize_coap(COAP_TYPE_ACK, COAP_CODE_CONTENT, coap.mid,
                                                            coap.token.data(), coap.token.size(), "",
                                                            time_tlv.data(), time_tlv.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E);
    std::vector<uint8_t> frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) outbound_frames.push_back(frame);
    return;
  }

  // Case 5: Inbound PUT /d/lock (Child Lock)
  if (coap.code == COAP_CODE_PUT && (coap.uri_path == "d/lock" || coap.uri_path.find("/lock") != std::string::npos)) {
    auto tlvs = protocol::parse_tlvs(coap.payload.data(), coap.payload.size());
    for (const auto &t : tlvs) {
      if (t.tag == TLV_CHILD_LOCK && !t.value.empty()) {
        config_.child_lock = (t.value[0] != 0);
      }
    }
    // Reply with 2.04 Changed ACK
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E);
    std::vector<uint8_t> frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) outbound_frames.push_back(frame);
    return;
  }

  // Case 6: Standard CON request requiring empty 2.04 Changed ACK
  if (coap.type == COAP_TYPE_CON) {
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E);
    std::vector<uint8_t> frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) outbound_frames.push_back(frame);
  }
}

std::vector<uint8_t> RUStateMachine::build_encrypted_coap_frame(uint8_t type, uint8_t code, const std::string &path,
                                                               const uint8_t *payload, size_t payload_len,
                                                               const uint8_t *dest_mac,
                                                               int32_t block2_num, uint8_t block2_szx) {
  uint16_t mid = config_.coap_mid++;
  const uint8_t *tok_ptr = (path != "auth/token" && config_.has_session_token) ? config_.session_token : nullptr;

  std::vector<uint8_t> coap = protocol::serialize_coap(type, code, mid, nullptr, 0, path,
                                                      payload, payload_len, tok_ptr,
                                                      block2_num, block2_szx);

  const uint8_t *dst = dest_mac ? dest_mac : (config_.ib_mac_known ? config_.ib_mac : nullptr);
  uint8_t dispatch_mode = 0x7E;
  std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(coap.data(), coap.size(),
                                                             config_.mac_addr, dst,
                                                             5683, 4005, dispatch_mode);

  uint8_t seq = config_.seq_num++;
  std::vector<uint8_t> hdr = protocol::build_mac_header(seq, config_.mac_addr, dst, (type == COAP_TYPE_CON));

  const uint8_t *key = config_.has_op_key ? config_.op_key : PAIRING_KEY;
  std::vector<uint8_t> frame = protocol::encrypt_ccm(hdr.data(), pt.data(), pt.size(), key);

  // Track CON frames for retransmission
  if (type == COAP_TYPE_CON && !frame.empty()) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    PendingCON pending;
    pending.mid = mid;
    pending.frame = frame;
    pending.timeout_ms = 2000;
    pending.next_tx_ms = now_ms + pending.timeout_ms; // First retry after ACK_TIMEOUT
    pending.retries = 0;
    config_.pending_cons.push_back(pending);
  }

  return frame;
}

std::vector<uint8_t> RUStateMachine::build_encrypted_icmp_frame(const std::vector<uint8_t> &pt_icmp,
                                                                const uint8_t *dest_mac,
                                                                const uint8_t *key_override) {
  const uint8_t *dst = dest_mac ? dest_mac : (config_.ib_mac_known ? config_.ib_mac : nullptr);
  bool is_unicast = (dst != nullptr && !(dst[0] == 0xFF && dst[7] == 0xFF));
  uint8_t seq = config_.seq_num++;
  // Unicast frames to IB request hardware MAC ACK (0x69EC), broadcast frames do not (0x49E8)
  std::vector<uint8_t> hdr = protocol::build_mac_header(seq, config_.mac_addr, dst, is_unicast);

  const uint8_t *key = key_override ? key_override : ((config_.state >= STATE_ONBOARD_FW_STATE && config_.has_op_key) ? config_.op_key : PAIRING_KEY);
  return protocol::encrypt_ccm(hdr.data(), pt_icmp.data(), pt_icmp.size(), key);
}

void RUStateMachine::begin_onboarding(std::vector<std::vector<uint8_t>> &outbound_frames) {
  config_.state = STATE_ONBOARD_FW_STATE;
  config_.last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);
  config_.pending_cons.clear();

  ESP_LOGI(TAG, "[%s] Starting onboarding sequence (fw/state -> config -> act -> err -> sen)",
           config_.serial_no.c_str());

  // Stage 1: PUT /d/{serial}/fw/state (CON)
  std::vector<uint8_t> fw_tlv = protocol::build_d_fw_state_tlv(13762, 13059, "c54baf8");
  std::string fw_path = "d/" + config_.serial_no + "/fw/state";
  std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT, fw_path,
                                                          fw_tlv.data(), fw_tlv.size(), config_.ib_mac);
  if (!frame.empty()) outbound_frames.push_back(frame);
}

void RUStateMachine::advance_onboarding(std::vector<std::vector<uint8_t>> &outbound_frames) {
  std::string base_path = "d/" + config_.serial_no;

  switch (config_.state) {
    case STATE_ONBOARD_FW_STATE: {
      // fw/state ACK received → GET /d/{serial}/config
      config_.state = STATE_ONBOARD_CONFIG;
      ESP_LOGI(TAG, "[%s] Onboard: fw/state ACKed → GET config", config_.serial_no.c_str());
      std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_GET,
                                                              base_path + "/config",
                                                              nullptr, 0, config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(frame);
      break;
    }
    case STATE_ONBOARD_CONFIG: {
      // config response received → PUT /d/{serial}/act
      config_.state = STATE_ONBOARD_ACT;
      ESP_LOGI(TAG, "[%s] Onboard: config received → PUT act", config_.serial_no.c_str());
      std::vector<uint8_t> act_tlv;
      protocol::append_tlv_u8(act_tlv, TLV_ACTUATOR_ACTIVE, 0);
      std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT,
                                                              base_path + "/act",
                                                              act_tlv.data(), act_tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(frame);
      break;
    }
    case STATE_ONBOARD_ACT: {
      // act ACK received → PUT /d/{serial}/err
      config_.state = STATE_ONBOARD_ERR;
      ESP_LOGI(TAG, "[%s] Onboard: act ACKed → PUT err", config_.serial_no.c_str());
      std::vector<uint8_t> err_tlv;
      protocol::append_tlv_u32(err_tlv, 0x01a3, 0); // Error flags = 0 (no errors)
      std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT,
                                                              base_path + "/err",
                                                              err_tlv.data(), err_tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(frame);
      break;
    }
    case STATE_ONBOARD_ERR: {
      // err ACK received → PUT /d/{serial}/sen (initial telemetry)
      config_.state = STATE_ONBOARD_SEN;
      ESP_LOGI(TAG, "[%s] Onboard: err ACKed → PUT sen (initial telemetry)", config_.serial_no.c_str());
      std::vector<uint8_t> sen_tlv = protocol::build_d_sen_tlv(
          config_.target_temp_celsius, config_.target_humidity_pct,
          config_.target_battery_mv, config_.target_ambient_light, 0, 0);
      std::vector<uint8_t> frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT,
                                                              base_path + "/sen",
                                                              sen_tlv.data(), sen_tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(frame);
      break;
    }
    case STATE_ONBOARD_SEN: {
      // sen ACK received → OPERATIONAL
      config_.state = STATE_OPERATIONAL;
      config_.last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);
      config_.pending_cons.clear();
      ESP_LOGI(TAG, "[%s] Onboarding complete! STATE_OPERATIONAL", config_.serial_no.c_str());
      break;
    }
    default:
      break;
  }
}

} // namespace tado_emulator
} // namespace esphome
