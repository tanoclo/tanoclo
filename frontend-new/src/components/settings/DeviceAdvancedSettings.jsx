/**
 * @file src/components/settings/DeviceAdvancedSettings.jsx
 * @brief Renders hardware actuator limits, display settings, CoAP memory dumper,
 * live diagnostic RAM state (/d/dbg/st), and NVM persistent storage (/d/dbg2/tlvs).
 * 
 * Exposes low-level hardware parameters and registers
 * for IB01, RU02, and VA02 devices.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import {
  ShieldAlert, Wrench, Bug, Sliders, Database,
  Cpu, Wifi, Key, Lock, CheckCircle2, AlertCircle,
  HelpCircle, RefreshCw, Zap, Radio, Layers
} from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import {
  triggerSelftest, triggerMountCalibration, triggerDeviceDebug,
  startMemoryDump, getMemoryDumpStatus, cancelMemoryDump, downloadMemoryDumpFile
} from '../../api/devices';

export const DIAG_FIDS = [
  {
    fid: '0x03ED',
    len: 2,
    name: 'va_motor_step_override',
    label: '0x03ED - Stepper Motor Step Target / Override (u16)',
    shortLabel: 'Motor Step Target',
    desc: 'Actuator linear target step position override (0 = closed seat, ~2400 = fully open modulation limit).',
    access: 'rw',
    type: 'steps',
    category: 'actuator',
    deviceScope: 'va'
  },
  {
    fid: '0x4160',
    len: 2,
    name: 'va_heat_demand_scaling',
    label: '0x4160 - Valve Demand Scaling / Stroke Denominator (u16)',
    shortLabel: 'Valve Demand Scaling',
    desc: 'Actuator valve demand stroke denominator in percent (100 = 1.00× standard, 50 = 2.00× boost, 150 = 0.67× throttle). Scales physical valve stroke relative to zone heat demand.',
    access: 'rw',
    type: 'u16',
    category: 'actuator',
    deviceScope: 'va'
  },
  {
    fid: '0x01AC',
    len: 2,
    name: 'diag_packet_counter',
    label: '0x01AC - Diagnostic Telemetry Packet Counter (u16)',
    shortLabel: 'Packet Counter',
    desc: 'Cumulative counter of transmitted diagnostic telemetry frames across radio link.',
    access: 'rw',
    type: 'u16',
    category: 'telemetry',
    deviceScope: 'all'
  },
  {
    fid: '0x0289',
    len: 2,
    name: 'va_motor_stall_threshold',
    label: '0x0289 - Motor Stall Current Threshold (u16)',
    shortLabel: 'Stall Threshold',
    desc: 'Actuator motor stall current threshold used during calibration end-stop detection.',
    access: 'rw',
    type: 'u16',
    category: 'actuator',
    deviceScope: 'va'
  },
  {
    fid: '0x024B',
    len: 1,
    name: 'rf_channel_override',
    label: '0x024B - RF Channel Test Override (u8)',
    shortLabel: 'RF Channel Override',
    desc: 'Temporary radio channel test override (0 = default normal operation channel, 11–26 = forced channel).',
    access: 'rw',
    type: 'u8',
    category: 'radio',
    deviceScope: 'all'
  },
  {
    fid: '0x01C6',
    len: 2,
    name: 'batt_impedance_threshold',
    label: '0x01C6 - Battery Impedance Threshold (u16)',
    shortLabel: 'Battery Impedance',
    desc: 'Internal cell resistance threshold used for low-battery alert classification.',
    access: 'rw',
    type: 'u16',
    category: 'telemetry',
    deviceScope: 'battery'
  },
  {
    fid: '0x01FA',
    len: 1,
    name: 'rf_carrier_test_mode',
    label: '0x01FA - RF Continuous Wave Test Mode (u8)',
    shortLabel: 'Carrier Wave Mode',
    desc: 'Transmitter RF carrier test mode (0 = normal modulation, 2 = continuous wave transmission mode).',
    access: 'rw',
    type: 'carrier_mode',
    category: 'radio',
    deviceScope: 'all'
  },
  {
    fid: '0x0FA3',
    len: 4,
    name: 'watchdog_trace_code',
    label: '0x0FA3 - Watchdog Reset Diagnostic Trace Code (u32)',
    shortLabel: 'Watchdog Trace',
    desc: 'Hardware reset diagnostic trace and last crash reason code (0 = clean power-on boot). Read-only.',
    access: 'ro',
    type: 'u32_hex',
    category: 'telemetry',
    deviceScope: 'all'
  },
  {
    fid: '0x028B',
    len: 2,
    name: 'va_valve_seat_torque_limit',
    label: '0x028B - Valve Seat Torque Limit (u16)',
    shortLabel: 'Seat Torque Limit',
    desc: 'Maximum motor torque / drive current threshold when seating against the physical valve pin.',
    access: 'rw',
    type: 'u16',
    category: 'actuator',
    deviceScope: 'va'
  },
  {
    fid: '0x0294',
    len: 2,
    name: 'temp_comp_ambient_feed',
    label: '0x0294 - Ambient Temperature Compensation Feed (s16)',
    shortLabel: 'Ambient Temp Feed',
    desc: 'Ambient temperature compensation feed injected into firmware control loop (in 0.01 °C, e.g. 1822 = 18.22 °C).',
    access: 'rw',
    type: 'temp',
    category: 'telemetry',
    deviceScope: 'all'
  },
  {
    fid: '0x016D',
    len: 2,
    name: 'humidity_raw_adc_feed',
    label: '0x016D - Raw ADC Humidity Sensor Feed (u16)',
    shortLabel: 'Raw Humidity ADC',
    desc: 'Uncalibrated raw ADC reading from capacitive humidity sensor element.',
    access: 'rw',
    type: 'u16',
    category: 'telemetry',
    deviceScope: 'ru'
  },
  {
    fid: '0x0290',
    len: 1,
    name: 'accel_tamper_sensitivity',
    label: '0x0290 - Accelerometer Tamper Sensitivity (u8)',
    shortLabel: 'Tamper Sensitivity',
    desc: 'Vibration and tilt sensitivity threshold for tamper detection and display orientation.',
    access: 'rw',
    type: 'u8',
    category: 'hardware',
    deviceScope: 'va'
  },
  {
    fid: '0x62E0',
    len: 2,
    name: 'sim_env_hook_00',
    label: '0x62E0 - Simulation Sensor Injection Hook #0 (u16)',
    shortLabel: 'Sim Hook #0',
    desc: 'Firmware test environment hook for sensor mocking. Write-only injection.',
    access: 'wo',
    type: 'u16',
    category: 'simulation',
    deviceScope: 'all'
  },
  {
    fid: '0x62E1',
    len: 2,
    name: 'sim_env_hook_01',
    label: '0x62E1 - Simulation Sensor Injection Hook #1 (u16)',
    shortLabel: 'Sim Hook #1',
    desc: 'Firmware test environment hook for sensor mocking. Write-only injection.',
    access: 'wo',
    type: 'u16',
    category: 'simulation',
    deviceScope: 'all'
  },
  {
    fid: '0x62EF',
    len: 2,
    name: 'sim_env_hook_0F',
    label: '0x62EF - Simulation Sensor Injection Hook #15 (u16)',
    shortLabel: 'Sim Hook #15',
    desc: 'Firmware test environment hook for sensor mocking. Write-only injection.',
    access: 'wo',
    type: 'u16',
    category: 'simulation',
    deviceScope: 'all'
  },
  {
    fid: '0x62FF',
    len: 2,
    name: 'sim_env_hook_1F',
    label: '0x62FF - Simulation Sensor Injection Hook #31 (u16)',
    shortLabel: 'Sim Hook #31',
    desc: 'Firmware test environment hook for sensor mocking. Write-only injection.',
    access: 'wo',
    type: 'u16',
    category: 'simulation',
    deviceScope: 'all'
  }
];

export const NVM_SLOTS = [
  {
    fid: '0x0001',
    len: 1,
    name: 'rf_band_mode',
    label: '0x0001 - RF Channel & Band Mode (1B)',
    shortLabel: 'RF Band / Mode',
    desc: 'Physical 868 MHz RF channel / modulation variant. 0x41 = Ch 26 Band A (VA), 0x42 = Ch 26 Band B (IB), 0x55 = 868 MHz Sub-GHz (RU).',
    access: 'rw',
    type: 'rf_band',
    category: 'network'
  },
  {
    fid: '0x0002',
    len: 1,
    name: 'calibration_status',
    label: '0x0002 - Hardware Calibration Status Mask (1B)',
    shortLabel: 'Calibration Status',
    desc: 'Internal factory calibration validity status bitmask (0x27 on VA, 0x6B on RU, 0x9F on IB). Read-only.',
    access: 'ro',
    type: 'bitmask',
    category: 'hardware'
  },
  {
    fid: '0x0003',
    len: 2,
    name: 'hw_revision',
    label: '0x0003 - Hardware PCB Revision & Build ID (2B)',
    shortLabel: 'PCB Revision',
    desc: 'Hardware PCB revision and build variant (returns 0x2E19 / 11801 on all production devices). Read-only.',
    access: 'ro',
    type: 'u16_hex',
    category: 'hardware'
  },
  {
    fid: '0x0004',
    len: 10,
    name: 'eui64_mac',
    label: '0x0004 - Hardware IEEE EUI-64 MAC Address (10B)',
    shortLabel: 'IEEE EUI-64 MAC',
    desc: 'Factory hardware IEEE 64-bit MAC address (with FFFF padding). Forms the link-local IPv6 host address. Read-only.',
    access: 'ro',
    type: 'mac',
    category: 'network'
  },
  {
    fid: '0x0005',
    len: 2,
    name: 'short_node_id',
    label: '0x0005 - 16-bit Short Node ID Setter (2B)',
    shortLabel: 'Short Node ID',
    desc: 'Setter-only slot for the 16-bit 802.15.4 mesh short node identifier in local PAN.',
    access: 'wo',
    type: 'u16',
    category: 'network'
  },
  {
    fid: '0x0006',
    len: 8,
    name: 'auth_token_seed',
    label: '0x0006 - CoAP Auth Token Seed (8B Hex)',
    shortLabel: 'Auth Token Seed',
    desc: 'Session authentication seed / token (used for CoAP Option 2048 authorization and DB field_025e). Read-only.',
    access: 'ro',
    type: 'hex8',
    category: 'security'
  },
  {
    fid: '0x0007',
    len: 16,
    name: 'pairing_secret',
    label: '0x0007 - Commissioning & Pairing Secret Key (16B Hex)',
    shortLabel: 'Pairing Secret Key',
    desc: '16-byte AES pre-shared secret key for device pairing and commissioning (matches DB field_0007).',
    access: 'rw',
    type: 'hex16',
    category: 'security'
  },
  {
    fid: '0x0008',
    len: 1,
    name: 'pairing_state',
    label: '0x0008 - Commissioning State & Network Flags (1B)',
    shortLabel: 'Commissioning State',
    desc: 'Network joining and pairing status bitmask. 0xC9 (201) = Commissioned & Paired, 0x00 = Factory Unpaired. Read-only.',
    access: 'ro',
    type: 'bitmask',
    category: 'network'
  },
  {
    fid: '0x0009',
    len: 1,
    name: 'tx_power',
    label: '0x0009 - RF Output Power Level dBm (1B)',
    shortLabel: 'TX Power Level',
    desc: 'Setter-only slot for the radio transmitter output power level in dBm.',
    access: 'wo',
    type: 's8',
    category: 'network'
  },
  {
    fid: '0x000A',
    len: 2,
    name: 'pan_id',
    label: '0x000A - 802.15.4 Network PAN ID (2B)',
    shortLabel: '802.15.4 PAN ID',
    desc: '802.15.4 Personal Area Network ID (0xFFFF on Bridge coordinator, 0x00FF / 255 on joined peripherals).',
    access: 'rw',
    type: 'u16',
    category: 'network'
  },
  {
    fid: '0x000B',
    len: 16,
    name: 'network_key',
    label: '0x000B - AES-128 Network Encryption Key (16B Hex)',
    shortLabel: 'AES Network Key',
    desc: 'Hardware read-protected AES-128 network key. Reads return masked 0xFF bytes. Write sets new key.',
    access: 'wo_protected',
    type: 'hex16',
    category: 'security'
  },
  {
    fid: '0x000C',
    len: 1,
    name: 'factory_reset',
    label: '0x000C - Factory Reset & NVM Erase Trigger (1B)',
    shortLabel: 'Factory Reset Trigger',
    desc: 'Writing 0x01 triggers flash erase of all non-volatile settings and restores factory defaults.',
    access: 'wo',
    type: 'trigger',
    category: 'hardware'
  }
];

export function hexToAscii(hex) {
  if (!hex) return '';
  let str = '';
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  for (let i = 0; i < clean.length; i += 2) {
    const code = parseInt(clean.substr(i, 2), 16);
    if (code >= 32 && code <= 126) {
      str += String.fromCharCode(code);
    }
  }
  return str;
}

export function asciiToHex(str) {
  if (!str) return '';
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

export function formatFriendlyValue(fidStr, hex, val) {
  if (!hex && (val === null || val === undefined || val === '')) return '';
  const fidNorm = (String(fidStr || '').toUpperCase().startsWith('0X')
    ? String(fidStr || '').toUpperCase()
    : '0X' + String(fidStr || '').toUpperCase().padStart(4, '0'));
  const rawHex = String(hex || (val !== undefined && val !== null && val !== '' && !isNaN(Number(val)) ? Number(val).toString(16) : '')).toLowerCase().replace(/[^0-9a-f]/g, '');

  switch (fidNorm) {
    case '0X0004': { // Hardware IEEE EUI-64 MAC Address
      if (rawHex.length >= 16) {
        // First 8 bytes (16 hex chars) are the EUI-64 MAC address
        const macPart = rawHex.slice(0, 16);
        return macPart.match(/.{1,2}/g).join(':').toUpperCase() + ' (EUI-64 MAC)';
      }
      break;
    }
    case '0X0006': { // CoAP Auth Token Seed (8B)
      if (rawHex.length >= 16) {
        return rawHex.slice(0, 16).match(/.{1,2}/g).join(':').toUpperCase() + ' (Auth Seed)';
      }
      break;
    }
    case '0X0007': { // Commissioning Secret Key (16B / 32 hex)
      if (rawHex.length === 32) {
        return rawHex.match(/.{1,4}/g).join(' ') + ' (16B AES Key)';
      }
      break;
    }
    case '0X0001': { // RF Channel & Band Mode (1B)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0x41 || num === 65) {
        return 'Channel 26 (Band A / 868.325 MHz - VA)';
      }
      if (num === 0x42 || num === 66) {
        return 'Channel 26 (Band B / 868.325 MHz - IB)';
      }
      if (num === 0x55 || num === 85) {
        return '868 MHz Sub-GHz Band (0x55 - RU)';
      }
      if (num >= 11 && num <= 26) {
        return `Channel ${num} (802.15.4 standard)`;
      }
      if (!isNaN(num)) {
        return `Channel ${num} (0x${num.toString(16).toUpperCase().padStart(2, '0')})`;
      }
      break;
    }
    case '0X0008': { // Pairing State (1B)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0xC9 || num === 201) return 'Commissioned & Paired (0xC9)';
      if (num === 0) return '0 - Unpaired (Factory Default)';
      if (!isNaN(num)) return `Status Flags: 0x${num.toString(16).toUpperCase().padStart(2, '0')} (${num})`;
      break;
    }
    case '0X0002': { // Calibration validity lock / status mask
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0x27 || num === 39) return 'Calibrated (0x27 - VA Lock)';
      if (num === 0x6B || num === 107) return 'Calibrated (0x6B - RU Lock)';
      if (num === 0x9F || num === 159) return 'Calibrated (0x9F - IB Lock)';
      if (num === 0) return '0 - Unlocked (Uncalibrated)';
      if (!isNaN(num)) return `Calibration Mask: 0x${num.toString(16).toUpperCase().padStart(2, '0')}`;
      break;
    }
    case '0X000A': { // PAN ID (2B)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0xFFFF || num === 65535) return '0xFFFF (Coordinator / All PANs)';
      if (num === 0x00FF || num === 255) return '255 (0x00FF - Paired PAN)';
      if (!isNaN(num)) return `${num} (0x${num.toString(16).toUpperCase().padStart(4, '0')})`;
      break;
    }
    case '0X000B': { // AES-128 Network Key (Protected read)
      if (rawHex.startsWith('ffff') || rawHex.includes('ffffffff') || rawHex.startsWith('ece5')) {
        return `Protected in Flash (Read Masked: 0x${rawHex.slice(0, 8)}...)`;
      }
      break;
    }
    case '0X0003': { // HW Revision
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0x2E19 || num === 11801) return '11801 (PCB Rev 0x2E19)';
      if (!isNaN(num)) return `${num} (0x${num.toString(16).toUpperCase()})`;
      break;
    }
    case '0X0005': { // Short Node ID (2B)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${num} (0x${num.toString(16).toUpperCase().padStart(4, '0')})`;
      break;
    }
    case '0X0009': { // TX Power
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${num} dBm`;
      break;
    }
    case '0X03ED': { // Motor Step Target / Override
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${num} steps`;
      break;
    }
    case '0X0294': { // Temp compensation feed (s16 in 0.01 °C)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${(num / 100).toFixed(2)} °C`;
      break;
    }
    case '0X016D': { // Humidity raw ADC
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${num} ADC counts`;
      break;
    }
    case '0X01FA': { // RF Carrier test mode
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0) return '0 - Normal Radio (CW Disabled)';
      if (num === 2) return '2 - Active Continuous Wave (Test Mode)';
      break;
    }
    case '0X0FA3': { // Watchdog reset trace
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0) return '0 - Clean Power-On Boot';
      if (!isNaN(num)) return `Crash Trace: 0x${num.toString(16).toUpperCase().padStart(8, '0')}`;
      break;
    }
  }

  if (val !== undefined && val !== null && val !== '') return String(val);
  if (rawHex) return `0x${rawHex.toUpperCase()}`;
  return '';
}

export function parseFriendlyToRaw(fidStr, friendlyStr, _lenBytes) {
  if (!friendlyStr) return '';
  const fidNorm = (String(fidStr || '').toUpperCase().startsWith('0X')
    ? String(fidStr || '').toUpperCase()
    : '0X' + String(fidStr || '').toUpperCase().padStart(4, '0'));
  const str = String(friendlyStr).trim();

  switch (fidNorm) {
    case '0X0006': // MAC / Auth seed
    case '0X0007': // Commissioning secret
    case '0X000B': { // Network key
      return str.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    }
    case '0X0001': { // RF Channel
      if (/band\s*a/i.test(str)) return '41';
      if (/band\s*b/i.test(str)) return '42';
      if (/sub-?ghz/i.test(str) || str === '85') return '55';
      const m = str.match(/channel\s*(\d+)/i) || str.match(/^(\d+)$/);
      if (m) {
        const ch = parseInt(m[1], 10);
        if (ch === 26) return '41';
        return ch.toString(16).padStart(2, '0');
      }
      if (/^[0-9a-fA-F]{2}$/.test(str)) return str.toLowerCase();
      break;
    }
    case '0X0004': { // MAC / Serial
      const clean = str.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      if (clean.length >= 16) return clean;
      if (/^[a-zA-Z0-9]+$/.test(str) && str.length <= 10) return asciiToHex(str);
      break;
    }
    case '0X0008': // Pairing State
    case '0X0002': { // Calibration Lock
      const m = str.match(/^(\d+)/);
      if (m) return m[1];
      break;
    }
    case '0X000A': // PAN ID
    case '0X0005': // Node ID
    case '0X03ED': { // Motor steps
      const m = str.match(/^(-?\d+)/);
      if (m) return m[1];
      break;
    }
    case '0X0294': { // Temp
      const m = str.match(/^(-?[\d.]+)/);
      if (m) return Math.round(parseFloat(m[1]) * 100).toString();
      break;
    }
    case '0X01FA': { // Carrier wave
      const m = str.match(/^([02])/);
      if (m) return m[1];
      break;
    }
    case '0X000C': { // Factory reset trigger
      return '1';
    }
  }

  return str;
}

export function validateDebugValue(fidStr, val, isNvm) {
  if (!val || String(val).trim() === '') {
    return { isValid: false, error: 'Value cannot be empty' };
  }
  const fidNorm = (String(fidStr || '').toUpperCase().startsWith('0X')
    ? String(fidStr || '').toUpperCase()
    : '0X' + String(fidStr || '').toUpperCase().padStart(4, '0'));
  const str = String(val).trim();

  if (isNvm) {
    switch (fidNorm) {
      case '0X0001': { // RF Band Mode
        const numHex = parseInt(str.replace(/^0x/i, ''), 16);
        const numDec = Number(str);
        if ([0x41, 0x42, 0x55].includes(numHex) || [0x41, 0x42, 0x55].includes(numDec) || (!isNaN(numDec) && numDec >= 11 && numDec <= 26) || (!isNaN(numHex) && numHex >= 11 && numHex <= 26)) {
          return { isValid: true };
        }
        return { isValid: false, error: 'Must be 0x41 (Band A), 0x42 (Band B), 0x55 (Sub-GHz), or Channels 11–26 (0x0B–0x1A)' };
      }
      case '0X0007':
      case '0X000B': { // 16B Hex Keys
        const clean = str.replace(/[^0-9a-fA-F]/g, '');
        if (clean.length === 32) return { isValid: true };
        return { isValid: false, error: `Must be exactly 16 bytes (32 hexadecimal characters). Current: ${clean.length} chars` };
      }
      case '0X000A': { // PAN ID
        const num = str.startsWith('0x') || str.startsWith('0X') ? parseInt(str, 16) : Number(str);
        if (!isNaN(num) && num >= 0 && num <= 65535) return { isValid: true };
        return { isValid: false, error: 'PAN ID must be between 0 and 65535 (0x0000 - 0xFFFF)' };
      }
      case '0X0005': { // Short node ID
        const num = str.startsWith('0x') || str.startsWith('0X') ? parseInt(str, 16) : Number(str);
        if (!isNaN(num) && num >= 0 && num <= 65535) return { isValid: true };
        return { isValid: false, error: 'Node ID must be between 0 and 65535' };
      }
      case '0X0009': { // TX Power
        const num = Number(str);
        if (!isNaN(num) && num >= -30 && num <= 20) return { isValid: true };
        return { isValid: false, error: 'TX power must be between -30 dBm and +20 dBm' };
      }
      case '0X000C': { // Factory reset
        if (str === '1' || str === '01') return { isValid: true };
        return { isValid: false, error: 'Write 1 (0x01) to trigger NVM erase' };
      }
      case '0X0002':
      case '0X0003':
      case '0X0004':
      case '0X0006':
      case '0X0008': {
        return { isValid: false, error: 'Slot is read-only hardware parameter in firmware' };
      }
    }
  } else {
    // Diagnostic State (/d/dbg/st)
    switch (fidNorm) {
      case '0X03ED': { // Motor steps
        const num = Number(str);
        if (!isNaN(num) && num >= 0 && num <= 3500) return { isValid: true };
        return { isValid: false, error: 'Motor target must be between 0 and 3500 steps' };
      }
      case '0X0294': { // Temp feed
        const num = Number(str);
        if (!isNaN(num) && num >= -4000 && num <= 8500) return { isValid: true };
        return { isValid: false, error: 'Temperature must be between -4000 (-40 °C) and 8500 (+85 °C)' };
      }
      case '0X01FA': { // Carrier mode
        if (str === '0' || str === '2') return { isValid: true };
        return { isValid: false, error: 'Carrier test mode must be 0 (Disabled) or 2 (Active CW)' };
      }
      case '0X024B': { // RF Channel override
        const num = Number(str);
        if (num === 0 || (num >= 11 && num <= 26)) return { isValid: true };
        return { isValid: false, error: 'Channel override must be 0 (default) or 11–26' };
      }
      case '0X0FA3': {
        return { isValid: false, error: 'Watchdog code is read-only diagnostic trace' };
      }
      default: {
        const num = Number(str);
        if (!isNaN(num) && num >= 0 && num <= 65535) return { isValid: true };
        if (/^[0-9a-fA-F]+$/.test(str)) return { isValid: true };
        return { isValid: false, error: 'Enter a valid numeric or hexadecimal value' };
      }
    }
  }

  return { isValid: true };
}

/**
 * @brief Advanced device configuration tuning sub-panel.
 */
