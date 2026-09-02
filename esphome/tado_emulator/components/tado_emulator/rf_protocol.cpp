/**
 * @file rf_protocol.cpp
 * @brief Implementation of Tado RF protocol stack.
 */

#include "rf_protocol.h"
#include <mbedtls/ccm.h>
#include <mbedtls/aes.h>
#include <algorithm>

namespace esphome {
namespace tado_emulator {

const uint8_t PAIRING_KEY[16] = {
  0x74, 0x61, 0x64, 0x6f, 0x20, 0x70, 0x61, 0x69,
  0x72, 0x69, 0x6e, 0x67, 0x20, 0x6b, 0x65, 0x79
};

namespace protocol {

// ---------------------------------------------------------------------------
// CRC-16 Kermit
// ---------------------------------------------------------------------------

uint16_t crc16_kermit(const uint8_t *data, size_t len) {
  if (!data || len == 0) return 0;
  uint16_t crc = 0x0000;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0x8408;
      } else {
        crc = (crc >> 1);
      }
    }
  }
  return crc;
}

uint16_t crc16_kermit(const uint8_t *h16, const uint8_t *pt, size_t pt_len) {
  uint16_t crc = 0x0000;
  if (h16) {
    for (size_t i = 0; i < 16; i++) {
      crc ^= h16[i];
      for (int j = 0; j < 8; j++) {
        if (crc & 1) crc = (crc >> 1) ^ 0x8408;
        else crc = (crc >> 1);
      }
    }
  }
  if (pt) {
    for (size_t i = 0; i < pt_len; i++) {
      crc ^= pt[i];
      for (int j = 0; j < 8; j++) {
        if (crc & 1) crc = (crc >> 1) ^ 0x8408;
        else crc = (crc >> 1);
      }
    }
  }
  return crc;
}

// ---------------------------------------------------------------------------
// MAC Layer
// ---------------------------------------------------------------------------

bool parse_mac_header(const uint8_t *frame, size_t len, const uint8_t *decrypted, size_t dec_len, ParsedMac &out) {
  if (!frame || len < 5) return false;

  out.fcf = frame[0] | ((uint16_t)frame[1] << 8);
  out.seq = frame[2];
  uint8_t dst_mode = (out.fcf >> 10) & 0x03;

  size_t offset = 3;
  if (dst_mode == 2) { // 16-bit short address
    if (len < offset + 4) return false;
    out.pan_id = frame[offset] | ((uint16_t)frame[offset + 1] << 8);
    offset += 2;
    uint16_t short_dst = frame[offset] | ((uint16_t)frame[offset + 1] << 8);
    offset += 2;
    if (short_dst == 0xFFFF) {
      out.is_broadcast = true;
      std::memset(out.dst_mac, 0xFF, 8);
    } else {
      out.dst_mac[0] = short_dst & 0xFF;
      out.dst_mac[1] = (short_dst >> 8) & 0xFF;
    }
  } else if (dst_mode == 3) { // 64-bit extended address
    if (len < offset + 8) return false;
    out.pan_id = frame[offset] | ((uint16_t)frame[offset + 1] << 8);
    offset += 2;
    // Tado compresses 8B dst_mac: [pan_lo, pan_hi, 6 clear bytes at frame[5..10]]
    out.dst_mac[0] = out.pan_id & 0xFF;
    out.dst_mac[1] = (out.pan_id >> 8) & 0xFF;
    std::memcpy(out.dst_mac + 2, frame + offset, 6);
    offset += 6;
  }

  // Source MAC: 5 bytes in cleartext frame[11..15] + 3 bytes in decrypted[0..2]
  if (len >= 16) {
    std::memcpy(out.src_mac, frame + 11, 5);
    if (decrypted && dec_len >= 3) {
      std::memcpy(out.src_mac + 5, decrypted, 3);
    } else {
      out.src_mac[5] = 0xC5;
      out.src_mac[6] = 0x1B;
      out.src_mac[7] = 0x00;
    }
  }

  out.header_len = 16;
  out.valid = true;
  return true;
}

std::vector<uint8_t> build_mac_header(uint8_t seq, const uint8_t *src_mac, const uint8_t *dst_mac, bool ack_req) {
  std::vector<uint8_t> hdr(16, 0);

  bool is_bcast = (!dst_mac || (dst_mac[0] == 0xFF && dst_mac[7] == 0xFF));
  if (is_bcast) {
    // Broadcast Data frame FCF: 0x49E8 (LE: 0x49, 0xE8)
    hdr[0] = 0x49;
    hdr[1] = 0xE8;
    hdr[2] = seq;
    hdr[3] = 0xFF;
    hdr[4] = 0xFF;
    // 8-byte Source MAC (wire LE) at hdr[5..12]
    if (src_mac) {
      std::memcpy(hdr.data() + 5, src_mac, 8);
    }
    // Framing bytes at [13..15]
    hdr[13] = 0x04;
    hdr[14] = 0xBB;
    hdr[15] = 0x74;
    return hdr;
  }

  // Unicast operational Data frame FCF: 0xEC69 (LE: 0x69, 0xEC)
  uint16_t fcf = MAC_FCF_DATA_SECURITY;
  if (!ack_req) fcf &= ~0x0020; // Clear ACK request bit

  hdr[0] = fcf & 0xFF;
  hdr[1] = (fcf >> 8) & 0xFF;
  hdr[2] = seq;
  // Tado destination address compression:
  // dst_mac[0..1] is PAN ID at hdr[3..4]
  hdr[3] = dst_mac[0];
  hdr[4] = dst_mac[1];

  // 6-byte destination MAC suffix (wire LE: dst_mac[2..7])
  std::memcpy(hdr.data() + 5, dst_mac + 2, 6);

  // 5-byte source MAC cleartext prefix (wire LE)
  if (src_mac) {
    std::memcpy(hdr.data() + 11, src_mac, 5);
  }

  return hdr;
}

