/**
 * @file lib/zone-state-schema.js
 * @brief Validation schemas for zone target temperature states.
 */

'use strict';

/**
 * Zone State TLV Schema — single source of truth for z/s payloads.
 *
 * Hex FID representation as keys strictly to avoid friendly names in code logic.
 *
 * Field semantics:
 *   - fid:   TLV field ID (2 bytes, big-endian)
 *   - type:  TLV value encoding type
 *   - scale: value = raw * scale (e.g. 0.01 for centi-degrees)
 */
const ZS_SCHEMA = {
    '0x6160': { fid: 0x6160, type: 'u8' }, // field_6160
    '0x61e0': { fid: 0x61e0, type: 'u8' }, // field_61e0
    '0x6200': { fid: 0x6200, type: 'u16be', scale: 0.01 }, // schedule_target_temperature
    '0x6020': { fid: 0x6020, type: 'u8' }, // field_6020
    '0x6180': { fid: 0x6180, type: 'u8' }, // zone_state_flag_6180
    '0x6240': { fid: 0x6240, type: 'u8' }, // field_6240
    '0x6260': { fid: 0x6260, type: 'u8' }, // field_6260
    '0x6280': { fid: 0x6280, type: 'u16be', scale: 0.01 }, // overlay_target_temperature
    '0x62e0': { fid: 0x62e0, type: 'u8' }, // field_62e0
    '0x6440': { fid: 0x6440, type: 'u16be' }, // field_6440
};

module.exports = { ZS_SCHEMA };
