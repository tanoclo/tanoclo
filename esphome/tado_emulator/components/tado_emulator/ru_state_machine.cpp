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
                                      std::vector<OutboundFrame> &outbound_frames) {
  config_.target_temp_celsius = temp_c;
  config_.target_humidity_pct = hum_pct;
  config_.target_battery_mv = battery_mv;
  config_.last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);

  ESP_LOGI(TAG, "[%s] Trigger telemetry: temp=%.2fC hum=%.1f%% bat=%dmV",
           config_.serial_no.c_str(), temp_c, hum_pct, battery_mv);

  std::vector<uint8_t> tlv = protocol::build_d_sen_tlv(temp_c, hum_pct, battery_mv,
                                                      config_.target_ambient_light, 0, 0);

  std::string path = "d/" + config_.serial_no + "/sen";
  OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT, path,
                                                  tlv.data(), tlv.size(), config_.ib_mac);
  if (!frame.empty()) {
    outbound_frames.push_back(std::move(frame));
  }

  // If measuring leader, also emit zone periodic measurement
  if (config_.is_measuring_leader) {
    std::vector<uint8_t> z_tlv = protocol::build_z_p_tlv(temp_c, hum_pct);
    OutboundFrame z_frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT, "z/p",
                                                      z_tlv.data(), z_tlv.size(), config_.ib_mac);
    if (!z_frame.empty()) {
      outbound_frames.push_back(std::move(z_frame));
    }
  }
}

void RUStateMachine::trigger_pairing(std::vector<OutboundFrame> &outbound_frames) {
  config_.state = STATE_PAIR_BROADCAST_RS;
  config_.pair_tx_count_ = 0;
  config_.last_pair_tx_time_ = 0;
  config_.pending_cons.clear();

  // Must discover bridge via Broadcast Router Solicitation
  config_.ib_mac_known = false;
  std::memset(config_.ib_mac, 0, 8);

  ESP_LOGI(TAG, "[%s] trigger_pairing: Emitting broadcast Router Solicitation (RS)", config_.serial_no.c_str());
  std::vector<uint8_t> rs_pt = protocol::build_router_solicitation(config_.mac_addr, nullptr);
  OutboundFrame frame = build_encrypted_icmp_frame(rs_pt, nullptr);
  if (!frame.empty()) {
    outbound_frames.push_back(std::move(frame));
  }
}