bool is_csl_beacon(const uint8_t *frame, size_t len) {
  if (!frame || len < 11) return false;
  return frame[0] == 0x25 || (frame[0] == 0x0C && frame[1] == 0x25);
}

bool parse_csl_beacon(const uint8_t *frame, size_t len, uint8_t &seq, uint16_t &pan_id, uint16_t &dst_short, uint16_t &countdown) {
  if (!frame) return false;
  // 12-byte raw frame (len prefix 0x0C at [0] or direct at [0])
  size_t off = (frame[0] == 0x0C) ? 1 : 0;
  if (len < off + 11) return false;
  if (frame[off] != 0x25) return false;

  seq = frame[off + 1];
  pan_id = frame[off + 2] | ((uint16_t)frame[off + 3] << 8);
  dst_short = ((uint16_t)frame[off + 4] << 8) | frame[off + 5]; // Big-endian
  countdown = frame[off + 8] | ((uint16_t)frame[off + 9] << 8); // Little-endian
  return true;
}

std::vector<uint8_t> build_csl_data_poll(uint8_t seq, uint16_t pan_id, const uint8_t *src_mac, uint16_t dst_short) {
  // Real CSL Data Poll / Beacon ACK: 0x69 0x88 <seq> <pan_le> <dst_short_le> <src_mac_8b>
  std::vector<uint8_t> pkt;
  pkt.push_back(0x69);
  pkt.push_back(0x88);
  pkt.push_back(seq);
  pkt.push_back(pan_id & 0xFF);
  pkt.push_back((pan_id >> 8) & 0xFF);
  pkt.push_back(dst_short & 0xFF);
  pkt.push_back((dst_short >> 8) & 0xFF);
  for (int i = 0; i < 8; i++) pkt.push_back(src_mac[i]);
  return pkt;
}

// ---------------------------------------------------------------------------
// Cryptography (AES-128-CCM & AES-128-ECB)
// ---------------------------------------------------------------------------

bool decrypt_ccm(const uint8_t *frame, size_t len, const uint8_t *key, std::vector<uint8_t> &out_plaintext, bool verify_crc) {
  if (!frame || len < 21 || !key) return false;

  const uint8_t *nonce = frame;      // First 13 bytes
  const uint8_t *aad = frame;        // Full 16-byte MAC header
  size_t ciphertext_len = len - 16 - 4;
  const uint8_t *ciphertext = frame + 16;
  const uint8_t *tag = frame + len - 4;

  out_plaintext.resize(ciphertext_len);

  mbedtls_ccm_context ctx;
  mbedtls_ccm_init(&ctx);
  int ret = mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 128);
  if (ret != 0) {
    mbedtls_ccm_free(&ctx);
    return false;
  }

  ret = mbedtls_ccm_auth_decrypt(&ctx, ciphertext_len, nonce, 13, aad, 16, ciphertext, out_plaintext.data(), tag, 4);
  mbedtls_ccm_free(&ctx);

  if (ret != 0) {
    out_plaintext.clear();
    return false;
  }

  if (verify_crc && out_plaintext.size() >= 2) {
    size_t pl_len = out_plaintext.size() - 2;
    uint16_t expected_crc = out_plaintext[pl_len] | ((uint16_t)out_plaintext[pl_len + 1] << 8);
    uint16_t calc_crc = crc16_kermit(aad, out_plaintext.data(), pl_len);
    if (expected_crc != calc_crc) {
      out_plaintext.clear();
      return false;
    }
    out_plaintext.resize(pl_len);
  }

  return true;
}

std::vector<uint8_t> encrypt_ccm(const uint8_t *header_16b, const uint8_t *plaintext, size_t pt_len, const uint8_t *key) {
  if (!header_16b || !plaintext || !key) return {};

  // Append 2-byte CRC16-Kermit trailer over 16-byte MAC header + plaintext
  uint16_t crc = crc16_kermit(header_16b, plaintext, pt_len);
  std::vector<uint8_t> pt_with_crc(pt_len + 2);
  std::memcpy(pt_with_crc.data(), plaintext, pt_len);
  pt_with_crc[pt_len] = crc & 0xFF;
  pt_with_crc[pt_len + 1] = (crc >> 8) & 0xFF;

  size_t total_pt_len = pt_len + 2;
  const uint8_t *nonce = header_16b;
  const uint8_t *aad = header_16b;

  std::vector<uint8_t> result(16 + total_pt_len + 4);
  std::memcpy(result.data(), header_16b, 16);

  mbedtls_ccm_context ctx;
  mbedtls_ccm_init(&ctx);
  mbedtls_ccm_setkey(&ctx, MBEDTLS_CIPHER_ID_AES, key, 128);

  uint8_t *ct = result.data() + 16;
  uint8_t *tag = result.data() + 16 + total_pt_len;

  mbedtls_ccm_encrypt_and_tag(&ctx, total_pt_len, nonce, 13, aad, 16, pt_with_crc.data(), ct, tag, 4);
  mbedtls_ccm_free(&ctx);

  return result;
}