export default function DeviceAdvancedSettings({
  homeId,
  deviceId,
  isValve,
  device,
  lowSteps,
  setLowSteps,
  highSteps,
  setHighSteps,
  driveConstant,
  setDriveConstant,
  handleSaveActuatorLimits,
  isSavingLimits,
  displayBrightness,
  setDisplayBrightness,
  displayContrast,
  setDisplayContrast,
  displayActiveTimeout,
  setDisplayActiveTimeout,
  handleSaveDisplay,
  isSavingDisplay,
  isReadOnly,
  t
}) {
  const { showToast } = useToast();
  const targetSerial = device?.serialNo || deviceId;
  const isStat = device?.deviceType?.startsWith('SU') || device?.deviceType?.startsWith('WR') || device?.deviceType?.startsWith('RU');
  const isIB = device?.deviceType?.startsWith('IB') || device?.deviceType?.startsWith('GW');

  // Default address based on hardware platform
  const defaultAddr = isValve ? '00000000' : '20000000';
  const [dbgAdr, setDbgAdr] = useState(defaultAddr);
  const [dbgLen, setDbgLen] = useState('64');
  const [dumpRangeBytes, setDumpRangeBytes] = useState(64);
  const [serverDumpStatus, setServerDumpStatus] = useState(null);

  // Hardware Bounds Validation for CoAP Memory Dumper
  const parsedAdr = parseInt(dbgAdr || '0', 16);
  const parsedLen = parseInt(dbgLen || '0', 10);
  const isLenValid = !isNaN(parsedLen) && parsedLen >= 1 && parsedLen <= 64;

  let isAdrValid = true;
  let adrWarning = null;

  if (isNaN(parsedAdr) || dbgAdr.length < 1 || dbgAdr.length > 8) {
    isAdrValid = false;
    adrWarning = 'Address must be a valid 1 to 8 character hexadecimal value.';
  } else if (isValve && parsedAdr >= 0x08000000 && parsedAdr < 0x20000000) {
    isAdrValid = false;
    adrWarning = '0x08000000 is an unmapped memory region on nRF52832 and will crash the device. Use 0x00000000 for internal flash or 0x20000000 for RAM.';
  } else if (!isValve && isStat && parsedAdr >= 0x80000000) {
    isAdrValid = false;
    adrWarning = 'RU02 (STM32L0) has no external SPI flash. Use 0x08000000 for flash or 0x20000000 for SRAM.';
  }

  // Poll server dump status
  useEffect(() => {
    let interval = null;
    const fetchStatus = async () => {
      try {
        const res = await getMemoryDumpStatus(homeId, targetSerial);
        if (res && res.status) {
          setServerDumpStatus(res.status);
        }
      } catch (_e) {
        // Ignored in background poll
      }
    };

    fetchStatus();

    if (serverDumpStatus?.isRunning) {
      interval = setInterval(fetchStatus, 1500);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [homeId, targetSerial, serverDumpStatus?.isRunning]);

  // Start or resume server dump
  const handleStartServerDump = async (restart = false) => {
    if (!isAdrValid) return;
    try {
      const res = await startMemoryDump(homeId, targetSerial, {
        startAdr: dbgAdr,
        totalBytes: Number(dumpRangeBytes),
        chunkSize: Number(dbgLen) || 64,
        restart: !!restart
      });
      if (res && res.status) {
        setServerDumpStatus(res.status);
        const action = restart ? 'Restarted fresh dump' : res.status.isResumable || res.status.hasPart ? 'Resumed memory dump' : 'Server dump started';
        showToast(`${action} (${dumpRangeBytes} B). Rotate dial periodically if device sleeps.`);
      }
    } catch (e) {
      showToast(e.message || 'Failed to start server dump', 'error');
    }
  };

  // Cancel server dump
  const handleCancelServerDump = async () => {
    try {
      await cancelMemoryDump(homeId, targetSerial);
      const res = await getMemoryDumpStatus(homeId, targetSerial);
      if (res && res.status) setServerDumpStatus(res.status);
      showToast(t('settings.device_advanced.toast_dump_cancelled', 'Memory dump cancelled'));
    } catch (e) {
      showToast(e.message || 'Failed to cancel dump', 'error');
    }
  };

  // State for /d/dbg/st (Diagnostic & Control State)
  const [stCategory, setStCategory] = useState('all');
  const [stFid, setStFid] = useState(DIAG_FIDS[0].fid);
  const [stLen, setStLen] = useState(String(DIAG_FIDS[0].len));
  const [stValue, setStValue] = useState('');
  const [stFriendly, setStFriendly] = useState('');
  const [stResult, setStResult] = useState(null);
  const [stLoading, setStLoading] = useState(false);
  const [stCache, setStCache] = useState({});

  // State for /d/dbg2/tlvs (NVM Persistent Storage)
  const [nvmCategory, setNvmCategory] = useState('all');
  const [nvmFid, setNvmFid] = useState(NVM_SLOTS[0].fid);
  const [nvmLen, setNvmLen] = useState(String(NVM_SLOTS[0].len));
  const [nvmValue, setNvmValue] = useState('');
  const [nvmFriendly, setNvmFriendly] = useState('');
  const [nvmResult, setNvmResult] = useState(null);
  const [nvmLoading, setNvmLoading] = useState(false);
  const [nvmCache, setNvmCache] = useState({});
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false);

  // Active debug operation tracking ref
  const activeDebugRef = useRef({ tab: null, fid: null, mid: null, adr: null });

  // Lookup active definitions
  const currentStDef = useMemo(() => {
    return DIAG_FIDS.find(d => d.fid.toLowerCase() === String(stFid).toLowerCase()) || DIAG_FIDS[0];
  }, [stFid]);

  const currentNvmDef = useMemo(() => {
    return NVM_SLOTS.find(s => s.fid.toLowerCase() === String(nvmFid).toLowerCase()) || NVM_SLOTS[0];
  }, [nvmFid]);

  // Validation states
  const stValidation = useMemo(() => {
    return validateDebugValue(stFid, stValue, false);
  }, [stFid, stValue]);

  const nvmValidation = useMemo(() => {
    return validateDebugValue(nvmFid, nvmValue, true);
  }, [nvmFid, nvmValue]);

  // Real-time asynchronous push updates via SSE
  useEffect(() => {
    const handleSseDebugResponse = (e) => {
      const data = e.detail;
      if (!data || data.deviceId !== targetSerial) return;

      const raw = data.hex || (data.val !== undefined && data.val !== null ? String(data.val) : '');
      if (!raw) return;

      const active = activeDebugRef.current;
      if (active.tab === 'st') {
        const targetFid = active.fid || stFid;
        const friendlySt = formatFriendlyValue(targetFid, data.hex, data.val);
        setStValue(raw);
        setStFriendly(friendlySt);
        setStResult(data);
        setStLoading(false);
        setStCache(prev => ({
          ...prev,
          [targetFid]: { ...data, friendly: friendlySt, timestamp: new Date().toLocaleTimeString() }
        }));
        showToast(`Diagnostic FID ${targetFid} (${targetSerial}): ${friendlySt || raw}`, 'success');
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else if (active.tab === 'nvm') {
        const targetFid = active.fid || nvmFid;
        const friendlyNvm = formatFriendlyValue(targetFid, data.hex, data.val);
        setNvmValue(raw);
        setNvmFriendly(friendlyNvm);
        setNvmResult(data);
        setNvmLoading(false);
        setNvmCache(prev => ({
          ...prev,
          [targetFid]: { ...data, friendly: friendlyNvm, timestamp: new Date().toLocaleTimeString() }
        }));
        showToast(`NVM ${targetFid} (${targetSerial}): ${friendlyNvm || raw}`, 'success');
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else if (active.tab === 'm') {
        const len = data.bytes?.length || (data.hex ? data.hex.length / 2 : 0);
        showToast(`Captured ${len}B memory from 0x${active.adr || dbgAdr} (${targetSerial})`, 'success');
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      }
    };

    window.addEventListener('device-debug-response', handleSseDebugResponse);
    return () => window.removeEventListener('device-debug-response', handleSseDebugResponse);
  }, [targetSerial, stFid, nvmFid, dbgAdr, showToast]);

  // Handle ST Read (GET)
  const handleReadSt = async (targetFidOverride = null) => {
    const fidToRead = targetFidOverride || stFid;
    const def = DIAG_FIDS.find(d => d.fid === fidToRead) || currentStDef;

    if (isIB) {
      showToast('IB firmware has handler_get = NULL for /d/dbg/st. Read via NVM or Memory Dumper.', 'warning');
      return;
    }
    if (def.access === 'wo') {
      showToast(`${fidToRead} is write-only in firmware (sensor injection hook).`, 'warning');
      return;
    }

    setStLoading(true);
    activeDebugRef.current = { tab: 'st', fid: fidToRead, mid: null, adr: null };
    try {
      const res = await triggerDeviceDebug(homeId, targetSerial, 'st', {
        method: 'GET',
        fid: fidToRead,
        len: String(def.len)
      });
      setStResult(res);
      if (res?.mid) activeDebugRef.current.mid = res.mid;
      if (res?.hex || (res?.val !== undefined && res?.val !== null)) {
        const raw = res.hex || String(res.val);
        const friendly = formatFriendlyValue(fidToRead, res.hex, res.val);
        if (fidToRead === stFid) {
          setStValue(raw);
          setStFriendly(friendly);
        }
        setStCache(prev => ({
          ...prev,
          [fidToRead]: { ...res, friendly, timestamp: new Date().toLocaleTimeString() }
        }));
        showToast(`Read FID ${fidToRead}: ${friendly || raw}`, 'success');
        setStLoading(false);
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else {
        showToast(res?.message || 'Read request queued to device (rotate dial to wake)...', 'info');
        setTimeout(() => setStLoading(false), 2000);
      }
    } catch (e) {
      showToast(e.message || 'Failed to read diagnostic parameter', 'error');
      setStLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  // Handle ST Write (PUT)
  const handleWriteSt = async () => {
    if (currentStDef.access === 'ro') {
      showToast(`${currentStDef.fid} is read-only in firmware.`, 'warning');
      return;
    }
    if (!stValidation.isValid) {
      showToast(stValidation.error || 'Invalid value', 'error');
      return;
    }

    setStLoading(true);
    activeDebugRef.current = { tab: 'st', fid: stFid, mid: null, adr: null };
    try {
      const res = await triggerDeviceDebug(homeId, targetSerial, 'st', {
        method: 'PUT',
        fid: stFid,
        len: stLen,
        value: stValue
      });
      setStResult(res);
      if (res?.mid) activeDebugRef.current.mid = res.mid;
      showToast(`Injected ${stFriendly || stValue} (raw: ${stValue}) into FID ${stFid}`, 'success');
      setStCache(prev => ({
        ...prev,
        [stFid]: { ...res, hex: stValue, val: Number(stValue), friendly: stFriendly || stValue, timestamp: new Date().toLocaleTimeString() }
      }));
      setTimeout(() => setStLoading(false), 1500);
    } catch (e) {
      showToast(e.message || 'Failed to inject diagnostic value', 'error');
      setStLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  // Handle NVM Read (GET)
  const handleReadNvm = async (targetFidOverride = null) => {
    const fidToRead = targetFidOverride || nvmFid;
    const def = NVM_SLOTS.find(s => s.fid === fidToRead) || currentNvmDef;

    if (def.access === 'wo') {
      showToast(`${fidToRead} is a setter-only slot in firmware.`, 'warning');
      return;
    }

    setNvmLoading(true);
    activeDebugRef.current = { tab: 'nvm', fid: fidToRead, mid: null, adr: null };
    try {
      const res = await triggerDeviceDebug(homeId, targetSerial, 'st', {
        method: 'GET',
        fid: fidToRead,
        len: String(def.len)
      });
      setNvmResult(res);
      if (res?.mid) activeDebugRef.current.mid = res.mid;
      if (res?.hex || (res?.val !== undefined && res?.val !== null)) {
        const raw = res.hex || String(res.val);
        const friendly = formatFriendlyValue(fidToRead, res.hex, res.val);
        if (fidToRead === nvmFid) {
          setNvmValue(raw);
          setNvmFriendly(friendly);
        }
        setNvmCache(prev => ({
          ...prev,
          [fidToRead]: { ...res, friendly, timestamp: new Date().toLocaleTimeString() }
        }));
        showToast(`Read NVM ${fidToRead}: ${friendly || raw}`, 'success');
        setNvmLoading(false);
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else {
        showToast(res?.message || 'NVM read queued to device (rotate dial to wake)...', 'info');
        setTimeout(() => setNvmLoading(false), 2000);
      }
    } catch (e) {
      showToast(e.message || 'Failed to read NVM parameter', 'error');
      setNvmLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  // Handle NVM Write (PUT)
  const handleWriteNvm = async () => {
    if (currentNvmDef.access === 'ro') {
      showToast(`${currentNvmDef.fid} is read-only in firmware.`, 'warning');
      return;
    }
    if (currentNvmDef.fid === '0x000C' && !confirmFactoryReset) {
      showToast('Check confirmation box before triggering factory reset.', 'warning');
      return;
    }
    if (!nvmValidation.isValid) {
      showToast(nvmValidation.error || 'Invalid NVM value', 'error');
      return;
    }

    setNvmLoading(true);
    activeDebugRef.current = { tab: 'nvm', fid: nvmFid, mid: null, adr: null };
    try {
      const res = await triggerDeviceDebug(homeId, targetSerial, 'tlvs', {
        method: 'PUT',
        fid: nvmFid,
        len: nvmLen,
        value: nvmValue
      });
      setNvmResult(res);
      if (res?.mid) activeDebugRef.current.mid = res.mid;
      showToast(`Stored ${nvmFriendly || nvmValue} in NVM ${nvmFid}`, 'success');
      setNvmCache(prev => ({
        ...prev,
        [nvmFid]: { ...res, hex: nvmValue, friendly: nvmFriendly || nvmValue, timestamp: new Date().toLocaleTimeString() }
      }));
      setConfirmFactoryReset(false);
      setTimeout(() => setNvmLoading(false), 1500);
    } catch (e) {
      showToast(e.message || 'Failed to store NVM value', 'error');
      setNvmLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  // Filtered definitions
  const filteredDiags = useMemo(() => {
    if (stCategory === 'all') return DIAG_FIDS;
    return DIAG_FIDS.filter(d => d.category === stCategory);
  }, [stCategory]);

  const filteredNvms = useMemo(() => {
    if (nvmCategory === 'all') return NVM_SLOTS;
    return NVM_SLOTS.filter(s => s.category === nvmCategory);
  }, [nvmCategory]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Warning Banner */}
      <Card style={{
        padding: '1.25rem',
        border: '1px solid var(--danger-glow)',
        backgroundColor: 'var(--danger-glow)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--danger)' }}>
          <ShieldAlert size={20} />
          <strong style={{ fontSize: '1rem', fontWeight: 700 }}>{t('settings.device_advanced.warning_title')}</strong>
        </div>
        <p style={{ fontSize: '0.85rem', lineHeight: '1.4', margin: 0 }}>
          {t('settings.device_advanced.warning_desc')}
        </p>
      </Card>

      {/* Display & Screensaver Settings Card */}
      {!isIB && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.device_advanced.display_screensaver_title')}</h3>

          {/* Brightness */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{t('settings.device_advanced.display_brightness')}</strong>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
                {Math.round((displayBrightness / 255) * 100)}% ({displayBrightness})
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.device_advanced.display_brightness_desc')}
              <br />
              • <em>{t('common.interpretation')}</em>: {t('settings.device_advanced.display_brightness_interp')}
            </p>
            <input
              type="range"
              min="0"
              max="255"
              value={displayBrightness}
              onChange={(e) => setDisplayBrightness(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ width: '100%', cursor: 'pointer', marginTop: '0.25rem' }}
            />
          </div>

          {/* Contrast */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{t('settings.device_advanced.display_contrast', 'Display Contrast')}</strong>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
                {displayContrast}
              </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
              {t('settings.device_advanced.display_contrast_desc')}
              <br />
              • <em>{t('common.interpretation')}</em>: {t('settings.device_advanced.display_contrast_interp')}
            </p>
            <input
              type="range"
              min="0"
              max="255"
              value={displayContrast}
              onChange={(e) => setDisplayContrast(Number(e.target.value))}
              disabled={isReadOnly}
              style={{ width: '100%', cursor: 'pointer', marginTop: '0.25rem' }}
            />
          </div>

          {/* Screensaver Standby Timeout */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              <strong>{t('settings.device_advanced.display_off_timeout')}</strong>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '2px 0 0', lineHeight: '1.4' }}>
                {t('settings.device_advanced.display_timeout_desc')}
                <br />
                • <em>{t('common.interpretation')}</em>: {t('settings.device_advanced.display_timeout_interp')}
                <br />
                • <strong>{t('common.warning')}</strong>: {t('settings.device_advanced.display_timeout_warning')}
              </p>
            </div>
            <input
              type="number"
              min="0"
              max="255"
              value={displayActiveTimeout}
              onChange={(e) => setDisplayActiveTimeout(Number(e.target.value))}
              disabled={isReadOnly}
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                color: 'var(--text-primary)',
                padding: '0.4rem 0.6rem',
                borderRadius: 'var(--radius-sm)',
                width: '80px',
                textAlign: 'center',
                fontWeight: 600
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
            <Button
              onClick={handleSaveDisplay}
              disabled={isSavingDisplay || isReadOnly}
              variant="primary"
            >
              {isSavingDisplay ? t('settings.saving', 'Saving...') : t('settings.save_display', 'Save Display Settings')}
            </Button>
          </div>
        </Card>
      )}

      {/* Actuator Limits (VA devices only) */}
      {isValve && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.device_advanced.actuator_motor_title')}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            {t('settings.device_advanced.stepper_desc')}
          </p>

          {/* Multi-step Visual Motor Range Bar & Interactive Sliders */}
          {(() => {
            const numLow = Number(lowSteps) || 2400;
            const numHigh = Number(highSteps) || 2200;
            const numDrive = Number(driveConstant) || 1800;
            const numSeat = Number(device?.actuatorLimits?.seatPoint) || null;
            const numRef = Number(device?.actuatorLimits?.referencePoint) || null;
            const numPos1 = Number(device?.actuatorLimits?.position1) || null;
            const maxTrack = Math.max(3000, numLow + 200, (numPos1 || 0) + 200);

            const getPct = (val) => {
              if (val === null || isNaN(val)) return 0;
              return Math.min(100, Math.max(0, (val / maxTrack) * 100));
            };

            const highPct = getPct(numHigh);
            const lowPct = getPct(numLow);
            const spanLeft = Math.min(highPct, lowPct);
            const spanWidth = Math.max(2, Math.abs(lowPct - highPct));

            return (
              <div style={{
                backgroundColor: 'var(--bg-input)',
                borderRadius: 'var(--radius-md)',
                padding: '1.25rem',
                border: '1px solid var(--border-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '1.25rem'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {t('settings.device_advanced.stepper_axis', `Linear Stepper Axis (0 → ${maxTrack} steps)`)}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t('settings.device_advanced.stepper_outward')}
                  </span>
                </div>

                {/* Visual Timeline Track */}
                <div style={{ position: 'relative', height: '54px', margin: '1.25rem 0.5rem 0.75rem' }}>
                  {/* Track Base */}
                  <div style={{
                    position: 'absolute',
                    top: '22px',
                    left: 0,
                    right: 0,
                    height: '8px',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    borderRadius: '4px'
                  }} />

                  {/* Active Modulation Range Highlight */}
                  <div style={{
                    position: 'absolute',
                    top: '22px',
                    left: `${spanLeft}%`,
                    width: `${spanWidth}%`,
                    height: '8px',
                    backgroundColor: 'rgba(245, 158, 11, 0.45)',
                    borderTop: '1px solid #f59e0b',
                    borderBottom: '1px solid #f59e0b',
                    borderRadius: '2px'
                  }} />

                  {/* Reference Point Marker */}
                  {numRef !== null && (
                    <div style={{
                      position: 'absolute',
                      left: `${getPct(numRef)}%`,
                      top: '-18px',
                      transform: 'translateX(-50%)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      pointerEvents: 'none'
                    }}>
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#38bdf8', whiteSpace: 'nowrap' }}>
                        {t('settings.device_advanced.ref')} ({numRef})
                      </span>
                      <div style={{ width: '2px', height: '40px', backgroundColor: '#38bdf8', opacity: 0.8 }} />
                    </div>
                  )}

                  {/* Drive Constant Marker */}
                  <div style={{
                    position: 'absolute',
                    left: `${getPct(numDrive)}%`,
                    top: '-18px',
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    pointerEvents: 'none'
                  }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#818cf8', whiteSpace: 'nowrap' }}>
                      {t('settings.device_advanced.drive')} ({numDrive})
                    </span>
                    <div style={{ width: '2px', height: '40px', backgroundColor: '#818cf8', opacity: 0.8 }} />
                  </div>

                  {/* Seat Point Marker (100% Open) */}
                  {numSeat !== null && (
                    <div style={{
                      position: 'absolute',
                      left: `${getPct(numSeat)}%`,
                      top: '-18px',
                      transform: 'translateX(-50%)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      pointerEvents: 'none'
                    }}>
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--success, #22c55e)', whiteSpace: 'nowrap' }}>
                        {t('settings.device_advanced.seat')} ({numSeat})
                      </span>
                      <div style={{ width: '2px', height: '40px', backgroundColor: 'var(--success, #22c55e)', opacity: 0.9 }} />
                    </div>
                  )}

                  {/* Current Position Marker */}
                  {numPos1 !== null && (
                    <div style={{
                      position: 'absolute',
                      left: `${getPct(numPos1)}%`,
                      top: '32px',
                      transform: 'translateX(-50%)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      zIndex: 3,
                      pointerEvents: 'none'
                    }}>
                      <div style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        backgroundColor: '#ec4899',
                        boxShadow: '0 0 8px #ec4899'
                      }} />
                      <span style={{ fontSize: '0.65rem', fontWeight: 800, color: '#ec4899', whiteSpace: 'nowrap', marginTop: '2px' }}>
                        {t('settings.device_advanced.live')} {numPos1}
                      </span>
                    </div>
                  )}

                  {/* High Steps Marker */}
                  <div style={{
                    position: 'absolute',
                    left: `${getPct(numHigh)}%`,
                    top: '-18px',
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    pointerEvents: 'none'
                  }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#f59e0b', whiteSpace: 'nowrap' }}>
                      {t('settings.device_advanced.high')} ({numHigh})
                    </span>
                    <div style={{ width: '2px', height: '40px', backgroundColor: '#f59e0b', opacity: 0.9 }} />
                  </div>

                  {/* Low Steps Marker (Closed Limit) */}
                  <div style={{
                    position: 'absolute',
                    left: `${getPct(numLow)}%`,
                    top: '-18px',
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    pointerEvents: 'none'
                  }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#ef4444', whiteSpace: 'nowrap' }}>
                      {t('settings.device_advanced.low_closed')} ({numLow})
                    </span>
                    <div style={{ width: '2px', height: '40px', backgroundColor: '#ef4444', opacity: 0.9 }} />
                  </div>
                </div>

                {/* Sliders & Synchronized Numeric Inputs */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  {/* Drive Constant */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8' }}>
                        {t('settings.device_advanced.drive_constant')}
                      </span>
                      <input
                        type="number"
                        min="1000"
                        max="2600"
                        value={driveConstant}
                        onChange={(e) => setDriveConstant(e.target.value)}
                        disabled={isReadOnly}
                        style={{
                          width: '75px',
                          padding: '0.25rem 0.4rem',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: 'var(--bg-card)',
                          border: '1px solid var(--border-color)',
                          color: 'var(--text-primary)',
                          textAlign: 'center',
                          fontSize: '0.8rem',
                          fontWeight: 700
                        }}
                      />
                    </div>
                    <input
                      type="range"
                      min="1000"
                      max="2600"
                      value={Number(driveConstant) || 1786}
                      onChange={(e) => setDriveConstant(Number(e.target.value))}
                      disabled={isReadOnly}
                      style={{ width: '100%', cursor: 'pointer', accentColor: '#818cf8' }}
                    />
                  </div>

                  {/* High Steps */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#f59e0b' }}>
                        {t('settings.device_advanced.high_steps')}
                      </span>
                      <input
                        type="number"
                        min="1500"
                        max="2800"
                        value={highSteps}
                        onChange={(e) => setHighSteps(e.target.value)}
                        disabled={isReadOnly}
                        style={{
                          width: '75px',
                          padding: '0.25rem 0.4rem',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: 'var(--bg-card)',
                          border: '1px solid var(--border-color)',
                          color: 'var(--text-primary)',
                          textAlign: 'center',
                          fontSize: '0.8rem',
                          fontWeight: 700
                        }}
                      />
                    </div>
                    <input
                      type="range"
                      min="1500"
                      max="2800"
                      value={Number(highSteps) || 2244}
                      onChange={(e) => setHighSteps(Number(e.target.value))}
                      disabled={isReadOnly}
                      style={{ width: '100%', cursor: 'pointer', accentColor: '#f59e0b' }}
                    />
                  </div>

                  {/* Low Steps */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#ef4444' }}>
                        {t('settings.device_advanced.low_steps')}
                      </span>
                      <input
                        type="number"
                        min="1800"
                        max="3000"
                        value={lowSteps}
                        onChange={(e) => setLowSteps(e.target.value)}
                        disabled={isReadOnly}
                        style={{
                          width: '75px',
                          padding: '0.25rem 0.4rem',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: 'var(--bg-card)',
                          border: '1px solid var(--border-color)',
                          color: 'var(--text-primary)',
                          textAlign: 'center',
                          fontSize: '0.8rem',
                          fontWeight: 700
                        }}
                      />
                    </div>
                    <input
                      type="range"
                      min="1800"
                      max="3000"
                      value={Number(lowSteps) || 2390}
                      onChange={(e) => setLowSteps(Number(e.target.value))}
                      disabled={isReadOnly}
                      style={{ width: '100%', cursor: 'pointer', accentColor: '#ef4444' }}
                    />
                  </div>
                </div>

                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4', backgroundColor: 'var(--bg-card)', padding: '0.75rem', borderRadius: 'var(--radius-sm)' }}>
                  <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-primary)' }}>{t('settings.device_advanced.understanding_stepper')}</h4>
                  • {t('settings.device_advanced.stepper_rule_1')}
                  <br />
                  • {t('settings.device_advanced.stepper_rule_seat')}
                  <br />
                  • {t('settings.device_advanced.stepper_rule_mod')}
                  <br />
                  • {t('settings.device_advanced.stepper_rule_low')}
                </div>

                {/* Validation Warnings */}
                {(numLow < numHigh || numHigh < numDrive || numLow < numDrive) && (
                  <div style={{
                    padding: '0.6rem 0.75rem',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid var(--danger, #ef4444)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--danger, #ef4444)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem'
                  }}>
                    {numLow < numHigh && (
                      <span>• {t('settings.device_advanced.stepper_rule_err1', `Low Steps (closed limit: ${numLow}) cannot be lower than High Steps (open modulation limit: ${numHigh}).`)}</span>
                    )}
                    {(numHigh < numDrive || numLow < numDrive) && (
                      <span>• {t('settings.device_advanced.stepper_rule_err2', `High/Low steps cannot be lower than Drive Constant baseline (${numDrive}).`)}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Actuator Diagnostics */}
          <div style={{
            borderTop: '1px solid var(--border-color)',
            paddingTop: '1rem',
            marginTop: '0.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
          }}>
            <h4 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0 }}>{t('settings.device_advanced.actuator_diag_title')}</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('common.status')}</span>
                <span style={{ fontWeight: 600, color: device?.actuatorLimits?.active ? 'var(--success)' : 'var(--text-muted)' }}>
                  {device?.actuatorLimits?.active ? t('settings.device_advanced.calibrated_active', 'Active (Calibrated)') : t('settings.device_advanced.uncalibrated_inactive', 'Inactive (Uncalibrated)')}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.device_advanced.mounting_state')}</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {device?.actuatorLimits?.mountingState || 'UNKNOWN'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Position 1 / 2</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                  {device?.actuatorLimits?.position1 !== null ? device.actuatorLimits.position1 : '-'} / {device?.actuatorLimits?.position2 !== null ? device.actuatorLimits.position2 : '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Seat / Reference</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                  {device?.actuatorLimits?.seatPoint !== null ? device.actuatorLimits.seatPoint : '-'} / {device?.actuatorLimits?.referencePoint !== null ? device.actuatorLimits.referencePoint : '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Mode / Flags</span>
                <span style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                  {device?.actuatorLimits?.mode !== null ? device.actuatorLimits.mode : '-'} / {device?.actuatorLimits?.flags !== null ? device.actuatorLimits.flags : '-'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{t('settings.device_advanced.deviation', 'Deviation')}</span>
                {device?.actuatorLimits?.deviation !== null && device?.actuatorLimits?.deviation !== undefined && device?.actuatorLimits?.deviation !== 32767 ? (
                  <span style={{
                    fontWeight: 700,
                    color: (device.actuatorLimits.deviation < -100 || device.actuatorLimits.deviation > 100)
                      ? 'var(--danger)'
                      : (Math.abs(device.actuatorLimits.deviation) > 10 ? 'var(--warning)' : 'var(--success)')
                  }}>
                    {device.actuatorLimits.deviation > 0 ? '+' : ''}{device.actuatorLimits.deviation}
                    {(device.actuatorLimits.deviation < -100 || device.actuatorLimits.deviation > 100) && ' (Stuck / Blocked)'}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>N/A</span>
                )}
              </div>
            </div>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
              <em>{t('settings.device_advanced.diag_interp_title')}</em>: {t('settings.device_advanced.diag_interp_desc')}
            </p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
            <Button
              variant="primary"
              onClick={handleSaveActuatorLimits}
              disabled={isSavingLimits || isReadOnly || Number(lowSteps) < Number(highSteps) || Number(highSteps) < Number(driveConstant) || Number(lowSteps) < Number(driveConstant)}
            >
              <span>{isSavingLimits ? t('settings.saving') : t('settings.save_limits', 'Save Limits')}</span>
            </Button>
          </div>
        </Card>
      )}

      {/* Valve Mount Calibration (Radiator Valves only) */}
      {isValve && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Wrench size={16} />
            {t('settings.device_advanced.calibrate_title')}
          </h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            {t('settings.device_advanced.calibrate_desc')}
          </p>
          <div style={{ display: 'flex' }}>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await triggerMountCalibration(homeId, targetSerial, 'start');
                  showToast(t('settings.device_advanced.toast_calibration_started'));
                } catch (e) {
                  showToast(e.message || 'Failed to start mount calibration.', 'error');
                }
              }}
            >
              {t('settings.device_advanced.start_calibration')}
            </Button>
          </div>
        </Card>
      )}

      {/* Hardware Self-Test (Room Units & Thermostats only) */}
      {isStat && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Wrench size={16} />
            {t('settings.hardware_selftest', 'Hardware Self-Test')}
          </h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
            {t('settings.device_advanced.self_test_desc')}
          </p>
          <div>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await triggerSelftest(homeId, targetSerial);
                  showToast(t('settings.device_advanced.toast_self_test_sent'));
                } catch (e) {
                  showToast(e.message || 'Failed to trigger self-test.', 'error');
                }
              }}
            >
              {t('settings.run_selftest', 'Run Self-Test')}
            </Button>
          </div>
        </Card>
      )}

      {/* CoAP Memory Dumper (/d/dbg/m) */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Bug size={16} />
              {t('settings.memory_dumper', 'CoAP Memory Dumper (/d/dbg/m)')}
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0 0', lineHeight: '1.4' }}>
              {t('settings.device_advanced.memory_dumper_desc')}
            </p>
          </div>
          {device?.deviceType && (
            <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '0.25rem', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
              {t('settings.device_advanced.hardware')} <strong>{device.deviceType}</strong> ({isValve ? 'nRF52832' : isStat ? 'STM32L0' : 'STM32F411'})
            </span>
          )}
        </div>

        {/* Memory Presets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('settings.device_advanced.memory_presets')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {isValve && (
              <Button
                variant="secondary"
                onClick={() => { setDbgAdr('00000000'); setDbgLen('64'); }}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                {t('settings.device_advanced.internal_flash_0')}
              </Button>
            )}
            {!isValve && (
              <Button
                variant="secondary"
                onClick={() => { setDbgAdr('08000000'); setDbgLen('64'); }}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                {t('settings.device_advanced.internal_flash_8')}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => { setDbgAdr('20000000'); setDbgLen('64'); }}
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
            >
              {t('settings.device_advanced.sram_live')}
            </Button>
            {(isValve || (!isValve && !isStat)) && (
              <Button
                variant="secondary"
                onClick={() => { setDbgAdr('80000000'); setDbgLen('64'); }}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                {t('settings.device_advanced.spi_flash')}
              </Button>
            )}
          </div>
        </div>

        {/* Memory Query Inputs */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '140px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{t('settings.device_advanced.address_hex')}</label>
            <input
              type="text"
              value={dbgAdr}
              onChange={(e) => setDbgAdr(e.target.value.replace(/[^0-9a-fA-F]/g, ''))}
              placeholder={isValve ? "00000000" : "08000000"}
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: `1px solid ${isAdrValid ? 'var(--border-color)' : 'var(--danger)'}`, backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{t('settings.device_advanced.length_b')}</label>
            <input
              type="number"
              min="1"
              max="64"
              value={dbgLen}
              onChange={(e) => setDbgLen(e.target.value)}
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: `1px solid ${isLenValid ? 'var(--border-color)' : 'var(--danger)'}`, backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '150px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{t('settings.device_advanced.dump_size')}</label>
            <select
              value={dumpRangeBytes}
              onChange={(e) => setDumpRangeBytes(Number(e.target.value))}
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            >
              <option value="16">16 Bytes (Single Block)</option>
              <option value="64">64 Bytes</option>
              <option value="256">256 Bytes</option>
              <option value="1024">1 KB</option>
              <option value="4096">4 KB (Sector)</option>
              {isStat && <option value="20480">20 KB (RU02 RAM)</option>}
              <option value="65536">64 KB (Full RAM / RU02 Flash)</option>
              {isIB && <option value="131072">128 KB (IB01 RAM)</option>}
              {(isValve || isIB) && <option value="524288">512 KB (Full MCU Flash)</option>}
              {isValve && <option value="1048576">1 MB (Full SPI Flash)</option>}
              {isIB && <option value="2097152">2 MB (Full SPI Flash)</option>}
            </select>
          </div>
        </div>

        {/* Validation Warning Alert */}
        {!isAdrValid && (
          <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'var(--danger-glow)', color: 'var(--danger)', borderRadius: '0.35rem', fontSize: '0.75rem', lineHeight: '1.4' }}>
            {adrWarning || 'Invalid address. Please enter a valid hexadecimal memory address.'}
          </div>
        )}

        {/* Action Controls */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            variant="secondary"
            disabled={!isAdrValid || !isLenValid || serverDumpStatus?.isRunning}
            onClick={async () => {
              activeDebugRef.current = { tab: 'm', adr: dbgAdr, mid: null, fid: null };
              try {
                const res = await triggerDeviceDebug(homeId, targetSerial, 'm', { adr: dbgAdr, len: dbgLen });
                if (res?.mid) activeDebugRef.current.mid = res.mid;
                if (res && res.bytes && res.bytes.length > 0) {
                  showToast(`Captured ${res.bytes.length}B from 0x${dbgAdr}`);
                  activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
                } else {
                  showToast(`Memory query queued (MID ${res?.mid}). Rotate dial to wake device.`);
                }
              } catch (e) {
                showToast(e.message || 'Failed to query /d/dbg/m', 'error');
                activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
              }
            }}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            {t('settings.device_advanced.read_single_block', `Read Single Block (${dbgLen}B)`)}
          </Button>

          {!serverDumpStatus?.isRunning ? (
            <>
              {serverDumpStatus?.hasPart || serverDumpStatus?.isResumable ? (
                <>
                  <Button
                    variant="primary"
                    disabled={!isAdrValid}
                    onClick={() => handleStartServerDump(false)}
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
                  >
                    {t('settings.device_advanced.resume_dump', 'Resume Dump')} ({serverDumpStatus.partBytes ? `${(serverDumpStatus.partBytes / 1024).toFixed(1)} KB done` : 'Continue'})
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!isAdrValid}
                    onClick={() => handleStartServerDump(true)}
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
                  >
                    {t('settings.device_advanced.start_over')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  disabled={!isAdrValid}
                  onClick={() => handleStartServerDump(false)}
                  style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
                >
                  {t('settings.device_advanced.start_server_dump', `Start Server Dump (${dumpRangeBytes >= 1048576 ? `${dumpRangeBytes / 1048576}MB` : dumpRangeBytes >= 1024 ? `${dumpRangeBytes / 1024}KB` : `${dumpRangeBytes}B`})`)}
                </Button>
              )}
            </>
          ) : (
            <Button
              variant="danger"
              onClick={handleCancelServerDump}
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
            >
              {t('settings.device_advanced.cancel_dump')}
            </Button>
          )}

          {serverDumpStatus?.hasFile && (
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  showToast(t('settings.device_advanced.toast_downloading_dump'), 'info');
                  await downloadMemoryDumpFile(homeId, targetSerial, serverDumpStatus.fileName);
                  showToast(t('settings.device_advanced.toast_download_complete'), 'success');
                } catch (e) {
                  showToast(e.message || 'Failed to download dump file', 'error');
                }
              }}
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
            >
              {t('settings.device_advanced.download')} {serverDumpStatus.fileName} ({serverDumpStatus.bytesReceived} B)
            </Button>
          )}
        </div>

        {/* Server Dump Progress Bar */}
        {serverDumpStatus && (serverDumpStatus.isRunning || serverDumpStatus.status === 'completed' || serverDumpStatus.status === 'paused' || serverDumpStatus.error || serverDumpStatus.hasPart) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.35rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.25rem' }}>
              <span>
                <strong>{t('common.status')}:</strong> {serverDumpStatus.isRunning ? t('settings.device_advanced.dumping_background') : serverDumpStatus.status === 'completed' ? t('settings.device_advanced.dump_completed') : serverDumpStatus.status === 'paused' || serverDumpStatus.hasPart ? t('settings.device_advanced.paused_resumable') : serverDumpStatus.status}
              </span>
              <span>
                {serverDumpStatus.bytesReceived ? serverDumpStatus.bytesReceived.toLocaleString() : (serverDumpStatus.partBytes || 0).toLocaleString()} {serverDumpStatus.totalBytes ? `/ ${serverDumpStatus.totalBytes.toLocaleString()} Bytes (${serverDumpStatus.percent}%)` : t('settings.device_advanced.bytes_on_disk')}
              </span>
            </div>

            <div style={{ width: '100%', height: '8px', backgroundColor: 'var(--bg-primary)', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{
                width: `${serverDumpStatus.percent || (serverDumpStatus.totalBytes ? Math.round(((serverDumpStatus.partBytes || 0) / serverDumpStatus.totalBytes) * 100) : 0)}%`,
                height: '100%',
                backgroundColor: serverDumpStatus.status === 'completed' ? 'var(--success)' : serverDumpStatus.error ? 'var(--danger)' : 'var(--primary)',
                transition: 'width 0.3s'
              }} />
            </div>
            {serverDumpStatus.error && (
              <span style={{ fontSize: '0.7rem', color: 'var(--danger)' }}>
                {t('common.error')}: {serverDumpStatus.error}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* ========================================================================= */}
      {/* Live Diagnostic & Control State Card (/d/dbg/st)                           */}
      {/* ========================================================================= */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Card Header & Architecture Badges */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Sliders size={20} style={{ color: 'var(--primary)' }} />
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {t('settings.device_advanced.live_diag_title', 'Diagnostic & Control State (/d/dbg/st)')}
              </h3>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.35rem 0 0 0', lineHeight: '1.4' }}>
              {t('settings.device_advanced.live_diag_desc', 'Low-level device parameter overrides, sensor feeds, RF test modes, and hardware telemetry in RAM.')}
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'var(--primary-glow)', color: 'var(--primary)', borderRadius: '4px', fontWeight: 600 }}>
              RAM Volatile State
            </span>
            {isIB ? (
              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'rgba(234, 179, 8, 0.15)', color: 'var(--warning)', borderRadius: '4px', fontWeight: 600 }}>
                IB PUT-Only (handler_get = NULL)
              </span>
            ) : (
              <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'var(--success-glow)', color: 'var(--success)', borderRadius: '4px', fontWeight: 600 }}>
                Bidirectional R/W
              </span>
            )}
          </div>
        </div>

        {/* IB Architecture Notice */}
        {isIB && (
          <div style={{
            padding: '0.65rem 0.85rem',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.75rem',
            lineHeight: 1.5,
            color: 'var(--text-primary)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <HelpCircle size={16} style={{ color: '#38bdf8', flexShrink: 0 }} />
            <div>
              <strong>Firmware Notice (IB01)</strong>: Internet Bridge firmware defines <code>handler_get = NULL</code> for <code>/d/dbg/st</code>. State injection via <code>PUT</code> is supported, but parameter reads must be performed using <strong>NVM Storage (/d/dbg2/tlvs)</strong> or the <strong>Memory Dumper (/d/dbg/m)</strong>.
            </div>
          </div>
        )}

        {/* Category Tabs & Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {[
              { id: 'all', label: 'All Parameters' },
              { id: 'actuator', label: 'Actuator & Motor (VA)' },
              { id: 'radio', label: 'Radio & RF' },
              { id: 'telemetry', label: 'Sensors & Telemetry' },
              { id: 'simulation', label: 'Simulation Hooks' }
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStCategory(tab.id)}
                style={{
                  fontSize: '0.72rem',
                  fontWeight: stCategory === tab.id ? 700 : 500,
                  padding: '0.3rem 0.65rem',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: stCategory === tab.id ? 'var(--primary)' : 'var(--bg-input)',
                  color: stCategory === tab.id ? 'var(--text-on-primary)' : 'var(--text-secondary)',
                  border: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)'
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Preset Selector Dropdown */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('settings.device_advanced.diag_preset', 'Select Diagnostic Parameter')}
            </label>
            <select
              value={stFid}
              onChange={(e) => {
                const selected = DIAG_FIDS.find(item => item.fid === e.target.value);
                setStFid(e.target.value);
                if (selected) {
                  setStLen(String(selected.len));
                  // If cached value exists, populate
                  if (stCache[selected.fid]) {
                    setStValue(stCache[selected.fid].hex || String(stCache[selected.fid].val));
                    setStFriendly(stCache[selected.fid].friendly || '');
                    setStResult(stCache[selected.fid]);
                  } else {
                    setStValue('');
                    setStFriendly('');
                    setStResult(null);
                  }
                }
              }}
              style={{
                fontSize: '0.85rem',
                padding: '0.5rem 0.65rem',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontFamily: 'monospace'
              }}
            >
              {filteredDiags.map(item => (
                <option key={item.fid} value={item.fid}>
                  {item.fid} — {item.label.split(' - ')[1] || item.name} [{item.access.toUpperCase()}]
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Dual-Pane Parameter Console */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          backgroundColor: 'var(--bg-input)',
          padding: '1rem',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-color)'
        }}>

          {/* Left Pane: Parameter Specification & Smart Value Inputs */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                  {currentStDef.shortLabel || currentStDef.name}
                </strong>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <span style={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    padding: '0.15rem 0.4rem',
                    borderRadius: '4px',
                    backgroundColor: currentStDef.access === 'rw' ? 'var(--primary-glow)' : currentStDef.access === 'ro' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    color: currentStDef.access === 'rw' ? 'var(--primary)' : currentStDef.access === 'ro' ? '#38bdf8' : '#f59e0b'
                  }}>
                    {currentStDef.access === 'rw' ? 'READ / WRITE' : currentStDef.access === 'ro' ? 'READ-ONLY' : 'WRITE-ONLY'}
                  </span>
                  <span style={{ fontSize: '0.65rem', fontWeight: 600, padding: '0.15rem 0.4rem', borderRadius: '4px', backgroundColor: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                    {currentStDef.len}B ({currentStDef.type})
                  </span>
                </div>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.3rem 0 0 0', lineHeight: 1.4 }}>
                {currentStDef.desc}
              </p>
            </div>

            {/* Smart Type-Specific Input Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {/* Motor Steps (0x03ED) */}
              {currentStDef.fid === '0x03ED' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <Button variant="secondary" onClick={() => { setStValue('0'); setStFriendly('0 steps'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      0 (Closed Seat)
                    </Button>
                    <Button variant="secondary" onClick={() => { setStValue('1200'); setStFriendly('1200 steps'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      1200 (Half Open)
                    </Button>
                    <Button variant="secondary" onClick={() => { setStValue('2400'); setStFriendly('2400 steps'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      2400 (Modulation Limit)
                    </Button>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="3000"
                    step="50"
                    value={Number(stValue) || 0}
                    onChange={(e) => {
                      setStValue(e.target.value);
                      setStFriendly(`${e.target.value} steps`);
                    }}
                    style={{ width: '100%', cursor: 'pointer' }}
                  />
                </div>
              )}

              {/* Carrier Test Mode (0x01FA) */}
              {currentStDef.fid === '0x01FA' && (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Button
                    variant={stValue === '0' ? 'primary' : 'secondary'}
                    onClick={() => { setStValue('0'); setStFriendly('0 - Normal Radio (CW Disabled)'); }}
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
                  >
                    0 - Normal Radio
                  </Button>
                  <Button
                    variant={stValue === '2' ? 'primary' : 'secondary'}
                    onClick={() => { setStValue('2'); setStFriendly('2 - Active Continuous Wave'); }}
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
                  >
                    2 - Active CW Carrier Wave
                  </Button>
                </div>
              )}

              {/* Temperature Compensation (0x0294) */}
              {currentStDef.fid === '0x0294' && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="number"
                    step="0.1"
                    placeholder="21.5"
                    value={stFriendly.replace(/[^\d.-]/g, '')}
                    onChange={(e) => {
                      const fVal = e.target.value;
                      setStFriendly(fVal ? `${fVal} °C` : '');
                      if (fVal && !isNaN(Number(fVal))) {
                        setStValue(Math.round(parseFloat(fVal) * 100).toString());
                      } else {
                        setStValue('');
                      }
                    }}
                    style={{
                      width: '100px',
                      padding: '0.35rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                      fontWeight: 600
                    }}
                  />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    °C {stValue ? `(→ raw s16: ${stValue})` : ''}
                  </span>
                </div>
              )}

              {/* Raw Value and Human Format Inputs */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: 1, minWidth: '130px' }}>
                  <label style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                    {t('settings.device_advanced.human_format', 'Decoded / Friendly')}
                  </label>
                  <input
                    type="text"
                    value={stFriendly}
                    onChange={(e) => {
                      const fVal = e.target.value;
                      setStFriendly(fVal);
                      setStValue(parseFriendlyToRaw(stFid, fVal, stLen));
                    }}
                    placeholder="e.g. 18.22 °C or 1850 steps"
                    disabled={currentStDef.access === 'ro'}
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.4rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: 1, minWidth: '130px' }}>
                  <label style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                    {t('settings.device_advanced.val_inject_label', 'Raw Injection Value')}
                  </label>
                  <input
                    type="text"
                    value={stValue}
                    onChange={(e) => {
                      const rVal = e.target.value;
                      setStValue(rVal);
                      setStFriendly(formatFriendlyValue(stFid, rVal, isNaN(Number(rVal)) ? null : Number(rVal)));
                    }}
                    placeholder="e.g. 1850 or 073a"
                    disabled={currentStDef.access === 'ro'}
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.4rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${!stValidation.isValid && stValue ? 'var(--danger)' : 'var(--border-color)'}`,
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                      fontFamily: 'monospace'
                    }}
                  />
                </div>
              </div>

              {/* Validation Warning */}
              {!stValidation.isValid && stValue !== '' && (
                <div style={{ fontSize: '0.7rem', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <AlertCircle size={12} />
                  <span>{stValidation.error}</span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <Button
                variant="secondary"
                disabled={stLoading || isIB || currentStDef.access === 'wo'}
                onClick={() => handleReadSt()}
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem', flex: 1 }}
              >
                {stLoading ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <RefreshCw size={12} className="spin-icon" />
                    {t('settings.device_advanced.reading', 'Reading...')}
                  </span>
                ) : isIB ? (
                  'GET Unsupported (IB)'
                ) : currentStDef.access === 'wo' ? (
                  'Write-Only in Firmware'
                ) : (
                  t('settings.device_advanced.read_param_get', 'Read Parameter (GET)')
                )}
              </Button>

              <Button
                variant="primary"
                disabled={stLoading || currentStDef.access === 'ro' || !stValidation.isValid || stValue === ''}
                onClick={handleWriteSt}
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem', flex: 1 }}
              >
                {stLoading ? (
                  t('settings.device_advanced.injecting', 'Injecting...')
                ) : currentStDef.access === 'ro' ? (
                  'Read-Only Parameter'
                ) : (
                  t('settings.device_advanced.inject_ram_put', 'Inject into RAM (PUT)')
                )}
              </Button>
            </div>
          </div>

          {/* Right Pane: Live Telemetry & Inspector */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            backgroundColor: 'var(--bg-card)',
            padding: '0.85rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                Hardware Response & Telemetry
              </span>
              {stResult && (
                <span style={{ fontSize: '0.65rem', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <CheckCircle2 size={12} />
                  CoAP {stResult.code ? `(${stResult.code})` : 'OK'}
                </span>
              )}
            </div>

            {/* Hero Value Display */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.75rem 0.5rem',
              backgroundColor: 'var(--bg-input)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Active Firmware Value
              </span>
              <strong style={{ fontSize: '1.25rem', color: 'var(--primary)', margin: '0.2rem 0', textAlign: 'center' }}>
                {stFriendly || (stValue !== '' ? stValue : 'No Reading Yet')}
              </strong>
              {stResult?.timestamp && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                  Captured at {stResult.timestamp}
                </span>
              )}
            </div>

            {/* Technical Parameters Feed */}
            {stResult ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Message ID (MID):</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{stResult.mid || 'N/A'}</span>
                </div>
                {stResult.val !== undefined && stResult.val !== null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Decimal (Dec):</span>
                    <span style={{ color: 'var(--success)', fontWeight: 600 }}>{stResult.val}</span>
                  </div>
                )}
                {stResult.hex && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Hexadecimal:</span>
                    <span style={{ color: 'var(--primary)', fontWeight: 600 }}>0x{stResult.hex}</span>
                  </div>
                )}
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  {stResult.message || 'Telemetry synchronized with device over 868 MHz CoAP.'}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem 0' }}>
                Click "Read Parameter" or wait for background SSE push from device.
              </div>
            )}
          </div>
        </div>

        {/* Quick Parameters Matrix (All 15 Diagnostic FIDs) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
            Quick Parameters Overview ({filteredDiags.length})
          </span>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: '0.5rem'
          }}>
            {filteredDiags.map(item => {
              const cached = stCache[item.fid];
              const isSelected = item.fid === stFid;
              return (
                <div
                  key={item.fid}
                  onClick={() => {
                    setStFid(item.fid);
                    setStLen(String(item.len));
                    if (cached) {
                      setStValue(cached.hex || String(cached.val));
                      setStFriendly(cached.friendly || '');
                      setStResult(cached);
                    }
                  }}
                  style={{
                    padding: '0.5rem 0.65rem',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-card)',
                    border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}`,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, fontFamily: 'monospace' }}>
                      {item.fid}
                    </span>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      padding: '0.1rem 0.3rem',
                      borderRadius: '3px',
                      backgroundColor: item.access === 'rw' ? 'var(--primary-glow)' : item.access === 'ro' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      color: item.access === 'rw' ? 'var(--primary)' : item.access === 'ro' ? '#38bdf8' : '#f59e0b'
                    }}>
                      {item.access.toUpperCase()}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.shortLabel || item.name}
                  </span>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.2rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 600, color: cached ? 'var(--primary)' : 'var(--text-muted)' }}>
                      {cached ? (cached.friendly || cached.hex || cached.val) : '—'}
                    </span>
                    {!isIB && item.access !== 'wo' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setStFid(item.fid);
                          setStLen(String(item.len));
                          handleReadSt(item.fid);
                        }}
                        style={{
                          fontSize: '0.65rem',
                          padding: '0.15rem 0.4rem',
                          borderRadius: '3px',
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-input)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer'
                        }}
                      >
                        Read
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {/* ========================================================================= */}
      {/* NVM Persistent Storage Card (/d/dbg2/tlvs)                                 */}
      {/* ========================================================================= */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Card Header & Badges */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Database size={20} style={{ color: 'var(--primary)' }} />
              <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                {t('settings.device_advanced.nvm_storage_title', 'NVM Persistent Storage (/d/dbg2/tlvs)')}
              </h3>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.35rem 0 0 0', lineHeight: '1.4' }}>
              {t('settings.device_advanced.nvm_storage_desc', 'Non-volatile flash parameter slots: RF band modes, pairing keys, hardware MAC addresses, and calibration records.')}
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'var(--primary-glow)', color: 'var(--primary)', borderRadius: '4px', fontWeight: 600 }}>
              Non-Volatile Flash
            </span>
            <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
              12 TLV Slots
            </span>
          </div>
        </div>

        {/* Category Tabs & Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {[
              { id: 'all', label: 'All Slots' },
              { id: 'network', label: 'Radio & Network' },
              { id: 'security', label: 'Identity & Security' },
              { id: 'hardware', label: 'Hardware & Calibration' }
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setNvmCategory(tab.id)}
                style={{
                  fontSize: '0.72rem',
                  fontWeight: nvmCategory === tab.id ? 700 : 500,
                  padding: '0.3rem 0.65rem',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: nvmCategory === tab.id ? 'var(--primary)' : 'var(--bg-input)',
                  color: nvmCategory === tab.id ? 'var(--text-on-primary)' : 'var(--text-secondary)',
                  border: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  transition: 'all var(--transition-fast)'
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Slot Selector Dropdown */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('settings.device_advanced.nvm_preset', 'Select NVM Storage Slot')}
            </label>
            <select
              value={nvmFid}
              onChange={(e) => {
                const selected = NVM_SLOTS.find(item => item.fid === e.target.value);
                setNvmFid(e.target.value);
                if (selected) {
                  setNvmLen(String(selected.len));
                  if (nvmCache[selected.fid]) {
                    setNvmValue(nvmCache[selected.fid].hex || String(nvmCache[selected.fid].val));
                    setNvmFriendly(nvmCache[selected.fid].friendly || '');
                    setNvmResult(nvmCache[selected.fid]);
                  } else {
                    setNvmValue('');
                    setNvmFriendly('');
                    setNvmResult(null);
                  }
                }
              }}
              style={{
                fontSize: '0.85rem',
                padding: '0.5rem 0.65rem',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontFamily: 'monospace'
              }}
            >
              {filteredNvms.map(item => (
                <option key={item.fid} value={item.fid}>
                  {item.fid} — {item.label.split(' - ')[1] || item.name} [{item.access.toUpperCase()}]
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Dual-Pane NVM Console */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          backgroundColor: 'var(--bg-input)',
          padding: '1rem',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-color)'
        }}>

          {/* Left Pane: Slot Specification & Smart Value Inputs */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                  {currentNvmDef.shortLabel || currentNvmDef.name}
                </strong>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <span style={{
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    padding: '0.15rem 0.4rem',
                    borderRadius: '4px',
                    backgroundColor: currentNvmDef.access === 'rw' ? 'var(--primary-glow)' : currentNvmDef.access === 'ro' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    color: currentNvmDef.access === 'rw' ? 'var(--primary)' : currentNvmDef.access === 'ro' ? '#38bdf8' : '#f59e0b'
                  }}>
                    {currentNvmDef.access === 'rw' ? 'READ / WRITE' : currentNvmDef.access === 'ro' ? 'READ-ONLY' : currentNvmDef.access === 'wo_protected' ? 'READ-PROTECTED' : 'WRITE-ONLY'}
                  </span>
                  <span style={{ fontSize: '0.65rem', fontWeight: 600, padding: '0.15rem 0.4rem', borderRadius: '4px', backgroundColor: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                    {currentNvmDef.len}B
                  </span>
                </div>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.3rem 0 0 0', lineHeight: 1.4 }}>
                {currentNvmDef.desc}
              </p>
            </div>

            {/* Smart Type-Specific Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {/* RF Band / Mode (0x0001) */}
              {currentNvmDef.fid === '0x0001' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <label style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Presets / Common Modes</label>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <Button variant="secondary" onClick={() => { setNvmValue('41'); setNvmFriendly('Channel 26 (Band A / 868.325 MHz - VA)'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      0x41 (Band A - VA)
                    </Button>
                    <Button variant="secondary" onClick={() => { setNvmValue('42'); setNvmFriendly('Channel 26 (Band B / 868.325 MHz - IB)'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      0x42 (Band B - IB)
                    </Button>
                    <Button variant="secondary" onClick={() => { setNvmValue('55'); setNvmFriendly('868 MHz Sub-GHz Band (0x55 - RU)'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                      0x55 (Sub-GHz - RU)
                    </Button>
                  </div>
                </div>
              )}

              {/* PAN ID Presets (0x000A) */}
              {currentNvmDef.fid === '0x000A' && (
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <Button variant="secondary" onClick={() => { setNvmValue('65535'); setNvmFriendly('0xFFFF (Coordinator / All PANs)'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                    0xFFFF (Coordinator)
                  </Button>
                  <Button variant="secondary" onClick={() => { setNvmValue('255'); setNvmFriendly('255 (0x00FF - Paired PAN)'); }} style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                    255 (Joined PAN)
                  </Button>
                </div>
              )}

              {/* Read-Protected AES Key Warning (0x000B) */}
              {currentNvmDef.fid === '0x000B' && (
                <div style={{ padding: '0.5rem', backgroundColor: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 'var(--radius-sm)', fontSize: '0.72rem', color: 'var(--warning)', lineHeight: 1.4 }}>
                  <Lock size={12} style={{ display: 'inline', marginRight: '4px' }} />
                  <strong>Hardware Flash Protected</strong>: Direct flash reads over RF return 0xFF mask. Writing to this slot overwrites the AES-128 link key in persistent storage.
                </div>
              )}

              {/* Factory Reset NVM Trigger (0x000C) */}
              {currentNvmDef.fid === '0x000C' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '0.65rem', borderRadius: 'var(--radius-sm)' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--danger)', fontWeight: 600 }}>
                    ⚠️ Erases all persistent NVM parameters and reverts device to factory uncommissioned state.
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={confirmFactoryReset}
                      onChange={(e) => {
                        setConfirmFactoryReset(e.target.checked);
                        if (e.target.checked) {
                          setNvmValue('1');
                          setNvmFriendly('1 - Erase Trigger');
                        }
                      }}
                    />
                    <span>I confirm NVM flash erase</span>
                  </label>
                </div>
              )}

              {/* Inputs */}
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: 1, minWidth: '130px' }}>
                  <label style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>Human-Friendly Format</label>
                  <input
                    type="text"
                    value={nvmFriendly}
                    onChange={(e) => {
                      const fVal = e.target.value;
                      setNvmFriendly(fVal);
                      setNvmValue(parseFriendlyToRaw(nvmFid, fVal, nvmLen));
                    }}
                    placeholder="e.g. Channel 26 or 00:1B:C5:..."
                    disabled={currentNvmDef.access === 'ro'}
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.4rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-color)',
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: 1, minWidth: '130px' }}>
                  <label style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                    {t('settings.device_advanced.val_store_label', 'Raw NVM Hex / Dec')}
                  </label>
                  <input
                    type="text"
                    value={nvmValue}
                    onChange={(e) => {
                      const rVal = e.target.value;
                      setNvmValue(rVal);
                      setNvmFriendly(formatFriendlyValue(nvmFid, rVal, isNaN(Number(rVal)) ? null : Number(rVal)));
                    }}
                    placeholder="e.g. 41 or 16B hex key"
                    disabled={currentNvmDef.access === 'ro'}
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.4rem 0.5rem',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${!nvmValidation.isValid && nvmValue ? 'var(--danger)' : 'var(--border-color)'}`,
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                      fontFamily: 'monospace'
                    }}
                  />
                </div>
              </div>

              {/* Validation Warning */}
              {!nvmValidation.isValid && nvmValue !== '' && (
                <div style={{ fontSize: '0.7rem', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <AlertCircle size={12} />
                  <span>{nvmValidation.error}</span>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <Button
                variant="secondary"
                disabled={nvmLoading || currentNvmDef.access === 'wo'}
                onClick={() => handleReadNvm()}
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem', flex: 1 }}
              >
                {nvmLoading ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <RefreshCw size={12} className="spin-icon" />
                    {t('settings.device_advanced.reading', 'Reading...')}
                  </span>
                ) : currentNvmDef.access === 'wo' ? (
                  'Write-Only in Firmware'
                ) : (
                  t('settings.device_advanced.read_stored_nvm', 'Read Stored NVM (GET)')
                )}
              </Button>

              <Button
                variant={currentNvmDef.fid === '0x000C' ? 'destructive' : 'primary'}
                disabled={nvmLoading || currentNvmDef.access === 'ro' || !nvmValidation.isValid || nvmValue === '' || (currentNvmDef.fid === '0x000C' && !confirmFactoryReset)}
                onClick={handleWriteNvm}
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem', flex: 1 }}
              >
                {nvmLoading ? (
                  t('settings.device_advanced.writing', 'Storing...')
                ) : currentNvmDef.access === 'ro' ? (
                  'Read-Only Slot'
                ) : (
                  t('settings.device_advanced.store_nvm_put', 'Store in Flash (PUT)')
                )}
              </Button>
            </div>
          </div>

          {/* Right Pane: Stored NVM Response Inspector */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            backgroundColor: 'var(--bg-card)',
            padding: '0.85rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-color)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                Persistent Storage State
              </span>
              {nvmResult && (
                <span style={{ fontSize: '0.65rem', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <CheckCircle2 size={12} />
                  CoAP {nvmResult.code ? `(${nvmResult.code})` : 'OK'}
                </span>
              )}
            </div>

            {/* Hero Value Display */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0.75rem 0.5rem',
              backgroundColor: 'var(--bg-input)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Stored Flash Record
              </span>
              <strong style={{ fontSize: '1.25rem', color: 'var(--primary)', margin: '0.2rem 0', textAlign: 'center', wordBreak: 'break-all' }}>
                {nvmFriendly || (nvmValue !== '' ? nvmValue : 'No Stored Reading')}
              </strong>
              {nvmResult?.timestamp && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                  Read at {nvmResult.timestamp}
                </span>
              )}
            </div>

            {/* Technical Parameters Feed */}
            {nvmResult ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Message ID (MID):</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{nvmResult.mid || 'N/A'}</span>
                </div>
                {nvmResult.val !== undefined && nvmResult.val !== null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Decimal (Dec):</span>
                    <span style={{ color: 'var(--success)', fontWeight: 600 }}>{nvmResult.val}</span>
                  </div>
                )}
                {nvmResult.hex && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Hex:</span>
                    <span style={{ color: 'var(--primary)', fontWeight: 600, wordBreak: 'break-all' }}>0x{nvmResult.hex}</span>
                  </div>
                )}
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  {nvmResult.message || 'Stored in device EEPROM/Flash TLV records.'}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem 0' }}>
                Click "Read Stored NVM" or select a slot to view cached value.
              </div>
            )}
          </div>
        </div>

        {/* Quick Slots Matrix (All 12 NVM Slots) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
            Quick Slots Overview ({filteredNvms.length})
          </span>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: '0.5rem'
          }}>
            {filteredNvms.map(item => {
              const cached = nvmCache[item.fid];
              const isSelected = item.fid === nvmFid;
              return (
                <div
                  key={item.fid}
                  onClick={() => {
                    setNvmFid(item.fid);
                    setNvmLen(String(item.len));
                    if (cached) {
                      setNvmValue(cached.hex || String(cached.val));
                      setNvmFriendly(cached.friendly || '');
                      setNvmResult(cached);
                    }
                  }}
                  style={{
                    padding: '0.5rem 0.65rem',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-card)',
                    border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}`,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                    transition: 'all var(--transition-fast)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, fontFamily: 'monospace' }}>
                      {item.fid}
                    </span>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      padding: '0.1rem 0.3rem',
                      borderRadius: '3px',
                      backgroundColor: item.access === 'rw' ? 'var(--primary-glow)' : item.access === 'ro' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      color: item.access === 'rw' ? 'var(--primary)' : item.access === 'ro' ? '#38bdf8' : '#f59e0b'
                    }}>
                      {item.access.toUpperCase()}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.shortLabel || item.name}
                  </span>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.2rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 600, color: cached ? 'var(--primary)' : 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }}>
                      {cached ? (cached.friendly || cached.hex || cached.val) : '—'}
                    </span>
                    {item.access !== 'wo' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setNvmFid(item.fid);
                          setNvmLen(String(item.len));
                          handleReadNvm(item.fid);
                        }}
                        style={{
                          fontSize: '0.65rem',
                          padding: '0.15rem 0.4rem',
                          borderRadius: '3px',
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-input)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer'
                        }}
                      >
                        Read
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}