void RUStateMachine::tick(uint32_t now_ms, uint32_t now_s, std::vector<OutboundFrame> &outbound_frames) {
  // Periodic cleanup of acknowledged requests and pending response ACKs
  for (auto it = mac_acked_requests_.begin(); it != mac_acked_requests_.end(); ) {
    if (now_ms - it->timestamp_ms > 60000) {
      it = mac_acked_requests_.erase(it);
    } else {
      ++it;
    }
  }
  for (auto it = pending_response_acks_.begin(); it != pending_response_acks_.end(); ) {
    if (now_ms - it->timestamp_ms > 60000) {
      it = pending_response_acks_.erase(it);
    } else {
      ++it;
    }
  }

  // Purge expired 6LoWPAN fragment reassembly context (timeout ~120s)
  if (fragment_reassembly_.active) {
    uint32_t elapsed = (now_ms >= fragment_reassembly_.timestamp_ms) ?
                       (now_ms - fragment_reassembly_.timestamp_ms) : 0;
    if (elapsed > 120000) {
      ESP_LOGW(TAG, "[%s] 6LoWPAN fragment reassembly timed out (tag=0x%04X, uncomp=%u, elapsed=%u ms) -> Purged",
               config_.serial_no.c_str(), fragment_reassembly_.tag,
               (unsigned)fragment_reassembly_.uncompressed_size, (unsigned)elapsed);
      fragment_reassembly_ = SixLoWPANReassembly{};
    }
  }

  // 0. CON retransmission engine (RFC 7252 §4.2) — runs in ALL states
  for (auto it = config_.pending_cons.begin(); it != config_.pending_cons.end(); ) {
    if (it->mac_confirmed) {
      // MAC confirmed delivery over RF; suppress RF retransmissions while waiting for upstream response
      ++it;
      continue;
    }
    if (now_ms >= it->next_tx_ms) {
      if (it->retries >= PendingCON::MAX_RETRANSMIT) {
        ESP_LOGW(TAG, "[%s] CON MID=0x%04X failed after %d retries",
                 config_.serial_no.c_str(), it->mid, it->retries);
        it = config_.pending_cons.erase(it);
        continue;
      }
      outbound_frames.emplace_back(it->frame, it->fc, it->seq);
      it->retries++;
      it->timeout_ms *= 2;  // Exponential backoff
      it->next_tx_ms = now_ms + it->timeout_ms;
      ESP_LOGD(TAG, "[%s] TX CoAP retransmit seq=%u fc=%lu mid=0x%04X path='%s' retry=%d next_in=%u ms",
               config_.serial_no.c_str(), it->seq, (unsigned long)it->fc, it->mid, it->path.c_str(),
               it->retries, (unsigned)it->timeout_ms);
      ++it;
    } else {
      ++it;
    }
  }

  // 1. Operational State: Idle Heartbeat Fallback & Periodic NA keepalive
  if (config_.state == STATE_OPERATIONAL) {
    // Operational keepalive managed via periodic telemetry (/sen) and responding to IB NS/pings

    if (config_.last_telemetry_ts == 0) {
      config_.last_telemetry_ts = now_s;
    } else if (now_s - config_.last_telemetry_ts >= config_.idle_fallback_s) {
      // Idle fallback triggered. Transmit heartbeat with cached values
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
      OutboundFrame frame = build_encrypted_icmp_frame(rs_pt, nullptr);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));

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
                                                                 config_.mac_addr, config_.ib_mac,
                                                                 config_.frame_counter++);
      OutboundFrame frame = build_encrypted_icmp_frame(echo_pt, config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));

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

      OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_POST, "auth/token",
                                                              tlv.data(), tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));

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
                                              std::vector<OutboundFrame> &outbound_frames,
                                              const uint8_t *rx_key) {
  if (!decrypted || len < 4) return;

  // 1. Check for ICMPv6
  ParsedICMPv6 icmp;
  if (protocol::parse_icmpv6(decrypted, len, icmp)) {
    if (icmp.type == ICMPV6_TYPE_ECHO_REQUEST) {
      // Immediate Echo Reply (129)
      uint32_t reply_fc = config_.frame_counter++;
      std::vector<uint8_t> reply_pt = protocol::build_echo_reply(icmp.identifier, icmp.sequence,
                                                                icmp.body.data(), icmp.body.size(),
                                                                config_.mac_addr, mac.src_mac,
                                                                reply_fc);
      OutboundFrame frame = build_encrypted_icmp_frame(reply_pt, mac.src_mac, rx_key);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));
      ESP_LOGI(TAG, "[%s] RX ICMPv6 Echo Request (id=0x%04X, seq=%u) -> TX Echo Reply (fc=%lu)",
               config_.serial_no.c_str(), icmp.identifier, icmp.sequence, (unsigned long)reply_fc);
      uint32_t now_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
      config_.last_telemetry_ts = now_s;
    } else if (icmp.type == ICMPV6_TYPE_ECHO_REPLY) {
      ESP_LOGI(TAG, "[%s] RX ICMPv6 Echo Reply (id=0x%04X, seq=%u)",
               config_.serial_no.c_str(), icmp.identifier, icmp.sequence);
      if (config_.state == STATE_PAIR_UNICAST_RS) {
        config_.state = STATE_PAIRING_TOKEN;
        config_.pair_tx_count_ = 0;
        config_.last_pair_tx_time_ = 0;
        ESP_LOGI(TAG, "[%s] Echo Reply confirmed by IB -> Moving to STATE_PAIRING_TOKEN", config_.serial_no.c_str());
      }
    } else if (icmp.type == ICMPV6_TYPE_ROUTER_ADVERT) {
      ESP_LOGI(TAG, "[%s] RX ICMPv6 Router Advertisement", config_.serial_no.c_str());
      if (config_.state == STATE_PAIR_BROADCAST_RS) {
        std::memcpy(config_.ib_mac, mac.src_mac, 8);
        config_.ib_mac_known = true;
        config_.state = STATE_PAIR_UNICAST_RS;
        config_.pair_tx_count_ = 0;
        config_.last_pair_tx_time_ = 0;
        ESP_LOGI(TAG, "[%s] Moving to STATE_PAIR_UNICAST_RS", config_.serial_no.c_str());
      }
    } else if (icmp.type == ICMPV6_TYPE_NEIGHBOR_SOLICIT) {
      // Immediate Solicited Neighbor Advertisement (136)
      bool target_matches = false;
      const uint8_t *solicited_target = nullptr;
      if (icmp.body.size() >= 20) {
        solicited_target = icmp.body.data() + 4;
        uint8_t our_ip[16];
        protocol::mac_to_ipv6(config_.mac_addr, our_ip);
        // Check link-local (fe80::) or global (aaaa::) matching our 8-byte EUI-64
        bool eui64_match = (std::memcmp(solicited_target + 8, our_ip + 8, 8) == 0);
        uint16_t target_short = (solicited_target[14] << 8) | solicited_target[15];
        bool short_match = (config_.short_addr != 0 && config_.short_addr == target_short);
        target_matches = eui64_match || short_match;
      } else {
        target_matches = !mac.is_broadcast;
      }
      if (target_matches) {
        std::vector<uint8_t> na_pt = protocol::build_neighbor_advertisement(config_.mac_addr, mac.src_mac, true,
                                                                            config_.frame_counter++, solicited_target);
        OutboundFrame frame = build_encrypted_icmp_frame(na_pt, mac.src_mac, rx_key);
        if (!frame.empty()) outbound_frames.push_back(std::move(frame));
        ESP_LOGI(TAG, "[%s] RX ICMPv6 Neighbor Solicitation for our IP -> Emitted Solicited NA (flags=0x60)",
                 config_.serial_no.c_str());
        uint32_t now_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
        config_.last_telemetry_ts = now_s;
      } else {
        uint16_t target_short = (icmp.body.size() >= 20) ? ((icmp.body[18] << 8) | icmp.body[19]) : 0;
        ESP_LOGD(TAG, "[%s] RX ICMPv6 Neighbor Solicitation for target short=0x%04X (not us) -> Ignored",
                 config_.serial_no.c_str(), target_short);
      }
    } else {
      ESP_LOGD(TAG, "[%s] RX ICMPv6 type=%u code=%u", config_.serial_no.c_str(), icmp.type, icmp.code);
    }
    return;
  }

  // 2. Check for 6LoWPAN Fragmentation (FRAG1 / FRAGN RFC 4944)
  // Tado inner framing has prefix [c5 1b 00 04] + 4B FC, so fragment dispatch is at decrypted[8].
  // Direct framing has dispatch at decrypted[3].
  uint8_t frag_disp = 0;
  if (len >= 12 && decrypted[3] == 0x04) {
    frag_disp = decrypted[8];
  } else if (len >= 7 && (((decrypted[3] & 0xF8) == 0xC0) || ((decrypted[3] & 0xF8) == 0xE0))) {
    frag_disp = decrypted[3];
  }
  if ((frag_disp & 0xF8) == 0xC0 || (frag_disp & 0xF8) == 0xE0) {
    handle_fragment(mac, decrypted, len, outbound_frames, rx_key);
    return;
  }

  // 3. Check for CoAP
  uint16_t src_port = 5683, dst_port = 5683;
  int coap_off = protocol::find_coap_offset(decrypted, len, &src_port, &dst_port);
  if (coap_off != -1) {
    ParsedCoAP coap = protocol::parse_coap(decrypted + coap_off, len - coap_off);
    if (coap.ok) {
      if (is_mac_acked_request(coap.mid)) {
        return;
      }
      coap.src_port = src_port;
      coap.dst_port = dst_port;
      if (coap.uri_path.empty()) {
        coap.uri_path = lookup_outbound_path(coap.mid);
      }
      uint32_t rx_fc = (len >= 8 && decrypted[3] == 0x04) ?
                       (decrypted[4] | ((uint32_t)decrypted[5] << 8) | ((uint32_t)decrypted[6] << 16) | ((uint32_t)decrypted[7] << 24)) : 0;
      if (rx_fc > 0) {
        ESP_LOGI(TAG, "[%s] RX CoAP seq=%u fc=%lu type=%u code=%u.%02u mid=0x%04X path='%s' (payload=%uB)",
                 config_.serial_no.c_str(), mac.seq, (unsigned long)rx_fc, coap.type, coap.code >> 5, coap.code & 0x1F,
                 coap.mid, coap.uri_path.c_str(), (unsigned)coap.payload.size());
      } else {
        ESP_LOGI(TAG, "[%s] RX CoAP seq=%u type=%u code=%u.%02u mid=0x%04X path='%s' (payload=%uB)",
                 config_.serial_no.c_str(), mac.seq, coap.type, coap.code >> 5, coap.code & 0x1F,
                 coap.mid, coap.uri_path.c_str(), (unsigned)coap.payload.size());
      }
      handle_coap_message(coap, mac, outbound_frames, rx_key);
      return;
    }
  }

  // 4. Unrecognized or unparsed payload
  ESP_LOGD(TAG, "[%s] RX Decrypted frame unhandled (len=%u, d3=0x%02X, d8=0x%02X)",
           config_.serial_no.c_str(), (unsigned)len, len > 3 ? decrypted[3] : 0, len > 8 ? decrypted[8] : 0);
}