bool decrypt_aes128_ecb(const uint8_t *ciphertext_16b, const uint8_t *key, uint8_t *out_plaintext_16b) {
  if (!ciphertext_16b || !key || !out_plaintext_16b) return false;

  mbedtls_aes_context ctx;
  mbedtls_aes_init(&ctx);
  mbedtls_aes_setkey_dec(&ctx, key, 128);
  mbedtls_aes_crypt_ecb(&ctx, MBEDTLS_AES_DECRYPT, ciphertext_16b, out_plaintext_16b);
  mbedtls_aes_free(&ctx);
  return true;
}

// ---------------------------------------------------------------------------
// 6LoWPAN IPHC / NHC & Checksums
// ---------------------------------------------------------------------------

int find_coap_offset(const uint8_t *buf, size_t len, uint16_t *out_src_port, uint16_t *out_dst_port) {
  if (!buf || len < 4) return -1;
  if (out_src_port) *out_src_port = 5683;
  if (out_dst_port) *out_dst_port = 5683;

  auto parse_ports = [](const uint8_t *p, uint8_t nhc, uint16_t *s_port, uint16_t *d_port) {
    uint8_t ports_code = nhc & 0x03;
    if (ports_code == 0) {
      if (s_port) *s_port = ((uint16_t)p[0] << 8) | p[1];
      if (d_port) *d_port = ((uint16_t)p[2] << 8) | p[3];
    } else if (ports_code == 1) {
      if (s_port) *s_port = ((uint16_t)p[0] << 8) | p[1];
      if (d_port) *d_port = 0xF000 | p[2];
    } else if (ports_code == 2) {
      if (s_port) *s_port = 0xF000 | p[0];
      if (d_port) *d_port = ((uint16_t)p[1] << 8) | p[2];
    } else if (ports_code == 3) {
      if (s_port) *s_port = 0xF0B0 | ((p[0] >> 4) & 0x0F);
      if (d_port) *d_port = 0xF0B0 | (p[0] & 0x0F);
    }
  };

  // Case 1: Tado standard unicast framing (pt[3] == 0x04)
  if (buf[3] == 0x04 && len >= 9) {
    uint8_t disp = buf[8];
    if (disp == 0x7E && len >= 17) {
      // Uncompressed UDP: dispatch 0x7E, 8-byte NHC -> CoAP starts at 17
      if (buf[9] == 0x33) {
        if ((buf[10] & 0xF8) == 0xF0 && len >= 17) {
          parse_ports(buf + 11, buf[10], out_src_port, out_dst_port);
          return 17;
        }
      }
    } else if (disp == 0x7C && len >= 12) {
      // Compressed UDP header (0x7C 0x00 0xD7) -> CoAP starts at 12
      if (buf[9] == 0x00 && buf[10] == 0xD7) return 12;
    } else if ((disp & 0xF8) == 0xC0 && len >= 13) {
      // FRAG1 inside Tado framing
      int sub = find_coap_offset(buf + 12, len - 12, out_src_port, out_dst_port);
      if (sub != -1) return 12 + sub;
    }
  }

  // Case 2: Direct 6LoWPAN dispatch at pt[3]
  uint8_t d3 = buf[3];
  if (d3 == 0x7E && len >= 12) {
    if (buf[4] == 0x33) {
      if ((buf[5] & 0xF8) == 0xF0 && len >= 12) {
        parse_ports(buf + 6, buf[5], out_src_port, out_dst_port);
        return 12;
      }
    }
  } else if (d3 == 0x7C && len >= 7) {
    if (buf[4] == 0x00 && buf[5] == 0xD7) return 7;
  } else if ((d3 & 0xF8) == 0xC0 && len >= 8) {
    // FRAG1 direct
    int sub = find_coap_offset(buf + 7, len - 7, out_src_port, out_dst_port);
    if (sub != -1) return 7 + sub;
  }

  return -1;
}

static void mac_to_ipv6(const uint8_t *mac, uint8_t *ip) {
  std::memset(ip, 0, 16);
  if (!mac || (mac[0] == 0xFF && mac[7] == 0xFF)) {
    // All-routers multicast ff02::2 (RFC 4861 Router Solicitation)
    ip[0] = 0xFF;
    ip[1] = 0x02;
    ip[15] = 0x02;
    return;
  }
  ip[0] = 0xFE;
  ip[1] = 0x80;
  // Wire format is LE, reverse to get BE MAC:
  // e.g. 00:1b:c5:07:... -> ip[8] = mac[7] ^ 0x02, ip[9] = mac[6], ip[10] = mac[5], etc.
  ip[8] = mac[7] ^ 0x02;
  ip[9] = mac[6];
  ip[10] = mac[5];
  ip[11] = mac[4];
  ip[12] = mac[3];
  ip[13] = mac[2];
  ip[14] = mac[1];
  ip[15] = mac[0];
}

uint16_t compute_ipv6_checksum(const uint8_t *src_mac, const uint8_t *dst_mac, uint8_t proto,
                              const uint8_t *payload, size_t len) {
  uint8_t src_ip[16], dst_ip[16];
  mac_to_ipv6(src_mac, src_ip);
  mac_to_ipv6(dst_mac, dst_ip);

  uint32_t sum = 0;
  // Pseudo-header: IPv6 src + dst
  for (size_t i = 0; i < 16; i += 2) {
    sum += ((uint16_t)src_ip[i] << 8) | src_ip[i + 1];
    sum += ((uint16_t)dst_ip[i] << 8) | dst_ip[i + 1];
  }
  // Length (uint32)
  sum += (uint16_t)(len >> 16);
  sum += (uint16_t)(len & 0xFFFF);
  // Next Header / Protocol
  sum += proto;

  // Payload bytes
  for (size_t i = 0; i < len; i += 2) {
    if (i + 1 < len) {
      sum += ((uint16_t)payload[i] << 8) | payload[i + 1];
    } else {
      sum += ((uint16_t)payload[i] << 8);
    }
  }

  while (sum >> 16) {
    sum = (sum & 0xFFFF) + (sum >> 16);
  }
  return ~((uint16_t)sum);
}

