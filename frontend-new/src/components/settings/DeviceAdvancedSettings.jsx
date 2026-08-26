/**
 * @file src/components/settings/DeviceAdvancedSettings.jsx
 * @brief Renders hardware actuator limits and screen screensaver configurations.
 * 
 * Exposes low-level micro-parameters including Display Brightness, Contrast, Screensaver timeouts,
 * and physical valve Actuator calibration step boundaries (low/high limits, drive constants) for motor tuning.
 */


import { useState, useEffect, useRef } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { ShieldAlert, Wrench, Bug, Sliders, Database } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import {
  triggerSelftest, triggerMountCalibration, triggerDeviceDebug,
  startMemoryDump, getMemoryDumpStatus, cancelMemoryDump, downloadMemoryDumpFile
} from '../../api/devices';

export const DIAG_FIDS = [
  { fid: '0x03ED', len: 2, name: 'va_motor_step_override', label: '0x03ED - Stepper Motor Step Position Target / Override (u16)' },
  { fid: '0x01AC', len: 2, name: 'diag_packet_counter', label: '0x01AC - Diagnostic Trigger / Mode Counter (u16)' },
  { fid: '0x0289', len: 2, name: 'va_motor_stall_threshold', label: '0x0289 - Motor Stall Current Threshold (u16)' },
  { fid: '0x024B', len: 1, name: 'rf_channel_override', label: '0x024B - RF Channel Test Override (u8)' },
  { fid: '0x01C6', len: 2, name: 'batt_impedance_threshold', label: '0x01C6 - Battery Impedance Threshold (u16)' },
  { fid: '0x01FA', len: 1, name: 'rf_carrier_test_mode', label: '0x01FA - RF Continuous Carrier Wave Mode (u8)' },
  { fid: '0x0FA3', len: 4, name: 'watchdog_trace_code', label: '0x0FA3 - Watchdog Reset Diagnostic Code (u32)' },
  { fid: '0x028B', len: 2, name: 'va_valve_seat_torque_limit', label: '0x028B - Valve Seat Torque Limit (u16)' },
  { fid: '0x0294', len: 2, name: 'temp_comp_ambient_feed', label: '0x0294 - Ambient Temperature Compensation Feed (s16)' },
  { fid: '0x016D', len: 2, name: 'humidity_raw_adc_feed', label: '0x016D - Raw ADC Humidity Sensor Feed (u16)' },
  { fid: '0x0290', len: 1, name: 'accel_tamper_sensitivity', label: '0x0290 - Accelerometer Tamper Sensitivity (u8)' },
  { fid: '0x62E0', len: 2, name: 'sim_env_hook_00', label: '0x62E0 - Simulation Sensor Hook #0 (u16)' },
  { fid: '0x62E1', len: 2, name: 'sim_env_hook_01', label: '0x62E1 - Simulation Sensor Hook #1 (u16)' },
  { fid: '0x62EF', len: 2, name: 'sim_env_hook_0F', label: '0x62EF - Simulation Sensor Hook #15 (u16)' },
  { fid: '0x62FF', len: 2, name: 'sim_env_hook_1F', label: '0x62FF - Simulation Sensor Hook #31 (u16)' }
];