void RUStateMachine::handle_fragment(const ParsedMac &mac, const uint8_t *decrypted, size_t len,
                                     std::vector<OutboundFrame> &outbound_frames,
                                     const uint8_t *rx_key) {
  size_t frag_hdr_off = 0;
  if (len >= 12 && decrypted[3] == 0x04) {
    frag_hdr_off = 8;
  } else if (len >= 7) {
    frag_hdr_off = 3;
  } else {
    return;
  }

  uint8_t disp = decrypted[frag_hdr_off];
  bool is_frag1 = ((disp & 0xF8) == 0xC0);
  bool is_fragn = ((disp & 0xF8) == 0xE0);

  if (!is_frag1 && !is_fragn) return;

  uint16_t datagram_size = ((disp & 0x07) << 8) | decrypted[frag_hdr_off + 1];
  uint16_t datagram_tag = ((uint16_t)decrypted[frag_hdr_off + 2] << 8) | decrypted[frag_hdr_off + 3];
  uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);

  // Reset reassembly buffer on new tag or after timeout
  if (fragment_reassembly_.active) {
    uint32_t elapsed = (now_ms >= fragment_reassembly_.timestamp_ms) ?
                       (now_ms - fragment_reassembly_.timestamp_ms) : 0;
    if (fragment_reassembly_.tag != datagram_tag || elapsed > 120000) {
      fragment_reassembly_ = SixLoWPANReassembly{};
    }
  }

  if (!fragment_reassembly_.active) {
    fragment_reassembly_.active = true;
    fragment_reassembly_.tag = datagram_tag;
    fragment_reassembly_.uncompressed_size = datagram_size;
    fragment_reassembly_.expansion = 40; // Default fallback
    fragment_reassembly_.compressed_size = (datagram_size > 40) ? (datagram_size - 40) : datagram_size;
    fragment_reassembly_.has_exact_expansion = false;
    fragment_reassembly_.timestamp_ms = now_ms;
    fragment_reassembly_.fc = (frag_hdr_off >= 8) ?
                              (decrypted[4] | ((uint32_t)decrypted[5] << 8) | ((uint32_t)decrypted[6] << 16) | ((uint32_t)decrypted[7] << 24)) : 0;
    if (frag_hdr_off >= 8) {
      fragment_reassembly_.tado_prefix.assign(decrypted, decrypted + 8);
    }
  }
  fragment_reassembly_.timestamp_ms = now_ms;

  if (is_frag1) {
    if (len < frag_hdr_off + 4) return;
    size_t slice_payload_off = frag_hdr_off + 4;
    size_t slice_len = len - slice_payload_off;

    // Determine 6LoWPAN header expansion dynamically (RFC 4944 / RFC 6282).
    int coap_off = protocol::find_coap_offset(decrypted, len);
    if (coap_off != -1 && (size_t)coap_off >= slice_payload_off) {
      size_t comp_hdr_len = (size_t)coap_off - slice_payload_off;
      if (comp_hdr_len <= 48) {
        fragment_reassembly_.expansion = 48 - (uint16_t)comp_hdr_len;
        fragment_reassembly_.has_exact_expansion = true;
        fragment_reassembly_.compressed_size = (datagram_size > fragment_reassembly_.expansion) ?
                                               (datagram_size - fragment_reassembly_.expansion) : datagram_size;
      }
    }

    // Save or replace FRAG1 slice
    bool replaced = false;
    for (auto &s : fragment_reassembly_.slices) {
      if (s.is_frag1) {
        s.data.assign(decrypted + slice_payload_off, decrypted + len);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      SixLoWPANFragmentSlice s;
      s.is_frag1 = true;
      s.uncompressed_offset = 0;
      s.data.assign(decrypted + slice_payload_off, decrypted + len);
      fragment_reassembly_.slices.push_back(std::move(s));
    }

    ESP_LOGD(TAG, "[%s] RX 6LoWPAN FRAG1 (uncomp=%u, comp=%u, exp=%u, tag=0x%04X, slice_len=%u)",
             config_.serial_no.c_str(), datagram_size, fragment_reassembly_.compressed_size,
             fragment_reassembly_.expansion, datagram_tag, (unsigned)slice_len);
  } else {
    // FRAGN
    if (len < frag_hdr_off + 5) return;
    size_t uncompressed_offset = (size_t)decrypted[frag_hdr_off + 4] * 8;
    size_t slice_payload_off = frag_hdr_off + 5;
    size_t slice_len = len - slice_payload_off;

    size_t comp_off = (uncompressed_offset >= fragment_reassembly_.expansion) ?
                      (uncompressed_offset - fragment_reassembly_.expansion) : 0;

    // Save or replace FRAGN slice
    bool replaced = false;
    for (auto &s : fragment_reassembly_.slices) {
      if (!s.is_frag1 && s.uncompressed_offset == uncompressed_offset) {
        s.data.assign(decrypted + slice_payload_off, decrypted + len);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      SixLoWPANFragmentSlice s;
      s.is_frag1 = false;
      s.uncompressed_offset = uncompressed_offset;
      s.data.assign(decrypted + slice_payload_off, decrypted + len);
      fragment_reassembly_.slices.push_back(std::move(s));
    }

    ESP_LOGD(TAG, "[%s] RX 6LoWPAN FRAGN (uncomp_off=%u -> comp_off=%u, slice_len=%u, tag=0x%04X)",
             config_.serial_no.c_str(), (unsigned)uncompressed_offset, (unsigned)comp_off,
             (unsigned)slice_len, datagram_tag);
  }

  // Check completeness across all received slices (matching checkComplete in reassembler.js)
  std::map<size_t, std::vector<uint8_t>> pieces_by_offset;
  size_t lowest_fragn_comp_off = (size_t)-1;

  for (const auto &s : fragment_reassembly_.slices) {
    if (!s.is_frag1) {
      size_t comp_off = (s.uncompressed_offset >= fragment_reassembly_.expansion) ?
                        (s.uncompressed_offset - fragment_reassembly_.expansion) : 0;
      if (comp_off < lowest_fragn_comp_off) lowest_fragn_comp_off = comp_off;
      pieces_by_offset[comp_off] = s.data;
    }
  }

  for (const auto &s : fragment_reassembly_.slices) {
    if (s.is_frag1) {
      std::vector<uint8_t> frag1_data = s.data;
      // Trim FRAG1 if it overlapped into FRAGN offset (discarding frame CRC/padding)
      if (lowest_fragn_comp_off != (size_t)-1 && frag1_data.size() > lowest_fragn_comp_off) {
        frag1_data.resize(lowest_fragn_comp_off);
      }
      pieces_by_offset[0] = std::move(frag1_data);
    }
  }

  size_t current_offset = 0;
  std::vector<uint8_t> complete_payload;
  for (const auto &pair : pieces_by_offset) {
    size_t offset = pair.first;
    const auto &data = pair.second;
    size_t end = offset + data.size();

    if (offset <= current_offset && end > current_offset) {
      size_t skip = current_offset - offset;
      complete_payload.insert(complete_payload.end(), data.begin() + skip, data.end());
      current_offset = end;
    } else if (end <= current_offset) {
      continue;
    } else {
      // Gap detected, waiting for missing slice
      break;
    }
  }

  size_t target_size = fragment_reassembly_.compressed_size;
  if (current_offset >= target_size && !complete_payload.empty()) {
    if (complete_payload.size() > target_size) {
      complete_payload.resize(target_size);
    }
    ESP_LOGD(TAG, "[%s] 6LoWPAN Datagram reassembly complete (size=%u, tag=0x%04X) -> Processing payload",
             config_.serial_no.c_str(), (unsigned)target_size, fragment_reassembly_.tag);

    std::vector<uint8_t> full_decrypted;
    if (!fragment_reassembly_.tado_prefix.empty()) {
      full_decrypted = fragment_reassembly_.tado_prefix;
    } else {
      full_decrypted = {0xC5, 0x1B, 0x00, 0x04};
      uint32_t fc = fragment_reassembly_.fc;
      full_decrypted.push_back(fc & 0xFF);
      full_decrypted.push_back((fc >> 8) & 0xFF);
      full_decrypted.push_back((fc >> 16) & 0xFF);
      full_decrypted.push_back((fc >> 24) & 0xFF);
    }
    full_decrypted.insert(full_decrypted.end(), complete_payload.begin(), complete_payload.end());

    // Reset reassembly state before processing reassembled datagram
    fragment_reassembly_ = SixLoWPANReassembly{};

    process_inbound_decrypted(mac, full_decrypted.data(), full_decrypted.size(), outbound_frames, rx_key);
  }
}

void RUStateMachine::process_csl_strobe(uint8_t strobe_seq, uint16_t pan_id, uint16_t dst_short, uint16_t countdown,
                                      std::vector<OutboundFrame> &outbound_frames) {
  if (config_.state != STATE_OPERATIONAL) return;
  if (config_.short_addr != dst_short) return;

  // Immediate CSL Data Poll (debounced to 1 poll per 500ms window)
  uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
  if (now_ms - config_.last_csl_poll_time_ >= 500) {
    config_.last_csl_poll_time_ = now_ms;
    // For Tado CSL Data Poll, the wire PAN ID in bytes [3..4] is the device's short address (dst_short)
    std::vector<uint8_t> poll = protocol::build_csl_data_poll(strobe_seq, dst_short,
                                                             config_.mac_addr, dst_short);
    outbound_frames.emplace_back(poll);
    ESP_LOGD(TAG, "[%s] CSL beacon detected (countdown=%u). Emitted immediate CSL Data Poll",
             config_.serial_no.c_str(), countdown);
  }
}

void RUStateMachine::track_outbound_response(uint8_t seq, uint16_t mid) {
  uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
  if (pending_response_acks_.size() >= 16) {
    pending_response_acks_.erase(pending_response_acks_.begin());
  }
  pending_response_acks_.push_back({seq, mid, now_ms});
}

void RUStateMachine::record_mac_acked_mid(uint16_t mid) {
  uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
  if (mac_acked_requests_.size() >= 16) {
    mac_acked_requests_.erase(mac_acked_requests_.begin());
  }
  mac_acked_requests_.push_back({mid, now_ms});
}

bool RUStateMachine::is_mac_acked_request(uint16_t mid) const {
  uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
  for (const auto &item : mac_acked_requests_) {
    if (item.mid == mid && (now_ms - item.timestamp_ms < 60000)) {
      return true;
    }
  }
  return false;
}

void RUStateMachine::handle_mac_ack(uint8_t seq) {
  for (auto it = config_.pending_cons.begin(); it != config_.pending_cons.end(); ) {
    if (it->seq == seq) {
      if (config_.state == STATE_OPERATIONAL) {
        ESP_LOGD(TAG, "[%s] MAC ACK received for operational CON MID=0x%04X seq=%u -> completed",
                 config_.serial_no.c_str(), it->mid, seq);
        it = config_.pending_cons.erase(it);
        return;
      } else {
        ESP_LOGD(TAG, "[%s] MAC ACK received for onboarding CON MID=0x%04X seq=%u -> delivery confirmed",
                 config_.serial_no.c_str(), it->mid, seq);
        it->mac_confirmed = true;
        ++it;
        return;
      }
    } else {
      ++it;
    }
  }

  // Check pending responses to inbound requests
  for (auto it = pending_response_acks_.begin(); it != pending_response_acks_.end(); ) {
    if (it->seq == seq) {
      ESP_LOGD(TAG, "[%s] MAC ACK received for response to MID=0x%04X seq=%u -> delivery confirmed",
               config_.serial_no.c_str(), it->mid, seq);
      record_mac_acked_mid(it->mid);
      it = pending_response_acks_.erase(it);
      return;
    } else {
      ++it;
    }
  }
}

static bool is_measuring_target_url(const std::string &url, const uint8_t *mac, const std::string &ipv6_addr) {
  if (url.empty() || url == "coap://" || url == "coap://[::]") return false;
  char mac_suffix[16];
  snprintf(mac_suffix, sizeof(mac_suffix), "%02x%02x:%02x%02x", mac[4], mac[5], mac[6], mac[7]);
  if (url.find(mac_suffix) != std::string::npos) return true;
  if (!ipv6_addr.empty() && url.find(ipv6_addr) != std::string::npos) return true;
  return false;
}

void RUStateMachine::handle_coap_message(const ParsedCoAP &coap, const ParsedMac &mac,
                                         std::vector<OutboundFrame> &outbound_frames,
                                         const uint8_t *rx_key) {
  // ACK matching: cancel pending CON on any ACK/response matching MID
  if (coap.type == COAP_TYPE_ACK || coap.code >= 0x40) {
    for (auto it = config_.pending_cons.begin(); it != config_.pending_cons.end(); ++it) {
      if (it->mid == coap.mid) {
        ESP_LOGI(TAG, "[%s] ACK received for CON MID=0x%04X path='%s' (state=%d)",
                 config_.serial_no.c_str(), coap.mid, coap.uri_path.c_str(), config_.state);
        record_mac_acked_mid(coap.mid);
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
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
      ESP_LOGI(TAG, "[%s] TX CoAP ACK seq=%u fc=%lu code=2.04 mid=0x%04X path='d/pair'",
               config_.serial_no.c_str(), frame.seq, (unsigned long)frame.fc, coap.mid);
    }

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
    ESP_LOGI(TAG, "[%s] Received POST /d/pair with op_key. Moving to STATE_PAIRING_TOKEN", config_.serial_no.c_str());
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
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
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
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    return;
  }

  // Case 6: Inbound GET /d/info (Device Info Query)
  if (coap.code == COAP_CODE_GET && (coap.uri_path == "d/info" || coap.uri_path.find("/info") != std::string::npos)) {
    std::vector<uint8_t> info_tlv = protocol::build_d_info_tlv(config_.serial_no, 13762);
    std::vector<uint8_t> ack_coap = protocol::serialize_coap(COAP_TYPE_ACK, COAP_CODE_CONTENT, coap.mid,
                                                            coap.token.data(), coap.token.size(), "",
                                                            info_tlv.data(), info_tlv.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
      ESP_LOGI(TAG, "[%s] TX CoAP ACK seq=%u fc=%lu code=2.05 mid=0x%04X path='d/info' (payload=%zuB)",
               config_.serial_no.c_str(), frame.seq, (unsigned long)frame.fc, coap.mid, info_tlv.size());
    }
    return;
  }

  // Case 6a: Inbound PUT /d/identify (Device Identify)
  if (coap.code == COAP_CODE_PUT && (coap.uri_path == "d/identify" || coap.uri_path.find("identify") != std::string::npos)) {
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Responded to PUT /d/identify with 2.04 Changed", config_.serial_no.c_str());
    return;
  }

  // Case 6b: Inbound GET /d/config or /d/{serial}/config (Device Configuration Query)
  if (coap.code == COAP_CODE_GET && (coap.uri_path == "d/config" || coap.uri_path.find("/config") != std::string::npos)) {
    std::vector<uint8_t> cfg_tlv = protocol::build_d_config_tlv(config_.home_id, config_.zone_id, config_.zone_role);
    std::vector<uint8_t> ack_coap = protocol::serialize_coap(COAP_TYPE_ACK, COAP_CODE_CONTENT, coap.mid,
                                                            coap.token.data(), coap.token.size(), "",
                                                            cfg_tlv.data(), cfg_tlv.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Responded to GET /d/config with 2.05 Content (home_id=%lu, zone_id=%lu)",
             config_.serial_no.c_str(), (unsigned long)config_.home_id, (unsigned long)config_.zone_id);
    return;
  }

  // Case 6c: Inbound PUT /d/config or /d/{serial}/config (Device Configuration Push)
  if (coap.code == COAP_CODE_PUT && (coap.uri_path == "d/config" || coap.uri_path.find("/config") != std::string::npos)) {
    auto tlvs = protocol::parse_tlvs(coap.payload.data(), coap.payload.size());
    for (const auto &t : tlvs) {
      if (t.tag == TLV_ZONE_BINDING_015E && t.value.size() >= 2) {
        config_.zone_role = t.value[0];
        config_.zone_id = t.value[1];
      } else if (t.tag == TLV_HOME_ID_015C && t.value.size() >= 4) {
        config_.home_id = ((uint32_t)t.value[0] << 24) | ((uint32_t)t.value[1] << 16) |
                          ((uint32_t)t.value[2] << 8) | (uint32_t)t.value[3];
      }
    }
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Updated from PUT /d/config: zone_id=%lu, role=0x%02X, home_id=%lu, replied 2.04 Changed",
             config_.serial_no.c_str(), (unsigned long)config_.zone_id, config_.zone_role, (unsigned long)config_.home_id);
    return;
  }

  // Case 7: Inbound GET /z/extui (Zone Binding Query)
  if (coap.code == COAP_CODE_GET && (coap.uri_path == "z/extui" || coap.uri_path.rfind("z/extui", 0) == 0)) {
    std::vector<uint8_t> extui_tlv = protocol::build_z_extui_tlv(config_.target_url_s, config_.target_url_p);
    std::vector<uint8_t> ack_coap = protocol::serialize_coap(COAP_TYPE_ACK, COAP_CODE_CONTENT, coap.mid,
                                                            coap.token.data(), coap.token.size(), "",
                                                            extui_tlv.data(), extui_tlv.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Responded to GET /z/extui with target URLs", config_.serial_no.c_str());
    return;
  }

  // Case 8: Inbound PUT /z/extui (Zone Binding Update)
  if (coap.code == COAP_CODE_PUT && (coap.uri_path == "z/extui" || coap.uri_path.rfind("z/extui", 0) == 0)) {
    auto tlvs = protocol::parse_tlvs(coap.payload.data(), coap.payload.size());
    for (const auto &t : tlvs) {
      if (t.tag == TLV_EXTUI_TARGET_URL_S) {
        config_.target_url_s.assign((const char *)t.value.data(), t.value.size());
      } else if (t.tag == TLV_EXTUI_TARGET_URL_P) {
        config_.target_url_p.assign((const char *)t.value.data(), t.value.size());
      }
    }
    // Update Zone Measuring Leader state based on zone assignment and target_url_p matching our own address
    config_.is_measuring_leader = (config_.zone_id != 0 &&
                                   is_measuring_target_url(config_.target_url_p, config_.mac_addr, config_.ipv6_address));
    // Reply with 2.01 Created ACK
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CREATED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Stored binding URLs from PUT /z/extui (leader=%d): url_s='%s' url_p='%s' -> replied 2.01 Created",
             config_.serial_no.c_str(), config_.is_measuring_leader,
             config_.target_url_s.c_str(), config_.target_url_p.c_str());
    return;
  }

  // Case 9: Inbound GET /z/p (Zone Telemetry Query)
  if (coap.code == COAP_CODE_GET && (coap.uri_path == "z/p" || coap.uri_path.rfind("z/p", 0) == 0)) {
    std::vector<uint8_t> zp_tlv = protocol::build_z_p_tlv(config_.target_temp_celsius, config_.target_humidity_pct);
    std::vector<uint8_t> ack_coap = protocol::serialize_coap(COAP_TYPE_ACK, COAP_CODE_CONTENT, coap.mid,
                                                            coap.token.data(), coap.token.size(), "",
                                                            zp_tlv.data(), zp_tlv.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Responded to GET /z/p with temp=%.2f hum=%.1f",
             config_.serial_no.c_str(), config_.target_temp_celsius, config_.target_humidity_pct);
    return;
  }

  // Case 10: Inbound GET /z/s (Zone State Query)
  if (coap.code == COAP_CODE_GET && (coap.uri_path == "z/s" || coap.uri_path.rfind("z/s", 0) == 0)) {
    std::vector<uint8_t> zs_tlv = protocol::build_z_s_tlv(config_.zone_mode, config_.zone_id, config_.target_temp_celsius);
    std::vector<uint8_t> ack_coap = protocol::serialize_coap(COAP_TYPE_ACK, COAP_CODE_CONTENT, coap.mid,
                                                            coap.token.data(), coap.token.size(), "",
                                                            zs_tlv.data(), zs_tlv.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Responded to GET /z/s", config_.serial_no.c_str());
    return;
  }

  // Case 11: Inbound PUT /z/s (Zone Setpoint Update)
  if (coap.code == COAP_CODE_PUT && (coap.uri_path == "z/s" || coap.uri_path.rfind("z/s", 0) == 0)) {
    auto tlvs = protocol::parse_tlvs(coap.payload.data(), coap.payload.size());
    for (const auto &t : tlvs) {
      if (t.tag == TLV_ZONE_TARGET_TEMP_6200 && t.value.size() >= 2) {
        uint16_t raw_temp = (t.value[0] << 8) | t.value[1];
        config_.target_temp_celsius = raw_temp / 100.0f;
      } else if (t.tag == TLV_ZONE_MODE_6160 && !t.value.empty()) {
        config_.zone_mode = t.value[0];
      } else if (t.tag == TLV_ZONE_ID_6020 && !t.value.empty()) {
        config_.zone_id = t.value[0];
        config_.is_measuring_leader = (config_.zone_id != 0 &&
                                       is_measuring_target_url(config_.target_url_p, config_.mac_addr, config_.ipv6_address));
      }
    }
    // Reply with 2.04 Changed ACK
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
    }
    ESP_LOGI(TAG, "[%s] Updated setpoint from PUT /z/s: target_temp=%.2fC, mode=%u, replied 2.04 Changed",
             config_.serial_no.c_str(), config_.target_temp_celsius, config_.zone_mode);
    return;
  }

  // Case 6: Standard CON request requiring empty 2.04 Changed ACK
  if (coap.type == COAP_TYPE_CON) {
    std::vector<uint8_t> ack_coap = protocol::build_coap_ack(coap.mid, COAP_CODE_CHANGED,
                                                            coap.token.data(), coap.token.size());
    std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(ack_coap.data(), ack_coap.size(),
                                                               config_.mac_addr, mac.src_mac,
                                                               coap.dst_port, coap.src_port,
                                                               0x7E, config_.frame_counter++);
    OutboundFrame frame = build_encrypted_icmp_frame(pt, mac.src_mac, rx_key);
    if (!frame.empty()) {
      track_outbound_response(frame.seq, coap.mid);
      outbound_frames.push_back(std::move(frame));
      ESP_LOGI(TAG, "[%s] Emitted default 2.04 Changed ACK for mid=0x%04X", config_.serial_no.c_str(), coap.mid);
    }
  }
}

void RUStateMachine::track_outbound_coap(uint16_t mid, const std::string &path, uint8_t type, uint8_t code) {
  OutboundCoAPTracker tr;
  tr.mid = mid;
  tr.path = path;
  tr.type = type;
  tr.code = code;
  tr.timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
  outbound_coap_history_.push_back(std::move(tr));
  if (outbound_coap_history_.size() > 32) {
    outbound_coap_history_.erase(outbound_coap_history_.begin());
  }
}

std::string RUStateMachine::lookup_outbound_path(uint16_t mid) {
  for (auto it = outbound_coap_history_.rbegin(); it != outbound_coap_history_.rend(); ++it) {
    if (it->mid == mid) {
      return it->path;
    }
  }
  for (const auto &p : config_.pending_cons) {
    if (p.mid == mid && !p.path.empty()) {
      return p.path;
    }
  }
  return "";
}

OutboundFrame RUStateMachine::build_encrypted_coap_frame(uint8_t type, uint8_t code, const std::string &path,
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
  uint32_t fc = config_.frame_counter++;
  std::vector<uint8_t> pt = protocol::encapsulate_6lowpan_udp(coap.data(), coap.size(),
                                                             config_.mac_addr, dst,
                                                             5683, 4005, dispatch_mode,
                                                             fc);

  uint8_t seq = config_.seq_num++;
  std::vector<uint8_t> hdr = protocol::build_mac_header(seq, config_.mac_addr, dst, (type == COAP_TYPE_CON));

  const uint8_t *key = config_.has_op_key ? config_.op_key : PAIRING_KEY;
  std::vector<uint8_t> frame = protocol::encrypt_ccm(hdr.data(), pt.data(), pt.size(), key);

  track_outbound_coap(mid, path, type, code);

  // Track CON frames for retransmission
  if (type == COAP_TYPE_CON && !frame.empty()) {
    uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000ULL);
    PendingCON pending;
    pending.mid = mid;
    pending.seq = seq;
    pending.fc = fc;
    pending.mac_confirmed = false;
    pending.frame = frame;
    pending.timeout_ms = 2000;
    pending.next_tx_ms = now_ms + pending.timeout_ms; // First retry after ACK_TIMEOUT
    pending.retries = 0;
    pending.path = path;
    config_.pending_cons.push_back(pending);
  }

  ESP_LOGI(TAG, "[%s] TX CoAP seq=%u fc=%lu type=%u code=%u.%02u mid=0x%04X path='%s' (payload=%zuB)",
           config_.serial_no.c_str(), seq, (unsigned long)fc, type, code >> 5, code & 0x1F,
           mid, path.c_str(), payload_len);

  return OutboundFrame(std::move(frame), fc, seq);
}