std::vector<uint8_t> encapsulate_6lowpan_udp(const uint8_t *coap_data, size_t coap_len,
                                            const uint8_t *src_mac, const uint8_t *dst_mac,
                                            uint16_t src_port, uint16_t dst_port,
                                            uint8_t dispatch_mode) {
  std::vector<uint8_t> pt;

  // 1. MAC suffix (3 bytes in LE: src_mac[5..7])
  pt.push_back(src_mac[5]);
  pt.push_back(src_mac[6]);
  pt.push_back(src_mac[7]);

  // 2. Inner Protocol Header (0x04)
  pt.push_back(0x04);

  // 3. Sequence Counter (1 byte)
  static uint8_t s_proto_seq = 1;
  pt.push_back(s_proto_seq++);

  // 4. 4-byte Tado Custom Dispatch: [short_addr_le:2][cluster:1][mode:1]
  uint16_t short_addr = src_mac[0] | ((uint16_t)src_mac[1] << 8);
  pt.push_back(short_addr & 0xFF);
  pt.push_back((short_addr >> 8) & 0xFF);
  pt.push_back(0x00); // Subnetwork / cluster
  pt.push_back(dispatch_mode); // 0x7E (Pairing/Uncompressed) or 0x7A (Operational)

  // 5. Compute UDP Checksum over pseudo-header
  std::vector<uint8_t> udp_pkt;
  udp_pkt.push_back((src_port >> 8) & 0xFF);
  udp_pkt.push_back(src_port & 0xFF);
  udp_pkt.push_back((dst_port >> 8) & 0xFF);
  udp_pkt.push_back(dst_port & 0xFF);
  uint16_t ulen = 8 + coap_len;
  udp_pkt.push_back((ulen >> 8) & 0xFF);
  udp_pkt.push_back(ulen & 0xFF);
  udp_pkt.push_back(0x00);
  udp_pkt.push_back(0x00); // Zero checksum during computation
  udp_pkt.insert(udp_pkt.end(), coap_data, coap_data + coap_len);

  uint16_t csum = compute_ipv6_checksum(src_mac, dst_mac, 17, udp_pkt.data(), udp_pkt.size());

  // 6. 6LoWPAN UDP NHC (8 bytes: [0x33, 0xF0, src_port:2, dst_port:2, csum:2])
  pt.push_back(0x33);
  pt.push_back(0xF0);
  pt.push_back((src_port >> 8) & 0xFF);
  pt.push_back(src_port & 0xFF);
  pt.push_back((dst_port >> 8) & 0xFF);
  pt.push_back(dst_port & 0xFF);
  pt.push_back((csum >> 8) & 0xFF);
  pt.push_back(csum & 0xFF);

  // 7. CoAP Datagram
  pt.insert(pt.end(), coap_data, coap_data + coap_len);

  return pt;
}

// ---------------------------------------------------------------------------
// ICMPv6 Stack
// ---------------------------------------------------------------------------

bool parse_icmpv6(const uint8_t *buf, size_t len, ParsedICMPv6 &out) {
  if (!buf || len < 8) return false;

  int offset = -1;

  // Case 1: Tado standard unicast framing (pt[3] == 0x04)
  if (buf[3] == 0x04 && len >= 13 && (buf[8] == 0x7A || buf[8] == 0x7B)) {
    if (buf[9] == 0x33 && buf[10] == 0x3A) {
      offset = 11;
    } else if ((buf[9] == 0xF7 || buf[9] == 0xF3) && buf[11] == 0x3A) {
      offset = 12;
    }
  }
  // Case 2: Direct 6LoWPAN 0x3B (RA, RS)
  else if (len >= 10 && buf[3] == 0x3B && buf[4] == 0x3A) {
    offset = 6;
  }
  // Case 3: Direct 6LoWPAN 0x39 (NS)
  else if (len >= 15 && buf[3] == 0x39 && buf[4] == 0x3A) {
    offset = 11;
  }
  // Case 4: Direct 6LoWPAN 0xF9 (NS)
  else if (len >= 16 && buf[3] == 0xF9 && buf[5] == 0x3A) {
    offset = 12;
  }

  if (offset == -1 || (size_t)offset + 4 > len) return false;

  out.type = buf[offset];
  out.code = buf[offset + 1];
  out.checksum = ((uint16_t)buf[offset + 2] << 8) | buf[offset + 3];

  size_t body_len = len - (offset + 4);
  out.body.assign(buf + offset + 4, buf + len);

  if (out.type == ICMPV6_TYPE_ECHO_REQUEST || out.type == ICMPV6_TYPE_ECHO_REPLY) {
    if (body_len >= 4) {
      out.identifier = ((uint16_t)out.body[0] << 8) | out.body[1];
      out.sequence = ((uint16_t)out.body[2] << 8) | out.body[3];
    }
  }

  out.ok = true;
  return true;
}

