/**
 * @file rf_protocol.h
 * @brief IEEE 802.15.4 MAC, AES-128-CCM, 6LoWPAN, ICMPv6, CoAP, and TLV protocol engine.
 */

#pragma once

#include <cstdint>
#include <cstddef>
#include <vector>
#include <string>
#include <cstring>

namespace esphome {
namespace tado_emulator {

// IEEE 802.15.4 Constants
constexpr uint16_t MAC_FCF_DATA_SECURITY = 0xEC69; // LE: 0x69, 0xEC (Operational Unicast Data Frame)
constexpr uint16_t MAC_FCF_CSL_BEACON = 0x0025;   // LE: 0x25, 0x00 (CSL Multipurpose Wake-up Beacon)
constexpr uint16_t MAC_FCF_COORD_FRAME = 0xEE42;  // LE: 0x42, 0xEE (Extended MAC Coordination Frame)
constexpr uint16_t MAC_FCF_MAC_ACK = 0x0002;      // 802.15.4 MAC ACK

// Tado Pairing / Bootstrap Key: ASCII "tado pairing key"
extern const uint8_t PAIRING_KEY[16];

// CoAP RFC 7252 Constants
enum CoAPType : uint8_t {
  COAP_TYPE_CON = 0,
  COAP_TYPE_NON = 1,
  COAP_TYPE_ACK = 2,
  COAP_TYPE_RST = 3
};

enum CoAPCode : uint8_t {
  COAP_CODE_EMPTY = 0,
  COAP_CODE_GET = 1,
  COAP_CODE_POST = 2,
  COAP_CODE_PUT = 3,
  COAP_CODE_DELETE = 4,
  COAP_CODE_CREATED = 0x41, // 2.01
  COAP_CODE_DELETED = 0x42, // 2.02
  COAP_CODE_VALID = 0x43,   // 2.03
  COAP_CODE_CHANGED = 0x44, // 2.04
  COAP_CODE_CONTENT = 0x45  // 2.05
};

enum CoAPOptionNum : uint16_t {
  COAP_OPT_URI_PATH = 11,
  COAP_OPT_CONTENT_FORMAT = 12,
  COAP_OPT_BLOCK2 = 23,
  COAP_OPT_SESSION_TOKEN = 2048
};

// ICMPv6 RFC 4443 & 4861 Types
enum ICMPv6Type : uint8_t {
  ICMPV6_TYPE_ECHO_REQUEST = 128,
  ICMPV6_TYPE_ECHO_REPLY = 129,
  ICMPV6_TYPE_ROUTER_SOLICIT = 133,
  ICMPV6_TYPE_ROUTER_ADVERT = 134,
  ICMPV6_TYPE_NEIGHBOR_SOLICIT = 135,
  ICMPV6_TYPE_NEIGHBOR_ADVERT = 136
};

// Tado TLV Field Identifiers (FIDs)
enum TLVTag : uint16_t {
  TLV_PAIR_STOP_0000 = 0x0000,
  TLV_REPORTED_RF_KEY = 0x0003,
  TLV_CLIENT_NONCE = 0x0007,
  TLV_PAIRING_RAW_OP_KEY = 0x0012, // 16-byte raw plaintext op_key
  TLV_TIME_UTC = 0x0033,
  TLV_FW_OTHER_SLOT = 0x0035,
  TLV_DEV_TYPE_CODE = 0x0036,
  TLV_FW_TARGET_OR_REPORTED = 0x0039,
  TLV_FW_VERSION_ACTIVE = 0x003a,
  TLV_TIME_TZ_OFFSET = 0x003b,
  TLV_FW_STATE_AUX = 0x003c,
  TLV_TEMP_AMBIENT = 0x012d,     // s16be, scale 0.01 (°C * 100)
  TLV_TEMP_AUX = 0x012e,         // s16be, scale 0.01
  TLV_HUMIDITY_PERCENT = 0x0135, // u16be, scale 0.1 (%RH * 10)
  TLV_AMBIENT_LIGHT_LEVEL = 0x0136, // u8
  TLV_SLOT_NUM = 0x0180,         // u8
  TLV_FW_STATE_1A0 = 0x01a0,     // u8
  TLV_LIGHT_ADC_RAW = 0x01c8,    // u16be
  TLV_OPENTHERM_VOLTAGE = 0x0161,// u16be, mV (OpenTherm loop voltage)
  TLV_BATTERY_MV = 0x0162,       // u16be, mV
  TLV_RESET_REASON = 0x0160,     // u8/u16be STM32 CSR reset flags
  TLV_DEVICE_STATUS_FLAGS = 0x027a, // u8
  TLV_CHILD_LOCK = 0x0290,       // bool (0x0290 va_child_lock_enabled)
  TLV_FW_BUILD_ID = 0x0210,      // ASCII commit hash string
  TLV_ACTUATOR_ACTIVE = 0x028c,  // bool
  TLV_ZONE_TEMP_4060 = 0x4060,   // s16be, scale 0.01
  TLV_ZONE_DEMAND_40A0 = 0x40a0  // u8, %
};

// Decoded Frame Structures
struct ParsedMac {
  bool valid{false};
  uint16_t fcf{0};
  uint8_t seq{0};
  uint16_t pan_id{0xFFFF};
  uint8_t dst_mac[8]{0};
  uint8_t src_mac[8]{0};
  bool is_broadcast{false};
  uint8_t header_len{16};
};

struct ParsedCoAPOption {
  uint16_t num{0};
  std::vector<uint8_t> value;
};

struct ParsedCoAP {
  bool ok{false};
  uint8_t ver{1};
  uint8_t type{0};
  uint8_t code{0};
  uint16_t mid{0};
  uint16_t src_port{5683};
  uint16_t dst_port{5683};
  std::vector<uint8_t> token;
  std::vector<ParsedCoAPOption> options;
  std::string uri_path;
  std::vector<uint8_t> payload;
};

struct ParsedICMPv6 {
  bool ok{false};
  uint8_t type{0};
  uint8_t code{0};
  uint16_t checksum{0};
  uint16_t identifier{0};
  uint16_t sequence{0};
  std::vector<uint8_t> body;
};

struct TLVEntry {
  uint16_t tag{0};
  std::vector<uint8_t> value;
};

// Protocol Functions
namespace protocol {

// CRC-16 Kermit
uint16_t crc16_kermit(const uint8_t *data, size_t len);
uint16_t crc16_kermit(const uint8_t *h16, const uint8_t *pt, size_t pt_len);

// MAC Framing
bool parse_mac_header(const uint8_t *frame, size_t len, const uint8_t *decrypted, size_t dec_len, ParsedMac &out);
std::vector<uint8_t> build_mac_header(uint8_t seq, const uint8_t *src_mac, const uint8_t *dst_mac, bool ack_req = true);
bool is_csl_beacon(const uint8_t *frame, size_t len);
bool parse_csl_beacon(const uint8_t *frame, size_t len, uint8_t &seq, uint16_t &pan_id, uint16_t &dst_short, uint16_t &countdown);
std::vector<uint8_t> build_csl_data_poll(uint8_t seq, uint16_t pan_id, const uint8_t *src_mac, uint16_t dst_short);

// Cryptography (AES-128-CCM & AES-128-ECB)
bool decrypt_ccm(const uint8_t *frame, size_t len, const uint8_t *key, std::vector<uint8_t> &out_plaintext, bool verify_crc = false);
std::vector<uint8_t> encrypt_ccm(const uint8_t *header_16b, const uint8_t *plaintext, size_t pt_len, const uint8_t *key);
bool decrypt_aes128_ecb(const uint8_t *ciphertext_16b, const uint8_t *key, uint8_t *out_plaintext_16b);

// 6LoWPAN IPHC / NHC
int find_coap_offset(const uint8_t *buf, size_t len, uint16_t *out_src_port = nullptr, uint16_t *out_dst_port = nullptr);
std::vector<uint8_t> encapsulate_6lowpan_udp(const uint8_t *coap_data, size_t coap_len,
                                            const uint8_t *src_mac, const uint8_t *dst_mac,
                                            uint16_t src_port = 5683, uint16_t dst_port = 4005,
                                            uint8_t dispatch_mode = 0x7E);
uint16_t compute_ipv6_checksum(const uint8_t *src_mac, const uint8_t *dst_mac, uint8_t proto,
                              const uint8_t *payload, size_t len);

// ICMPv6
bool parse_icmpv6(const uint8_t *decrypted, size_t len, ParsedICMPv6 &out);
std::vector<uint8_t> build_echo_request(uint16_t id, uint16_t seq, const uint8_t *body_data, size_t body_len,
                                       const uint8_t *src_mac, const uint8_t *dst_mac);
std::vector<uint8_t> build_echo_reply(uint16_t id, uint16_t seq, const uint8_t *body_data, size_t body_len,
                                     const uint8_t *src_mac, const uint8_t *dst_mac);
std::vector<uint8_t> build_router_solicitation(const uint8_t *src_mac, const uint8_t *dst_mac);
std::vector<uint8_t> build_neighbor_advertisement(const uint8_t *src_mac, const uint8_t *dst_mac);

// RFC 7252 CoAP
ParsedCoAP parse_coap(const uint8_t *data, size_t len);
std::vector<uint8_t> serialize_coap(uint8_t type, uint8_t code, uint16_t mid,
                                   const uint8_t *token, size_t token_len,
                                   const std::string &uri_path,
                                   const uint8_t *payload, size_t payload_len,
                                   const uint8_t *session_token = nullptr,
                                   int32_t block2_num = -1, uint8_t block2_szx = 4);
std::vector<uint8_t> build_coap_ack(uint16_t mid, uint8_t code = COAP_CODE_CHANGED,
                                   const uint8_t *token = nullptr, size_t token_len = 0,
                                   const uint8_t *payload = nullptr, size_t payload_len = 0);

// TLV Primitives
void append_tlv_u8(std::vector<uint8_t> &out, uint16_t tag, uint8_t val);
void append_tlv_u16(std::vector<uint8_t> &out, uint16_t tag, uint16_t val);
void append_tlv_s16(std::vector<uint8_t> &out, uint16_t tag, int16_t val);
void append_tlv_u32(std::vector<uint8_t> &out, uint16_t tag, uint32_t val);
void append_tlv_string(std::vector<uint8_t> &out, uint16_t tag, const std::string &str);
void append_tlv_bytes(std::vector<uint8_t> &out, uint16_t tag, const uint8_t *data, size_t len);
std::vector<TLVEntry> parse_tlvs(const uint8_t *data, size_t len);
std::vector<TLVEntry> parse_tlvs_1byte(const uint8_t *data, size_t len);
std::vector<TLVEntry> parse_tlvs_2byte(const uint8_t *data, size_t len);
bool tlv_lookup_1byte_field(const uint8_t *data, size_t len, uint8_t tag, std::vector<uint8_t> &out_val);
bool tlv_lookup_2byte_field(const uint8_t *data, size_t len, uint16_t tag, std::vector<uint8_t> &out_val);

// Specialized High-Level TLV Builders
std::vector<uint8_t> build_d_sen_tlv(float temp_c, float hum_pct, uint16_t battery_mv,
                                    uint16_t light_adc = 6249, uint16_t ot_volt_mv = 0, uint8_t status_flags = 0);
std::vector<uint8_t> build_z_p_tlv(float temp_c, float hum_pct);
std::vector<uint8_t> build_d_lock_tlv(bool locked);
std::vector<uint8_t> build_d_fw_state_tlv(uint16_t fw_version = 13762, uint16_t other_slot = 13059,
                                         const std::string &build_id = "c54baf8");

} // namespace protocol
} // namespace tado_emulator
} // namespace esphome