OutboundFrame RUStateMachine::build_encrypted_icmp_frame(const std::vector<uint8_t> &pt_icmp,
                                                         const uint8_t *dest_mac,
                                                         const uint8_t *key_override) {
  const uint8_t *dst = dest_mac ? dest_mac : (config_.ib_mac_known ? config_.ib_mac : nullptr);
  bool is_unicast = (dst != nullptr && !(dst[0] == 0xFF && dst[7] == 0xFF));
  uint8_t seq = config_.seq_num++;
  // Unicast frames to IB request hardware MAC ACK (0x69EC), broadcast frames do not (0x49E8)
  std::vector<uint8_t> hdr = protocol::build_mac_header(seq, config_.mac_addr, dst, is_unicast);

  uint32_t fc = 0;
  if (pt_icmp.size() >= 8 && pt_icmp[3] == 0x04) {
    fc = pt_icmp[4] | ((uint32_t)pt_icmp[5] << 8) | ((uint32_t)pt_icmp[6] << 16) | ((uint32_t)pt_icmp[7] << 24);
  }

  const uint8_t *key = key_override ? key_override : ((config_.state >= STATE_ONBOARD_FW_STATE && config_.has_op_key) ? config_.op_key : PAIRING_KEY);
  std::vector<uint8_t> frame = protocol::encrypt_ccm(hdr.data(), pt_icmp.data(), pt_icmp.size(), key);
  return OutboundFrame(std::move(frame), fc, seq);
}