std::vector<uint8_t> build_echo_request(uint16_t id, uint16_t seq, const uint8_t *body_data, size_t body_len,
                                       const uint8_t *src_mac, const uint8_t *dst_mac) {
  std::vector<uint8_t> icmp;
  icmp.push_back(ICMPV6_TYPE_ECHO_REQUEST); // 128
  icmp.push_back(0);                       // Code 0
  icmp.push_back(0);                       // Checksum placeholder MSB
  icmp.push_back(0);                       // Checksum placeholder LSB
  icmp.push_back((id >> 8) & 0xFF);
  icmp.push_back(id & 0xFF);
  icmp.push_back((seq >> 8) & 0xFF);
  icmp.push_back(seq & 0xFF);
  if (body_data && body_len > 0) {
    icmp.insert(icmp.end(), body_data, body_data + body_len);
  }

  // Checksum over pseudo-header + ICMPv6
  uint16_t csum = compute_ipv6_checksum(src_mac, dst_mac, 58, icmp.data(), icmp.size());
  icmp[2] = (csum >> 8) & 0xFF;
  icmp[3] = csum & 0xFF;

  // Wrap in Tado 6LoWPAN IPHC Mode 0x7B
  std::vector<uint8_t> pt;
  pt.push_back(src_mac[5]); pt.push_back(src_mac[6]); pt.push_back(src_mac[7]);
  pt.push_back(0x04);
  pt.push_back(0x01);
  uint16_t short_addr = src_mac[0] | ((uint16_t)src_mac[1] << 8);
  pt.push_back(short_addr & 0xFF); pt.push_back((short_addr >> 8) & 0xFF);
  pt.push_back(0x00);
  pt.push_back(0x7B); // Dispatch 0x7B
  pt.push_back(0x33);
  pt.push_back(0x3A); // Next Header = 58 (0x3A)
  pt.insert(pt.end(), icmp.begin(), icmp.end());

  return pt;
}

std::vector<uint8_t> build_echo_reply(uint16_t id, uint16_t seq, const uint8_t *body_data, size_t body_len,
                                     const uint8_t *src_mac, const uint8_t *dst_mac) {
  std::vector<uint8_t> icmp;
  icmp.push_back(ICMPV6_TYPE_ECHO_REPLY); // 129
  icmp.push_back(0);                     // Code 0
  icmp.push_back(0);                     // Checksum placeholder MSB
  icmp.push_back(0);                     // Checksum placeholder LSB
  icmp.push_back((id >> 8) & 0xFF);
  icmp.push_back(id & 0xFF);
  icmp.push_back((seq >> 8) & 0xFF);
  icmp.push_back(seq & 0xFF);
  if (body_data && body_len > 4) {
    icmp.insert(icmp.end(), body_data + 4, body_data + body_len);
  }

  // Checksum over pseudo-header + ICMPv6
  uint16_t csum = compute_ipv6_checksum(src_mac, dst_mac, 58, icmp.data(), icmp.size());
  icmp[2] = (csum >> 8) & 0xFF;
  icmp[3] = csum & 0xFF;

  // Wrap in Tado 6LoWPAN IPHC Mode 0x7B
  std::vector<uint8_t> pt;
  pt.push_back(src_mac[5]); pt.push_back(src_mac[6]); pt.push_back(src_mac[7]);
  pt.push_back(0x04);
  pt.push_back(0x01);
  uint16_t short_addr = src_mac[0] | ((uint16_t)src_mac[1] << 8);
  pt.push_back(short_addr & 0xFF); pt.push_back((short_addr >> 8) & 0xFF);
  pt.push_back(0x00);
  pt.push_back(0x7B); // Dispatch 0x7B
  pt.push_back(0x33);
  pt.push_back(0x3A); // Next Header = 58 (0x3A)
  pt.insert(pt.end(), icmp.begin(), icmp.end());

  return pt;
}

std::vector<uint8_t> build_router_solicitation(const uint8_t *src_mac, const uint8_t *dst_mac) {
  // Router Solicitation message: 8B header + 16B Option 1 (RFC 4861 Source link-layer address)
  std::vector<uint8_t> icmp(24, 0);
  icmp[0] = ICMPV6_TYPE_ROUTER_SOLICIT; // 133 (0x85)
  icmp[1] = 0;                         // Code 0
  // Checksum placeholder at [2..3]
  // Reserved at [4..7]

  // Option 1: Type 1, Length 2 (16 bytes)
  icmp[8] = 0x01;
  icmp[9] = 0x02;
  // Big-Endian Source MAC
  if (src_mac) {
    for (int i = 0; i < 8; i++) {
      icmp[10 + i] = src_mac[7 - i];
    }
  }
  // Remaining 6 bytes zero padding [18..23]

  uint16_t csum = compute_ipv6_checksum(src_mac, dst_mac, 58, icmp.data(), icmp.size());
  icmp[2] = (csum >> 8) & 0xFF;
  icmp[3] = csum & 0xFF;

  // Prefix 6LoWPAN IPHC framing: [0x00, 0x00, 0x7B, 0x3B, 0x3A, 0x02] matching real wire capture 3449e840...
  std::vector<uint8_t> pt = {0x00, 0x00, 0x7B, 0x3B, 0x3A, 0x02};
  pt.insert(pt.end(), icmp.begin(), icmp.end());

  return pt;
}