export const NVM_SLOTS = [
  { fid: '0x0001', len: 1, name: 'rf_channel', label: '0x0001 - RF Channel (11–26, 1B)' },
  { fid: '0x000A', len: 2, name: 'pan_id', label: '0x000A - 802.15.4 PAN ID (2B)' },
  { fid: '0x000B', len: 16, name: 'factory_link_key', label: '0x000B - AES-128 Network Key (16B Hex)' },
  { fid: '0x0009', len: 1, name: 'tx_power', label: '0x0009 - TX Power Level (dBm, 1B)' },
  { fid: '0x0005', len: 2, name: 'short_node_id', label: '0x0005 - 16-bit Short Node ID (2B)' },
  { fid: '0x0006', len: 8, name: 'mac_address', label: '0x0006 - 64-bit IEEE MAC Address (8B Hex)' },
  { fid: '0x0002', len: 1, name: 'calibration_lock', label: '0x0002 - NVM Calibration Validity Lock (1B)' },
  { fid: '0x0003', len: 2, name: 'hw_revision', label: '0x0003 - Hardware PCB Revision / Variant (2B)' },
  { fid: '0x0004', len: 10, name: 'serial_number', label: '0x0004 - Stored Device Serial (10B ASCII/Hex)' },
  { fid: '0x0007', len: 16, name: 'gateway_mesh_route', label: '0x0007 - Gateway / Bridge IPv6 Route (16B Hex)' },
  { fid: '0x0008', len: 1, name: 'install_state', label: '0x0008 - Commissioning / Paired State (1B)' },
  { fid: '0x000C', len: 1, name: 'factory_reset_nvm', label: '0x000C - Factory Reset / Erase NVM (1B)' }
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
    case '0X0006': { // MAC Address (8B / 64-bit)
      if (rawHex.length >= 12) {
        return rawHex.match(/.{1,2}/g).join(':').toUpperCase();
      }
      break;
    }
    case '0X0001': { // RF Channel / Variant (1B)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0x41 || num === 65) {
        return 'Channel 26 (868.325 MHz / Band A)';
      }
      if (num >= 11 && num <= 26) {
        return `Channel ${num}`;
      }
      if (!isNaN(num)) {
        return `Channel ${num} (0x${num.toString(16).toUpperCase().padStart(2, '0')})`;
      }
      break;
    }
    case '0X0007': { // Gateway IPv6 Route (16B)
      if (rawHex.length === 32) {
        return rawHex.match(/.{1,4}/g).join(':');
      }
      break;
    }
    case '0X0004': { // Serial Number (ASCII / Hex)
      if (rawHex.length >= 8) {
        const ascii = hexToAscii(rawHex);
        if (ascii.length >= 4) return ascii;
      }
      break;
    }
    case '0X0008': { // Pairing State (1B)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0) return '0 - Unpaired (Factory Default)';
      if (num === 1) return '1 - Paired & Commissioned';
      break;
    }
    case '0X0002': { // Calibration validity lock
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (num === 0) return '0 - Unlocked (Uncalibrated)';
      if (num === 1) return '1 - Calibrated & Write-Locked';
      break;
    }
    case '0X000A': // PAN ID (2B)
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
    case '0X0294': { // Temp compensation feed (s16)
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${(num / 100).toFixed(2)} °C`;
      break;
    }
    case '0X016D': { // Humidity raw ADC
      const num = val !== null && val !== undefined && val !== '' ? Number(val) : parseInt(rawHex, 16);
      if (!isNaN(num)) return `${num} ADC counts`;
      break;
    }
  }

  if (val !== undefined && val !== null && val !== '') return String(val);
  if (rawHex) return `0x${rawHex.toUpperCase()}`;
  return '';
}

export function parseFriendlyToRaw(fidStr, friendlyStr, lenBytes) {
  if (!friendlyStr) return '';
  const fidNorm = (String(fidStr || '').toUpperCase().startsWith('0X')
    ? String(fidStr || '').toUpperCase()
    : '0X' + String(fidStr || '').toUpperCase().padStart(4, '0'));
  const str = String(friendlyStr).trim();

  switch (fidNorm) {
    case '0X0006': { // MAC Address
      return str.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    }
    case '0X0001': { // RF Channel
      const m = str.match(/channel\s*(\d+)/i) || str.match(/^(\d+)$/);
      if (m) {
        const ch = parseInt(m[1], 10);
        if (ch === 26) return '41'; // 0x41 = 65 decimal
        return ch.toString(16).padStart(2, '0');
      }
      if (/^[0-9a-fA-F]{2}$/.test(str)) return str.toLowerCase();
      break;
    }
    case '0X0007': { // IPv6
      const clean = str.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      if (clean.length === 32) return clean;
      break;
    }
    case '0X0004': { // Serial
      if (/^[a-zA-Z0-9]+$/.test(str) && str.length <= 10) {
        return asciiToHex(str);
      }
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
  }

  return str;
}

/**
 * @brief Advanced device configuration tuning sub-panel.
 * @param {string|number} props.homeId - Active home ID.
 * @param {string} props.deviceId - Target device serial number.
 * @param {boolean} props.isValve - Whether target device is a radiator valve.
 * @param {object} props.device - Target hardware device details.
 * @param {number} props.lowSteps - Calibration low actuator steps offset.
 * @param {function} props.setLowSteps - Low step offset state setter.
 * @param {number} props.highSteps - Calibration high actuator steps offset.
 * @param {function} props.setHighSteps - High step offset state setter.
 * @param {number} props.driveConstant - Actuator motor drive current constant.
 * @param {function} props.setDriveConstant - Drive constant state setter.
 * @param {function} props.handleSaveActuatorLimits - Save calibration limits callback.
 * @param {boolean} props.isSavingLimits - Progress indicator for actuator limits updates.
 * @param {number} props.displayBrightness - Display brightness index (0-255).
 * @param {function} props.setDisplayBrightness - Display brightness state setter.
 * @param {number} props.displayContrast - Display contrast index (0-255).
 * @param {function} props.setDisplayContrast - Display contrast state setter.
 * @param {number} props.displayActiveTimeout - Active display screen saver timeout in seconds.
 * @param {function} props.setDisplayActiveTimeout - Active timeout state setter.
 * @param {function} props.handleSaveDisplay - Save display settings callback.
 * @param {boolean} props.isSavingDisplay - Progress indicator for display parameters updates.
 * @param {boolean} props.isReadOnly - Whether view is read-only.
 * @param {function} props.t - Translation resolver hook.
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

  // Hardware Bounds Validation
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
      } catch (e) {
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
      showToast('Dump cancelled');
    } catch (e) {
      showToast(e.message || 'Failed to cancel dump', 'error');
    }
  };
  // State for /d/dbg/st (Diagnostic & Control State)
  const [stFid, setStFid] = useState(DIAG_FIDS[0].fid);
  const [stLen, setStLen] = useState(String(DIAG_FIDS[0].len));
  const [stValue, setStValue] = useState('');
  const [stFriendly, setStFriendly] = useState('');
  const [stResult, setStResult] = useState(null);
  const [stLoading, setStLoading] = useState(false);

  // State for /d/dbg2/tlvs (NVM Persistent Storage)
  const [nvmFid, setNvmFid] = useState(NVM_SLOTS[0].fid);
  const [nvmLen, setNvmLen] = useState(String(NVM_SLOTS[0].len));
  const [nvmValue, setNvmValue] = useState('');
  const [nvmFriendly, setNvmFriendly] = useState('');
  const [nvmResult, setNvmResult] = useState(null);
  const [nvmLoading, setNvmLoading] = useState(false);

  // Active debug operation tracking ref to ensure SSE responses only land in target input fields
  const activeDebugRef = useRef({ tab: null, fid: null, mid: null, adr: null });

  // Real-time asynchronous push updates via SSE when device wakes up and sends response
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
        showToast(`Diagnostic FID ${targetFid} (${targetSerial}): ${friendlySt || raw} (0x${data.hex || raw})`, 'success');
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else if (active.tab === 'nvm') {
        const targetFid = active.fid || nvmFid;
        const friendlyNvm = formatFriendlyValue(targetFid, data.hex, data.val);
        setNvmValue(raw);
        setNvmFriendly(friendlyNvm);
        setNvmResult(data);
        setNvmLoading(false);
        showToast(`NVM ${targetFid} (${targetSerial}): ${friendlyNvm || raw} (0x${data.hex || raw})`, 'success');
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else if (active.tab === 'm') {
        const len = data.bytes?.length || (data.hex ? data.hex.length / 2 : 0);
        showToast(`Captured ${len}B memory from 0x${active.adr || dbgAdr} (${targetSerial})`, 'success');
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      }
    };

    window.addEventListener('device-debug-response', handleSseDebugResponse);
    return () => window.removeEventListener('device-debug-response', handleSseDebugResponse);
  }, [targetSerial, stFid, nvmFid, dbgAdr]);

  const handleReadSt = async () => {
    setStLoading(true);
    activeDebugRef.current = { tab: 'st', fid: stFid, mid: null, adr: null };
    try {
      const res = await triggerDeviceDebug(homeId, targetSerial, 'st', {
        method: 'GET',
        fid: stFid,
        len: stLen
      });
      setStResult(res);
      if (res?.mid) activeDebugRef.current.mid = res.mid;
      if (res?.hex || (res?.val !== undefined && res?.val !== null)) {
        const raw = res.hex || String(res.val);
        setStValue(raw);
        const friendly = formatFriendlyValue(stFid, res.hex, res.val);
        setStFriendly(friendly);
        showToast(`Read FID ${stFid}: ${friendly || raw} (0x${res.hex || raw})`, 'success');
        setStLoading(false);
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else {
        showToast(res?.message || 'Read request sent to device, awaiting response...', 'info');
        setTimeout(() => setStLoading(false), 1500);
      }
    } catch (e) {
      showToast(e.message || 'Failed to read diagnostic parameter', 'error');
      setStLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  const handleWriteSt = async () => {
    if (stValue === '') {
      showToast('Please enter a value to inject', 'warning');
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
      setTimeout(() => setStLoading(false), 1500);
    } catch (e) {
      showToast(e.message || 'Failed to inject diagnostic value', 'error');
      setStLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  const handleReadNvm = async () => {
    setNvmLoading(true);
    activeDebugRef.current = { tab: 'nvm', fid: nvmFid, mid: null, adr: null };
    try {
      const res = await triggerDeviceDebug(homeId, targetSerial, 'st', {
        method: 'GET',
        fid: nvmFid,
        len: nvmLen
      });
      setNvmResult(res);
      if (res?.mid) activeDebugRef.current.mid = res.mid;
      if (res?.hex || (res?.val !== undefined && res?.val !== null)) {
        const raw = res.hex || String(res.val);
        setNvmValue(raw);
        const friendly = formatFriendlyValue(nvmFid, res.hex, res.val);
        setNvmFriendly(friendly);
        showToast(`Read NVM ${nvmFid}: ${friendly || raw} (0x${res.hex || raw})`, 'success');
        setNvmLoading(false);
        activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
      } else {
        showToast(res?.message || 'Read request sent to device, awaiting response...', 'info');
        setTimeout(() => setNvmLoading(false), 1500);
      }
    } catch (e) {
      showToast(e.message || 'Failed to read NVM parameter', 'error');
      setNvmLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

  const handleWriteNvm = async () => {
    if (nvmValue === '') {
      showToast('Please enter a value to store in NVM', 'warning');
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
      showToast(`Stored ${nvmFriendly || nvmValue} (raw: ${nvmValue}) in NVM ${nvmFid}`, 'success');
      setTimeout(() => setNvmLoading(false), 1500);
    } catch (e) {
      showToast(e.message || 'Failed to store NVM value', 'error');
      setNvmLoading(false);
      activeDebugRef.current = { tab: null, fid: null, mid: null, adr: null };
    }
  };

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
              Controls the active LED matrix light intensity on the physical device screen.
              <br />
              • <em>Interpretation</em>: Value range 0 (off) to 255 (max brightness). Lower brightness (e.g. 80-112) is highly recommended to extend battery life. Setting it to 255 makes the screen very clear in bright rooms but drains batteries rapidly.
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
              Adjusts the voltage supply gradient for active LED segments.
              <br />
              • <em>Interpretation</em>: Value range 0 to 255. High values sharpen segment edges but can cause ghosting (retained glow after display clears). Setting it too low makes text faint. recommended baseline is 128.
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
                Specifies the active duration (in minutes) the display remains illuminated after a physical scroll or tap before turning off.
                <br />
                • <em>Interpretation</em>: 0 represents default behavior (turns off within 5-10 seconds). Setting to any non-zero value keeps the screen fully illuminated for that duration.
                <br />
                • <strong>Warning</strong>: Keeping the screen on for long intervals will deplete alkaline batteries in a matter of weeks.
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
            Configure custom calibration ranges for low/high steps and motor drive constants on the valve piston drive.
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
                    Linear Stepper Axis (0 → {maxTrack} steps)
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Outward Travel from Gearbox Home
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
                        Ref ({numRef})
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
                      Drive ({numDrive})
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
                        Seat ({numSeat})
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
                        Live: {numPos1}
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
                      High ({numHigh})
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
                      Low / Closed ({numLow})
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
                        Drive Constant (Nominal baseline)
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
                        High Steps (Open Modulation Limit)
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
                        Low Steps (Fully Closed Limit)
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
                  <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: 'var(--text-primary)' }}>Understanding the Stepper Coordinate System:</h4>
                  • Radiator pins are <strong>normally open</strong> (uncompressed = 100% flow). The motor travels outward (higher step numbers) to compress the pin inward.
                  <br />
                  • <strong>Seat Point</strong>: Piston makes contact with the pin. Valve is 100% Open. Idle positions rest here.
                  <br />
                  • <strong>High Steps → Low Steps</strong>: Active modulation range where the valve pin is compressed to regulate and shut off water flow.
                  <br />
                  • <strong>Low Steps</strong>: Maximum extension where the pin is pressed all the way in (Valve 100% Closed).
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
                      <span>• Low Steps (closed limit: {numLow}) cannot be lower than High Steps (open modulation limit: {numHigh}).</span>
                    )}
                    {(numHigh < numDrive || numLow < numDrive) && (
                      <span>• High/Low steps cannot be lower than Drive Constant baseline ({numDrive}).</span>
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
            <h4 style={{ fontSize: '0.85rem', fontWeight: 600, margin: 0 }}>Actuator Diagnostics & Telemetry</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Status</span>
                <span style={{ fontWeight: 600, color: device?.actuatorLimits?.active ? 'var(--success)' : 'var(--text-muted)' }}>
                  {device?.actuatorLimits?.active ? 'Active (Calibrated)' : 'Inactive (Uncalibrated)'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.02)', paddingBottom: '0.25rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Mounting State</span>
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
                <span style={{ color: 'var(--text-secondary)' }}>Deviation</span>
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
              <em>Interpretation of Diagnostics</em>: Mounting state reports structural coupling. Seat point details the physical contact depth. A high positive/negative deviation value (e.g. &gt; 100) indicates valve adaptation binding, stuck pins, or low battery motor slips.
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
                  showToast('Mount calibration sequence started.');
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
            Requests the physical device to perform internal self-diagnostics (sensor verification, battery load test, display check).
          </p>
          <div>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await triggerSelftest(homeId, targetSerial);
                  showToast('Hardware self-test request sent.');
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
              Read direct physical memory from device internal Flash, SRAM, or external SPI Flash over 6LoWPAN.
            </p>
          </div>
          {device?.deviceType && (
            <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '0.25rem', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
              Hardware: <strong>{device.deviceType}</strong> ({isValve ? 'nRF52832' : isStat ? 'STM32L0' : 'STM32F411'})
            </span>
          )}
        </div>

        {/* Memory Presets */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Memory Region Presets</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {isValve && (
              <Button
                variant="secondary"
                onClick={() => { setDbgAdr('00000000'); setDbgLen('64'); }}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                Internal Flash (0x00000000)
              </Button>
            )}
            {!isValve && (
              <Button
                variant="secondary"
                onClick={() => { setDbgAdr('08000000'); setDbgLen('64'); }}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                Internal Flash (0x08000000)
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => { setDbgAdr('20000000'); setDbgLen('64'); }}
              style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
            >
              SRAM Live (0x20000000)
            </Button>
            {(isValve || (!isValve && !isStat)) && (
              <Button
                variant="secondary"
                onClick={() => { setDbgAdr('80000000'); setDbgLen('64'); }}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                SPI Flash (0x80000000)
              </Button>
            )}
          </div>
        </div>

        {/* Memory Query Inputs */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '140px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Address (Hex)</label>
            <input
              type="text"
              value={dbgAdr}
              onChange={(e) => setDbgAdr(e.target.value.replace(/[^0-9a-fA-F]/g, ''))}
              placeholder={isValve ? "00000000" : "08000000"}
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: `1px solid ${isAdrValid ? 'var(--border-color)' : 'var(--danger)'}`, backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '100px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Length (1-64 B)</label>
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
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Dump Size</label>
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
            Read Single Block ({dbgLen}B)
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
                    Resume Dump ({serverDumpStatus.partBytes ? `${(serverDumpStatus.partBytes / 1024).toFixed(1)} KB done` : 'Continue'})
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!isAdrValid}
                    onClick={() => handleStartServerDump(true)}
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
                  >
                    Start Over (Discard .part)
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  disabled={!isAdrValid}
                  onClick={() => handleStartServerDump(false)}
                  style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
                >
                  Start Server Dump ({dumpRangeBytes >= 1048576 ? `${dumpRangeBytes / 1048576}MB` : dumpRangeBytes >= 1024 ? `${dumpRangeBytes / 1024}KB` : `${dumpRangeBytes}B`})
                </Button>
              )}
            </>
          ) : (
            <Button
              variant="danger"
              onClick={handleCancelServerDump}
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
            >
              Cancel Dump
            </Button>
          )}

          {serverDumpStatus?.hasFile && (
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  showToast('Downloading dump file...');
                  await downloadMemoryDumpFile(homeId, targetSerial, serverDumpStatus.fileName);
                  showToast('Download complete');
                } catch (e) {
                  showToast(e.message || 'Failed to download dump file', 'error');
                }
              }}
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
            >
              Download {serverDumpStatus.fileName} ({serverDumpStatus.bytesReceived} B)
            </Button>
          )}
        </div>

        {/* Server Dump Progress Bar */}
        {serverDumpStatus && (serverDumpStatus.isRunning || serverDumpStatus.status === 'completed' || serverDumpStatus.status === 'paused' || serverDumpStatus.error || serverDumpStatus.hasPart) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.35rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.25rem' }}>
              <span>
                <strong>Status:</strong> {serverDumpStatus.isRunning ? 'Dumping in background...' : serverDumpStatus.status === 'completed' ? 'Dump Completed!' : serverDumpStatus.status === 'paused' || serverDumpStatus.hasPart ? 'Paused / Resumable' : serverDumpStatus.status}
              </span>
              <span>
                {serverDumpStatus.bytesReceived ? serverDumpStatus.bytesReceived.toLocaleString() : (serverDumpStatus.partBytes || 0).toLocaleString()} {serverDumpStatus.totalBytes ? `/ ${serverDumpStatus.totalBytes.toLocaleString()} Bytes (${serverDumpStatus.percent}%)` : 'Bytes on disk (.part)'}
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
                Error: {serverDumpStatus.error}
              </span>
            )}
          </div>
        )}
      </Card>

      {/* Live Diagnostic & Control State Card (/d/dbg/st) */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Sliders size={18} style={{ color: 'var(--primary)' }} />
              Live Diagnostic & Control State (/d/dbg/st)
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0 0', lineHeight: '1.4' }}>
              Query live telemetry variables and inject real-time control overrides directly into device RAM over 6LoWPAN.
            </p>
          </div>
        </div>

        {/* Preset Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Diagnostic Parameter Preset</label>
          <select
            value={stFid}
            onChange={(e) => {
              const selected = DIAG_FIDS.find(item => item.fid === e.target.value);
              setStFid(e.target.value);
              if (selected) setStLen(String(selected.len));
              setStValue('');
              setStFriendly('');
              setStResult(null);
            }}
            style={{
              fontSize: '0.8rem',
              padding: '0.4rem 0.5rem',
              borderRadius: '0.25rem',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)'
            }}
          >
            {DIAG_FIDS.map(item => (
              <option key={item.fid} value={item.fid}>{item.label}</option>
            ))}
          </select>
        </div>

        {/* Inputs */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '100px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>FID (Hex/Dec)</label>
            <input
              type="text"
              value={stFid}
              onChange={(e) => setStFid(e.target.value)}
              placeholder="0x03ED"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '80px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Length (B)</label>
            <input
              type="number"
              min="1"
              max="4"
              value={stLen}
              onChange={(e) => setStLen(e.target.value)}
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1.5, minWidth: '160px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Human-Friendly Format</label>
            <input
              type="text"
              value={stFriendly}
              onChange={(e) => {
                const fVal = e.target.value;
                setStFriendly(fVal);
                setStValue(parseFriendlyToRaw(stFid, fVal, stLen));
              }}
              placeholder="e.g. 1850 steps or 21.5 °C"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1.5, minWidth: '160px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Value to Inject (Raw Dec/Hex)</label>
            <input
              type="text"
              value={stValue}
              onChange={(e) => {
                const rVal = e.target.value;
                setStValue(rVal);
                setStFriendly(formatFriendlyValue(stFid, rVal, isNaN(Number(rVal)) ? null : Number(rVal)));
              }}
              placeholder="e.g. 1850 or 073a"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button
            variant="secondary"
            disabled={stLoading}
            onClick={handleReadSt}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            {stLoading ? 'Reading...' : 'Read Parameter (GET)'}
          </Button>
          <Button
            variant="primary"
            disabled={stLoading || stValue === ''}
            onClick={handleWriteSt}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            {stLoading ? 'Injecting...' : 'Inject into RAM (PUT)'}
          </Button>
        </div>

        {/* Result Box */}
        {stResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', backgroundColor: 'var(--bg-secondary)', padding: '0.5rem 0.75rem', borderRadius: '0.35rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
            <div><strong>MID:</strong> {stResult.mid} {stResult.code ? `(CoAP ${stResult.code})` : ''}</div>
            {formatFriendlyValue(stFid, stResult.hex, stResult.val) && (
              <div><strong>Parsed:</strong> <span style={{ color: 'var(--primary)' }}>{formatFriendlyValue(stFid, stResult.hex, stResult.val)}</span></div>
            )}
            {stResult.val !== undefined && stResult.val !== null && (
              <div><strong>Value (Dec):</strong> <span style={{ color: 'var(--success)' }}>{stResult.val}</span></div>
            )}
            {stResult.hex && (
              <div><strong>Hex:</strong> <code>0x{stResult.hex}</code></div>
            )}
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>{stResult.message}</div>
          </div>
        )}
      </Card>

      {/* NVM Persistent Storage Card (/d/dbg2/tlvs) */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Database size={18} style={{ color: 'var(--primary)' }} />
              NVM Persistent Storage (/d/dbg2/tlvs)
            </h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0 0', lineHeight: '1.4' }}>
              Query and overwrite persistent device configuration parameters stored in internal Flash NVM.
            </p>
          </div>
        </div>

        {/* NVM Preset Selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>NVM Parameter Slot</label>
          <select
            value={nvmFid}
            onChange={(e) => {
              const selected = NVM_SLOTS.find(item => item.fid === e.target.value);
              setNvmFid(e.target.value);
              if (selected) setNvmLen(String(selected.len));
              setNvmValue('');
              setNvmFriendly('');
              setNvmResult(null);
            }}
            style={{
              fontSize: '0.8rem',
              padding: '0.4rem 0.5rem',
              borderRadius: '0.25rem',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)'
            }}
          >
            {NVM_SLOTS.map(item => (
              <option key={item.fid} value={item.fid}>{item.label}</option>
            ))}
          </select>
        </div>

        {/* Inputs */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '0.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: '100px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Slot / FID</label>
            <input
              type="text"
              value={nvmFid}
              onChange={(e) => setNvmFid(e.target.value)}
              placeholder="0x0001"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', width: '80px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Length (B)</label>
            <input
              type="number"
              min="1"
              max="16"
              value={nvmLen}
              onChange={(e) => setNvmLen(e.target.value)}
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1.5, minWidth: '160px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Human-Friendly Format</label>
            <input
              type="text"
              value={nvmFriendly}
              onChange={(e) => {
                const fVal = e.target.value;
                setNvmFriendly(fVal);
                setNvmValue(parseFriendlyToRaw(nvmFid, fVal, nvmLen));
              }}
              placeholder="e.g. Channel 26 or AA:BB:CC:DD:EE:FF:00:11"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1.5, minWidth: '160px' }}>
            <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Value to Store (Raw Hex/Dec)</label>
            <input
              type="text"
              value={nvmValue}
              onChange={(e) => {
                const rVal = e.target.value;
                setNvmValue(rVal);
                setNvmFriendly(formatFriendlyValue(nvmFid, rVal, isNaN(Number(rVal)) ? null : Number(rVal)));
              }}
              placeholder="e.g. 41 or aabbccddeeff0011"
              style={{ fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '0.25rem', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace' }}
            />
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button
            variant="secondary"
            disabled={nvmLoading}
            onClick={handleReadNvm}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            {nvmLoading ? 'Reading...' : 'Read Stored NVM Value'}
          </Button>
          <Button
            variant="primary"
            disabled={nvmLoading || nvmValue === ''}
            onClick={handleWriteNvm}
            style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem' }}
          >
            {nvmLoading ? 'Writing...' : 'Store to NVM (PUT)'}
          </Button>
        </div>

        {/* Result Box */}
        {nvmResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', backgroundColor: 'var(--bg-secondary)', padding: '0.5rem 0.75rem', borderRadius: '0.35rem', fontSize: '0.75rem', fontFamily: 'monospace' }}>
            <div><strong>MID:</strong> {nvmResult.mid} {nvmResult.code ? `(CoAP ${nvmResult.code})` : ''}</div>
            {formatFriendlyValue(nvmFid, nvmResult.hex, nvmResult.val) && (
              <div><strong>Parsed:</strong> <span style={{ color: 'var(--primary)' }}>{formatFriendlyValue(nvmFid, nvmResult.hex, nvmResult.val)}</span></div>
            )}
            {nvmResult.val !== undefined && nvmResult.val !== null && (
              <div><strong>Value (Dec):</strong> <span style={{ color: 'var(--success)' }}>{nvmResult.val}</span></div>
            )}
            {nvmResult.hex && (
              <div><strong>Hex:</strong> <code>0x{nvmResult.hex}</code></div>
            )}
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem' }}>{nvmResult.message}</div>
          </div>
        )}
      </Card>
    </div>
  );
}