void RUStateMachine::begin_onboarding(std::vector<OutboundFrame> &outbound_frames) {
  config_.state = STATE_ONBOARD_FW_STATE;
  config_.last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);
  config_.pending_cons.clear();

  ESP_LOGI(TAG, "[%s] Starting onboarding sequence (fw/state -> config -> act -> err -> sen)",
           config_.serial_no.c_str());

  // Stage 1: PUT /d/{serial}/fw/state (CON)
  std::vector<uint8_t> fw_tlv = protocol::build_d_fw_state_tlv(13762, 13059, "c54baf8");
  std::string fw_path = "d/" + config_.serial_no + "/fw/state";
  OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT, fw_path,
                                                  fw_tlv.data(), fw_tlv.size(), config_.ib_mac);
  if (!frame.empty()) outbound_frames.push_back(std::move(frame));
}

void RUStateMachine::advance_onboarding(std::vector<OutboundFrame> &outbound_frames) {
  std::string base_path = "d/" + config_.serial_no;

  switch (config_.state) {
    case STATE_ONBOARD_FW_STATE: {
      // fw/state ACK received → GET /d/{serial}/config
      config_.state = STATE_ONBOARD_CONFIG;
      ESP_LOGI(TAG, "[%s] Onboard: fw/state ACKed → GET config", config_.serial_no.c_str());
      OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_GET,
                                                      base_path + "/config",
                                                      nullptr, 0, config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));
      break;
    }
    case STATE_ONBOARD_CONFIG: {
      // config response received → PUT /d/{serial}/act
      config_.state = STATE_ONBOARD_ACT;
      ESP_LOGI(TAG, "[%s] Onboard: config received → PUT act", config_.serial_no.c_str());
      std::vector<uint8_t> act_tlv;
      protocol::append_tlv_u8(act_tlv, TLV_ACTUATOR_ACTIVE, 0);
      OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT,
                                                      base_path + "/act",
                                                      act_tlv.data(), act_tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));
      break;
    }
    case STATE_ONBOARD_ACT: {
      // act ACK received → PUT /d/{serial}/err
      config_.state = STATE_ONBOARD_ERR;
      ESP_LOGI(TAG, "[%s] Onboard: act ACKed → PUT err", config_.serial_no.c_str());
      std::vector<uint8_t> err_tlv;
      protocol::append_tlv_u32(err_tlv, 0x01a3, 0); // Error flags = 0 (no errors)
      OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT,
                                                      base_path + "/err",
                                                      err_tlv.data(), err_tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));
      break;
    }
    case STATE_ONBOARD_ERR: {
      // err ACK received → PUT /d/{serial}/sen (initial telemetry)
      config_.state = STATE_ONBOARD_SEN;
      ESP_LOGI(TAG, "[%s] Onboard: err ACKed → PUT sen (initial telemetry)", config_.serial_no.c_str());
      std::vector<uint8_t> sen_tlv = protocol::build_d_sen_tlv(
          config_.target_temp_celsius, config_.target_humidity_pct,
          config_.target_battery_mv, config_.target_ambient_light, 0, 0);
      OutboundFrame frame = build_encrypted_coap_frame(COAP_TYPE_CON, COAP_CODE_PUT,
                                                      base_path + "/sen",
                                                      sen_tlv.data(), sen_tlv.size(), config_.ib_mac);
      if (!frame.empty()) outbound_frames.push_back(std::move(frame));
      break;
    }
    case STATE_ONBOARD_SEN: {
      // sen ACK received → OPERATIONAL
      config_.state = STATE_OPERATIONAL;
      config_.last_telemetry_ts = (uint32_t)(esp_timer_get_time() / 1000000ULL);
      config_.last_link_probe_ts = config_.last_telemetry_ts;
      config_.pending_cons.clear();
      ESP_LOGI(TAG, "[%s] Onboarding complete. STATE_OPERATIONAL", config_.serial_no.c_str());
      break;
    }
    default:
      break;
  }
}

} // namespace tado_emulator
} // namespace esphome