std::vector<uint8_t> build_neighbor_advertisement(const uint8_t *src_mac, const uint8_t *dst_mac) {
  std::vector<uint8_t> icmp;
  icmp.push_back(ICMPV6_TYPE_NEIGHBOR_ADVERT); // 136
  icmp.push_back(0);                          // Code 0
  icmp.push_back(0);                          // Checksum MSB
  icmp.push_back(0);                          // Checksum LSB
  icmp.push_back(0x60);                       // Flags (Solicited + Override)
  icmp.push_back(0); icmp.push_back(0); icmp.push_back(0);

  // Target IPv6 (our link-local address)
  uint8_t target_ip[16];
  mac_to_ipv6(src_mac, target_ip);
  icmp.insert(icmp.end(), target_ip, target_ip + 16);

  // Option 2: Target Link-Layer Address (8 bytes EUI-64)
  icmp.push_back(0x02); // Option Type 2
  icmp.push_back(0x02); // Length 2 (16 bytes)
  for (int i = 7; i >= 0; i--) icmp.push_back(src_mac[i]); // Big-endian EUI-64
  for (int i = 0; i < 6; i++) icmp.push_back(0x00);        // Pad to 16 bytes

  uint16_t csum = compute_ipv6_checksum(src_mac, dst_mac, 58, icmp.data(), icmp.size());
  icmp[2] = (csum >> 8) & 0xFF;
  icmp[3] = csum & 0xFF;

  std::vector<uint8_t> pt;
  pt.push_back(src_mac[5]); pt.push_back(src_mac[6]); pt.push_back(src_mac[7]);
  pt.push_back(0x04);
  pt.push_back(0x01);
  uint16_t short_addr = src_mac[0] | ((uint16_t)src_mac[1] << 8);
  pt.push_back(short_addr & 0xFF); pt.push_back((short_addr >> 8) & 0xFF);
  pt.push_back(0x00);
  pt.push_back(0x7B);
  pt.push_back(0x33);
  pt.push_back(0x3A);
  pt.insert(pt.end(), icmp.begin(), icmp.end());

  return pt;
}

// ---------------------------------------------------------------------------
// RFC 7252 CoAP
// ---------------------------------------------------------------------------

ParsedCoAP parse_coap(const uint8_t *data, size_t len) {
  ParsedCoAP out;
  if (!data || len < 4) return out;

  out.ver = (data[0] >> 6) & 0x03;
  out.type = (data[0] >> 4) & 0x03;
  uint8_t tkl = data[0] & 0x0F;
  out.code = data[1];
  out.mid = ((uint16_t)data[2] << 8) | data[3];

  size_t cur = 4;
  if (cur + tkl > len) return out;
  if (tkl > 0) {
    out.token.assign(data + cur, data + cur + tkl);
    cur += tkl;
  }

  uint16_t opt_num = 0;
  while (cur < len) {
    if (data[cur] == 0xFF) {
      cur++; // Payload marker
      break;
    }

    uint8_t delta4 = (data[cur] >> 4) & 0x0F;
    uint8_t len4 = data[cur] & 0x0F;
    cur++;

    if (delta4 == 15 || len4 == 15) {
      // Reserved or trailing marker scan
      while (cur < len && data[cur] != 0xFF) cur++;
      if (cur < len && data[cur] == 0xFF) cur++;
      break;
    }

    uint16_t delta = delta4;
    if (delta4 == 13) {
      if (cur >= len) break;
      delta = 13 + data[cur++];
    } else if (delta4 == 14) {
      if (cur + 1 >= len) break;
      delta = 269 + (((uint16_t)data[cur] << 8) | data[cur + 1]);
      cur += 2;
    }

    uint16_t opt_len = len4;
    if (len4 == 13) {
      if (cur >= len) break;
      opt_len = 13 + data[cur++];
    } else if (len4 == 14) {
      if (cur + 1 >= len) break;
      opt_len = 269 + (((uint16_t)data[cur] << 8) | data[cur + 1]);
      cur += 2;
    }

    opt_num += delta;
    if (cur + opt_len > len) break;

    ParsedCoAPOption opt;
    opt.num = opt_num;
    opt.value.assign(data + cur, data + cur + opt_len);
    cur += opt_len;
    out.options.push_back(opt);

    if (opt_num == COAP_OPT_URI_PATH) {
      std::string seg((const char *)opt.value.data(), opt.value.size());
      if (!out.uri_path.empty()) out.uri_path += "/";
      out.uri_path += seg;
    }
  }

  // Remaining bytes are payload (strip Kermit CRC-16 trailer if present on empty ACK)
  if (cur < len) {
    size_t pl_len = len - cur;
    if (out.code == COAP_CODE_EMPTY && pl_len == 2) {
      // Kermit CRC16 trailer on empty ACK, discard
    } else if (out.code == COAP_CODE_EMPTY && pl_len >= 4 && data[cur] == 0xC1 && data[cur + 1] == 0x2A) {
      // 60 44 <mid> c1 2a <crc16>
    } else {
      out.payload.assign(data + cur, data + len);
    }
  }

  out.ok = (out.ver == 1);
  return out;
}

std::vector<uint8_t> serialize_coap(uint8_t type, uint8_t code, uint16_t mid,
                                   const uint8_t *token, size_t token_len,
                                   const std::string &uri_path,
                                   const uint8_t *payload, size_t payload_len,
                                   const uint8_t *session_token,
                                   int32_t block2_num, uint8_t block2_szx) {
  std::vector<uint8_t> coap;
  uint8_t tkl = (uint8_t)std::min(token_len, (size_t)8);
  coap.push_back((1 << 6) | ((type & 0x03) << 4) | (tkl & 0x0F));
  coap.push_back(code);
  coap.push_back((mid >> 8) & 0xFF);
  coap.push_back(mid & 0xFF);

  if (tkl > 0 && token) {
    coap.insert(coap.end(), token, token + tkl);
  }

  uint16_t last_opt = 0;

  // Option 11: Uri-Path
  if (!uri_path.empty()) {
    size_t start = 0;
    while (start < uri_path.length()) {
      size_t slash = uri_path.find('/', start);
      std::string seg = (slash == std::string::npos) ? uri_path.substr(start) : uri_path.substr(start, slash - start);
      uint16_t delta = 11 - last_opt;
      coap.push_back(((delta & 0x0F) << 4) | ((uint8_t)seg.length() & 0x0F));
      for (char c : seg) coap.push_back((uint8_t)c);
      last_opt = 11;
      if (slash == std::string::npos) break;
      start = slash + 1;
    }
  }

  // Option 12: Content-Format = 42 (Binary TLV)
  if (payload && payload_len > 0) {
    uint16_t delta = 12 - last_opt;
    coap.push_back(((delta & 0x0F) << 4) | 0x01);
    coap.push_back(0x2A); // 42
    last_opt = 12;
  }

  // Option 23: Block2
  if (block2_num >= 0) {
    uint32_t b2_val = ((uint32_t)block2_num << 4) | (0 << 3) | (block2_szx & 0x07);
    uint16_t delta = 23 - last_opt;
    if (b2_val <= 0xFF) {
      coap.push_back(((delta & 0x0F) << 4) | 0x01);
      coap.push_back((uint8_t)b2_val);
    } else if (b2_val <= 0xFFFF) {
      coap.push_back(((delta & 0x0F) << 4) | 0x02);
      coap.push_back((b2_val >> 8) & 0xFF);
      coap.push_back(b2_val & 0xFF);
    }
    last_opt = 23;
  }

  // Option 2048: Session Token
  if (session_token) {
    uint16_t delta = 2048 - last_opt;
    uint16_t ext_delta = delta - 269;
    coap.push_back(0xE8); // Delta=14 (ext 2 bytes), Length=8
    coap.push_back((ext_delta >> 8) & 0xFF);
    coap.push_back(ext_delta & 0xFF);
    for (int i = 0; i < 8; i++) coap.push_back(session_token[i]);
    last_opt = 2048;
  }

  // Payload Marker & Payload
  if (payload && payload_len > 0) {
    coap.push_back(0xFF);
    coap.insert(coap.end(), payload, payload + payload_len);
  }

  return coap;
}

std::vector<uint8_t> build_coap_ack(uint16_t mid, uint8_t code, const uint8_t *token, size_t token_len,
                                   const uint8_t *payload, size_t payload_len) {
  std::vector<uint8_t> coap;
  uint8_t tkl = (uint8_t)std::min(token_len, (size_t)8);
  coap.push_back((1 << 6) | ((COAP_TYPE_ACK & 0x03) << 4) | (tkl & 0x0F));
  coap.push_back(code);
  coap.push_back((mid >> 8) & 0xFF);
  coap.push_back(mid & 0xFF);
  for (size_t i = 0; i < tkl; i++) coap.push_back(token[i]);

  if (payload && payload_len > 0) {
    // Option 12: Content-Format 42 (0xC1, 0x2A)
    coap.push_back(0xC1);
    coap.push_back(0x2A);
    coap.push_back(0xFF);
    coap.insert(coap.end(), payload, payload + payload_len);
  }
  return coap;
}

// ---------------------------------------------------------------------------
// TLV Primitives & High-Level Builders
// ---------------------------------------------------------------------------

void append_tlv_u8(std::vector<uint8_t> &out, uint16_t tag, uint8_t val) {
  out.push_back((tag >> 8) & 0xFF);
  out.push_back(tag & 0xFF);
  out.push_back(1);
  out.push_back(val);
}

void append_tlv_u16(std::vector<uint8_t> &out, uint16_t tag, uint16_t val) {
  out.push_back((tag >> 8) & 0xFF);
  out.push_back(tag & 0xFF);
  out.push_back(2);
  out.push_back((val >> 8) & 0xFF);
  out.push_back(val & 0xFF);
}

void append_tlv_s16(std::vector<uint8_t> &out, uint16_t tag, int16_t val) {
  out.push_back((tag >> 8) & 0xFF);
  out.push_back(tag & 0xFF);
  out.push_back(2);
  out.push_back((val >> 8) & 0xFF);
  out.push_back(val & 0xFF);
}

void append_tlv_u32(std::vector<uint8_t> &out, uint16_t tag, uint32_t val) {
  out.push_back((tag >> 8) & 0xFF);
  out.push_back(tag & 0xFF);
  out.push_back(4);
  out.push_back((val >> 24) & 0xFF);
  out.push_back((val >> 16) & 0xFF);
  out.push_back((val >> 8) & 0xFF);
  out.push_back(val & 0xFF);
}

void append_tlv_string(std::vector<uint8_t> &out, uint16_t tag, const std::string &str) {
  out.push_back((tag >> 8) & 0xFF);
  out.push_back(tag & 0xFF);
  out.push_back((uint8_t)str.length());
  for (char c : str) out.push_back((uint8_t)c);
}

void append_tlv_bytes(std::vector<uint8_t> &out, uint16_t tag, const uint8_t *data, size_t len) {
  out.push_back((tag >> 8) & 0xFF);
  out.push_back(tag & 0xFF);
  out.push_back((uint8_t)len);
  for (size_t i = 0; i < len; i++) out.push_back(data[i]);
}

std::vector<TLVEntry> parse_tlvs_1byte(const uint8_t *data, size_t len) {
  std::vector<TLVEntry> entries;
  if (!data || len < 2) return entries;

  size_t cur = 0;
  while (cur + 2 <= len) {
    uint16_t tag = data[cur];
    uint8_t tlen = data[cur + 1];
    cur += 2;
    if (cur + tlen > len) break;

    TLVEntry e;
    e.tag = tag;
    e.value.assign(data + cur, data + cur + tlen);
    cur += tlen;
    entries.push_back(e);
  }
  return entries;
}

std::vector<TLVEntry> parse_tlvs_2byte(const uint8_t *data, size_t len) {
  std::vector<TLVEntry> entries;
  if (!data || len < 3) return entries;

  size_t cur = 0;
  while (cur + 3 <= len) {
    uint16_t tag = ((uint16_t)data[cur] << 8) | data[cur + 1];
    uint8_t tlen = data[cur + 2];
    cur += 3;
    if (cur + tlen > len) break;

    TLVEntry e;
    e.tag = tag;
    e.value.assign(data + cur, data + cur + tlen);
    cur += tlen;
    entries.push_back(e);
  }
  return entries;
}

std::vector<TLVEntry> parse_tlvs(const uint8_t *data, size_t len) {
  // Standard telemetry and reports use 2-byte tag headers
  std::vector<TLVEntry> entries = parse_tlvs_2byte(data, len);
  if (!entries.empty()) return entries;
  // Fall back to 1-byte tag headers used for /d/pair
  return parse_tlvs_1byte(data, len);
}

bool tlv_lookup_1byte_field(const uint8_t *data, size_t len, uint8_t tag, std::vector<uint8_t> &out_val) {
  auto entries = parse_tlvs_1byte(data, len);
  for (const auto &e : entries) {
    if (e.tag == tag) {
      out_val = e.value;
      return true;
    }
  }
  return false;
}

bool tlv_lookup_2byte_field(const uint8_t *data, size_t len, uint16_t tag, std::vector<uint8_t> &out_val) {
  auto entries = parse_tlvs_2byte(data, len);
  for (const auto &e : entries) {
    if (e.tag == tag) {
      out_val = e.value;
      return true;
    }
  }
  return false;
}

std::vector<uint8_t> build_d_sen_tlv(float temp_c, float hum_pct, uint16_t battery_mv,
                                    uint16_t light_adc, uint16_t ot_volt_mv, uint8_t status_flags) {
  std::vector<uint8_t> tlv;
  int16_t temp_val = (int16_t)(temp_c * 100.0f);
  int16_t aux_temp_val = temp_val;
  uint16_t hum_val = (uint16_t)(hum_pct * 10.0f);
  uint8_t light_level = (uint8_t)(light_adc > 255 ? (light_adc / 1000) : light_adc);

  // 1. 0x0161: OpenTherm loop voltage in mV
  append_tlv_u16(tlv, TLV_OPENTHERM_VOLTAGE, ot_volt_mv);
  // 2. 0x0162: Battery voltage in mV
  append_tlv_u16(tlv, TLV_BATTERY_MV, battery_mv);
  // 3. 0x012d: Ambient temperature (°C * 100)
  append_tlv_s16(tlv, TLV_TEMP_AMBIENT, temp_val);
  // 4. 0x012e: Secondary / aux temperature
  append_tlv_s16(tlv, TLV_TEMP_AUX, aux_temp_val);
  // 5. 0x01c8: Raw ambient light ADC
  append_tlv_u16(tlv, TLV_LIGHT_ADC_RAW, light_adc);
  // 6. 0x0135: Humidity (%RH * 10)
  append_tlv_u16(tlv, TLV_HUMIDITY_PERCENT, hum_val);
  // 7. 0x0136: Ambient light level (0-15 scale)
  append_tlv_u8(tlv, TLV_AMBIENT_LIGHT_LEVEL, light_level);
  // 8. 0x027a: Status / error flags (0 = normal)
  append_tlv_u8(tlv, TLV_DEVICE_STATUS_FLAGS, status_flags);

  return tlv;
}

std::vector<uint8_t> build_z_p_tlv(float temp_c, float hum_pct) {
  std::vector<uint8_t> tlv;
  int16_t temp_val = (int16_t)(temp_c * 100.0f);
  uint16_t hum_val = (uint16_t)(hum_pct * 10.0f);

  append_tlv_s16(tlv, TLV_ZONE_TEMP_4060, temp_val);
  append_tlv_u8(tlv, TLV_ZONE_DEMAND_40A0, 0); // 0% demand / auto
  append_tlv_u16(tlv, TLV_HUMIDITY_PERCENT, hum_val);

  return tlv;
}

std::vector<uint8_t> build_d_lock_tlv(bool locked) {
  std::vector<uint8_t> tlv;
  append_tlv_u8(tlv, TLV_CHILD_LOCK, locked ? 1 : 0);
  return tlv;
}

std::vector<uint8_t> build_d_fw_state_tlv(uint16_t fw_version, uint16_t other_slot, const std::string &build_id) {
  std::vector<uint8_t> tlv;
  append_tlv_u8(tlv, TLV_FW_STATE_1A0, 8);
  append_tlv_u16(tlv, TLV_FW_VERSION_ACTIVE, fw_version);
  // ponytail: 0x003B is dual-purpose — timezone offset (s16be) in /time, but boot slot info (u8) in fw/state.
  append_tlv_u8(tlv, TLV_TIME_TZ_OFFSET, 14);
  append_tlv_u16(tlv, TLV_FW_OTHER_SLOT, other_slot);
  append_tlv_u16(tlv, TLV_FW_TARGET_OR_REPORTED, fw_version);
  append_tlv_u8(tlv, TLV_DEV_TYPE_CODE, 10); // RU02 = 10
  append_tlv_u8(tlv, TLV_FW_STATE_AUX, 14);
  append_tlv_string(tlv, TLV_FW_BUILD_ID, build_id);
  return tlv;
}

} // namespace protocol
} // namespace tado_emulator
} // namespace esphome
