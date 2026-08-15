/**
 * @file src/components/zone/ZoneDetail.jsx
 * @brief Renders the detailed slide-out details dialog overlay sheet for a single Zone.
 * 
 * Embeds components (ZoneDetailHeader, ZoneDetailSensors, ZoneDetailSchedule, ZoneDetailControls),
 * handles live countdown overlays for temporary timed overrides, renders high-performance lazy-loaded
 * historical charts (CombinedTelemetryChart) using portals, and dispatches API overlay updates.
 */

import { SWR_KEYS } from '../../utils/swrKeys';
import { useState, useEffect, useRef, useContext, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { AlertTriangle, Flame } from 'lucide-react';
import { useHome } from '../../context/HomeContext';
import { useAuth } from '../../hooks/useAuth';
import { setZoneOverlay, resumeZoneSchedule, dismissOpenWindow, getDefaultOverlay } from '../../api/zones';
import { apiFetch } from '../../api/client';
const CombinedTelemetryChart = lazy(() => import('../charts/CombinedTelemetryChart'));
import { ThemeContext } from '../../context/ThemeContext';
import logger from '../../utils/logger';
import TemperatureDial from './TemperatureDial';
import { TEMP_MIN_HEATING, TEMP_MIN_DHW, TEMP_MAX_DEFAULT, TEMP_STEP } from '../../utils/constants';

import ZoneDetailHeader from './ZoneDetailHeader';
import ZoneDetailSensors from './ZoneDetailSensors';
import ZoneDetailSchedule from './ZoneDetailSchedule';
import ZoneDetailControls from './ZoneDetailControls';

const formatAbsoluteTime = (timestamp) => {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_e) {
    return '';
  }
};

const getTimerEndTime = (expiryTimestamp) => {
  if (!expiryTimestamp) return '';
  try {
    const date = new Date(expiryTimestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_e) {
    return '';
  }
};

/**
 * @brief Unified zone details sidebar dialog sheet overlay component.
 * @param {number} props.zoneId - Active target zone identifier.
 * @param {boolean} props.isOpen - Whether slide-out overlay sheet is visible.
 * @param {function} props.onClose - Modal dismiss action callback hook.
 */
export default function ZoneDetail({ zoneId, isOpen, onClose }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { resolvedTheme: theme } = useContext(ThemeContext);
  const { activeHomeId, zones, zoneStates, mutateZoneStates, homeInfo } = useHome();
  const { user } = useAuth();

  const isAdmin = homeInfo && user ? (homeInfo.isCurrentUserAdmin || String(user.id) === String(homeInfo.adminUserId)) : false;
  
  const zone = zones?.find(z => z.id === zoneId);
  const state = zoneStates?.zoneStates?.[zoneId];
  const isDhw = zone?.type === 'HOT_WATER' || zone?.type === 'DHW';

  const leaderDevice = zone?.devices?.find(d => d.duties?.includes('ZONE_LEADER') || d.duties?.includes('CIRCUIT_DRIVER'));
  const leaderName = leaderDevice ? `${leaderDevice.deviceType} (${leaderDevice.serialNo})` : 'None';

  const [targetTemp, setTargetTemp] = useState(20.0);
  const [termType, setTermType] = useState('TADO_MODE'); // TADO_MODE, TIMER, MANUAL
  const [durationInMinutes, setDurationInMinutes] = useState(60);
  const [_isPickerOpen, _setIsPickerOpen] = useState(false);
  const [_pickerStepIndex, _setPickerStepIndex] = useState(0);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState(0);

  const [showTelemetry, setShowTelemetry] = useState(false);
  const [telemetryDate, setTelemetryDate] = useState(new Date().toLocaleDateString('sv'));

  const latestTempRef = useRef(20.0);
  const saveTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleDialChange = (newVal) => {
    setTargetTemp(newVal);
    latestTempRef.current = newVal;
    setIsPreviewMode(true);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      await handleSave(newVal);
    }, 400);
  };

  const getSteps = () => {
    const possibleDurations = [5, 15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480, 540, 600, 720];
    let nextChangeMins = 0;
    if (state?.nextScheduleChange?.start) {
      const diffMs = new Date(state.nextScheduleChange.start).getTime() - Date.now();
      nextChangeMins = Math.max(1, Math.round(diffMs / 60000));
    }

    const shorterTimers = possibleDurations.filter(m => m < nextChangeMins);
    const longerTimers = possibleDurations.filter(m => m > nextChangeMins);

    const stepsList = [];
    shorterTimers.forEach(m => {
      stepsList.push({ type: 'TIMER', minutes: m, label: m < 60 ? `${m}m` : `${Math.floor(m/60)}h${m%60 > 0 ? ` ${m%60}m` : ''}` });
    });
    if (nextChangeMins > 0) {
      stepsList.push({ 
        type: 'TADO_MODE', 
        minutes: nextChangeMins, 
        label: t('zone_detail.next_change'),
        isNextSchedule: true
      });
    }
    longerTimers.forEach(m => {
      stepsList.push({ type: 'TIMER', minutes: m, label: m < 60 ? `${m}m` : `${Math.floor(m/60)}h${m%60 > 0 ? ` ${m%60}m` : ''}` });
    });
    stepsList.push({ 
      type: 'MANUAL', 
      label: t('zone_detail.infinite') 
    });
    return stepsList;
  };

  const _findActiveStepIndex = (stepsList, type, currentMins) => {
    if (type === 'TADO_MODE') {
      return stepsList.findIndex(s => s.type === 'TADO_MODE');
    }
    if (type === 'MANUAL') {
      return stepsList.findIndex(s => s.type === 'MANUAL');
    }
    if (type === 'TIMER') {
      let closestIdx = -1;
      let minDiff = Infinity;
      for (let idx = 0; idx < stepsList.length; idx++) {
        const s = stepsList[idx];
        if (s.type === 'TIMER') {
          const diff = Math.abs(s.minutes - currentMins);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = idx;
          }
        }
      }
      return closestIdx;
    }
    return 0;
  };

  const _handleSliderRelease = async (newIdx) => {
    const stepsList = getSteps();
    const selectedStep = stepsList[newIdx];
    
    const payload = {
      setting: {
        type: isDhw ? 'HOT_WATER' : 'HEATING',
        power: isDhw ? (targetTemp < 30.0 ? 'OFF' : 'ON') : (targetTemp <= 5.0 ? 'OFF' : 'ON')
      },
      termination: {
        type: selectedStep.type
      }
    };
    
    if (selectedStep.type === 'TIMER') {
      payload.termination.durationInSeconds = selectedStep.minutes * 60;
    }
    
    if (isDhw) {
      if (targetTemp >= 30.0) {
        payload.setting.temperature = { celsius: targetTemp };
      }
    } else {
      if (targetTemp > 5.0) {
        payload.setting.temperature = { celsius: targetTemp };
      }
    }

    try {
      await setZoneOverlay(activeHomeId, zoneId, payload);
      mutateZoneStates();
      setTermType(selectedStep.type);
      if (selectedStep.type === 'TIMER') {
        setDurationInMinutes(selectedStep.minutes);
        setCountdownSeconds(selectedStep.minutes * 60);
      } else if (selectedStep.type === 'TADO_MODE') {
        const diffMs = new Date(state.nextScheduleChange?.start || Date.now()).getTime() - Date.now();
        setCountdownSeconds(Math.max(0, Math.floor(diffMs / 1000)));
      } else {
        setCountdownSeconds(0);
      }
    } catch (err) {
      logger.error('Failed to set overlay via modify slider:', err);
    }
  };

  // Fetch telemetry via custom TaNoClo endpoint if showTelemetry is active
  const { data: telemetryData, error: telemetryError } = useSWR(
    showTelemetry && activeHomeId && (zoneId !== null && zoneId !== undefined) && telemetryDate
      ? SWR_KEYS.dayReport(activeHomeId, zoneId, telemetryDate)
      : null,
    () => apiFetch(SWR_KEYS.dayReport(activeHomeId, zoneId, telemetryDate))
  );

  useEffect(() => {
    setShowTelemetry(prev => prev ? false : prev);
  }, [zoneId, isOpen]);

  // Sync state data on load
  useEffect(() => {
    const isDhw = zone?.type === 'HOT_WATER' || zone?.type === 'DHW';
    let initialTemp = isDhw ? 50.0 : 20.0;
    if (state?.setting?.temperature?.celsius != null) {
      initialTemp = state.setting.temperature.celsius;
    } else if (state?.setting?.power === 'OFF') {
      initialTemp = isDhw ? TEMP_MIN_DHW : TEMP_MIN_HEATING; // OFF threshold
    }
    setTargetTemp(prev => prev !== initialTemp ? initialTemp : prev);
    latestTempRef.current = initialTemp;

    const hasNextSchedule = !!state?.nextScheduleChange?.start;

    if (state?.overlay) {
      let overlayTermType = state.overlay.termination?.type || 'TADO_MODE';
      if (overlayTermType === 'TADO_MODE' && !hasNextSchedule) {
        overlayTermType = 'MANUAL';
      }
      setTermType(prev => prev !== overlayTermType ? overlayTermType : prev);
      if (overlayTermType === 'TIMER') {
        const secs = state.overlay.termination.remainingTimeInSeconds || 3600;
        setDurationInMinutes(prev => prev !== Math.round(secs / 60) ? Math.round(secs / 60) : prev);
        setCountdownSeconds(prev => prev !== secs ? secs : prev);
      } else if (overlayTermType === 'TADO_MODE') {
        const diffMs = new Date(state.nextScheduleChange?.start || Date.now()).getTime() - Date.now();
        setCountdownSeconds(prev => prev !== Math.max(0, Math.floor(diffMs / 1000)) ? Math.max(0, Math.floor(diffMs / 1000)) : prev);
      } else {
        setCountdownSeconds(prev => prev !== 0 ? 0 : prev);
      }
    } else {
      setCountdownSeconds(prev => prev !== 0 ? 0 : prev);
      if (isOpen && activeHomeId && (zoneId !== null && zoneId !== undefined)) {
        getDefaultOverlay(activeHomeId, zoneId)
          .then(data => {
            const term = data?.terminationCondition || data?.termination;
            if (term) {
              let type = term.type || 'TADO_MODE';
              if (type === 'TADO_MODE' && !hasNextSchedule) {
                type = 'MANUAL';
              }
              setTermType(prev => prev !== type ? type : prev);
              if (type === 'TIMER') {
                const mins = Math.round((term.durationInSeconds || 3600) / 60);
                setDurationInMinutes(prev => prev !== mins ? mins : prev);
                setCountdownSeconds(prev => prev !== (term.durationInSeconds || 3600) ? (term.durationInSeconds || 3600) : prev);
              } else if (type === 'TADO_MODE') {
                const diffMs = new Date(state.nextScheduleChange?.start || Date.now()).getTime() - Date.now();
                setCountdownSeconds(prev => prev !== Math.max(0, Math.floor(diffMs / 1000)) ? Math.max(0, Math.floor(diffMs / 1000)) : prev);
              }
            } else {
              setTermType(prev => prev !== (hasNextSchedule ? 'TADO_MODE' : 'MANUAL') ? (hasNextSchedule ? 'TADO_MODE' : 'MANUAL') : prev);
            }
          })
          .catch(err => {
            logger.error('Failed to load default overlay:', err);
            setTermType(prev => prev !== (hasNextSchedule ? 'TADO_MODE' : 'MANUAL') ? (hasNextSchedule ? 'TADO_MODE' : 'MANUAL') : prev);
          });
      } else {
        setTermType(prev => prev !== (hasNextSchedule ? 'TADO_MODE' : 'MANUAL') ? (hasNextSchedule ? 'TADO_MODE' : 'MANUAL') : prev);
      }
    }
    setIsPreviewMode(prev => prev ? false : prev);
  }, [state, isOpen, zoneId, activeHomeId, zone?.type]);

  // Countdown timer effect
  useEffect(() => {
    if (countdownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCountdownSeconds(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdownSeconds]);

  // Prevent background scrolling when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen || !zone || !state) return null;

  const isOffline = state.link?.state === 'OFFLINE';
  const isOverlay = !!state.overlay;
  const openWindowDetected = state.openWindowDetected || state.openWindow?.detected || false;

  const getHeatingGradient = (temp) => {
    if (temp == null) {
      return 'linear-gradient(to bottom, #718096, #4a5568)';
    }
    const t = Math.max(5, Math.min(25, temp));
    const stops = [
      { t: 5, h: 210, s: 80, l: 45 },    // Blueish
      { t: 15, h: 145, s: 70, l: 40 },   // Greenish-teal
      { t: 18, h: 100, s: 70, l: 40 },   // Green
      { t: 19, h: 50, s: 95, l: 45 },    // Yellow
      { t: 21, h: 35, s: 95, l: 45 },    // Yellow-orange
      { t: 25, h: 15, s: 100, l: 40 }    // Dark Orange
    ];
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].t && t <= stops[i+1].t) {
        lower = stops[i];
        upper = stops[i+1];
        break;
      }
    }
    const range = upper.t - lower.t;
    const pct = range === 0 ? 0 : (t - lower.t) / range;
    const h = Math.round(lower.h + (upper.h - lower.h) * pct);
    const s = Math.round(lower.s + (upper.s - lower.s) * pct);
    const l = Math.round(lower.l + (upper.l - lower.l) * pct);
    const col1 = `hsl(${h}, ${s}%, ${l}%)`;
    const col2 = `hsl(${h}, ${s}%, ${Math.max(15, l - 10)}%)`;
    return `linear-gradient(to bottom, ${col1}, ${col2})`;
  };

  const getDhwGradient = (temp) => {
    if (temp == null) {
      return 'linear-gradient(to bottom, #00a0e4, #007bb6)';
    }
    const t = Math.max(30, Math.min(65, temp));
    const stops = [
      { t: 30, h: 200, s: 80, l: 45 },    // Blueish
      { t: 40, h: 145, s: 70, l: 40 },    // Teal
      { t: 48, h: 60, s: 85, l: 42 },     // Yellow
      { t: 55, h: 30, s: 95, l: 45 },     // Orange
      { t: 65, h: 5, s: 100, l: 40 }      // Red
    ];
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].t && t <= stops[i+1].t) {
        lower = stops[i];
        upper = stops[i+1];
        break;
      }
    }
    const range = upper.t - lower.t;
    const pct = range === 0 ? 0 : (t - lower.t) / range;
    const h = Math.round(lower.h + (upper.h - lower.h) * pct);
    const s = Math.round(lower.s + (upper.s - lower.s) * pct);
    const l = Math.round(lower.l + (upper.l - lower.l) * pct);
    const col1 = `hsl(${h}, ${s}%, ${l}%)`;
    const col2 = `hsl(${h}, ${s}%, ${Math.max(15, l - 10)}%)`;
    return `linear-gradient(to bottom, ${col1}, ${col2})`;
  };

  const getBackgroundColor = () => {
    if (isOffline) return 'linear-gradient(to bottom, #4b5563, #374151)';
    const isOff = targetTemp <= (isDhw ? TEMP_MIN_DHW : TEMP_MIN_HEATING);
    if (isOff) return 'linear-gradient(to bottom, #4b5563, #374151)';

    if (isDhw) {
      return getDhwGradient(targetTemp);
    } else {
      return getHeatingGradient(targetTemp);
    }
  };

  // Convert timer selection to readable ending time
  const _getEndTimeStr = (mins) => {
    const end = new Date(Date.now() + mins * 60000);
    return end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const handleSave = async (tempToSave = targetTemp) => {
    const payload = {
      setting: {
        type: isDhw ? 'HOT_WATER' : 'HEATING',
        power: isDhw ? (tempToSave < 30.0 ? 'OFF' : 'ON') : (tempToSave <= 5.0 ? 'OFF' : 'ON')
      },
      termination: {
        type: termType
      }
    };
    
    if (termType === 'TIMER') {
      payload.termination.durationInSeconds = durationInMinutes * 60;
      setCountdownSeconds(durationInMinutes * 60);
    } else if (termType === 'TADO_MODE') {
      const diffMs = new Date(state.nextScheduleChange?.start || Date.now()).getTime() - Date.now();
      setCountdownSeconds(Math.max(0, Math.floor(diffMs / 1000)));
    } else {
      setCountdownSeconds(0);
    }
    
    if (isDhw) {
      if (tempToSave >= 30.0) {
        payload.setting.temperature = { celsius: tempToSave };
      }
    } else {
      if (tempToSave > 5.0) {
        payload.setting.temperature = { celsius: tempToSave };
      }
    }

    try {
      await setZoneOverlay(activeHomeId, zoneId, payload);
      await mutateZoneStates();
      setIsPreviewMode(false);
    } catch (err) {
      logger.error('Failed to set overlay:', err);
      setIsPreviewMode(false);
    }
  };

  const handleResumeSchedule = async () => {
    try {
      await resumeZoneSchedule(activeHomeId, zoneId);
      mutateZoneStates();
      setIsPreviewMode(false);
    } catch (err) {
      logger.error('Failed to resume schedule:', err);
    }
  };

  const handleDismissOpenWindow = async () => {
    try {
      await dismissOpenWindow(activeHomeId, zoneId);
      mutateZoneStates();
    } catch (err) {
      logger.error('Failed to dismiss open window:', err);
    }
  };

  // Format countdown seconds
  const formatCountdown = (secs) => {
    if (secs <= 0) return '';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    return `${m}m ${s}s`;
  };

  const minTemp = isDhw ? TEMP_MIN_DHW : TEMP_MIN_HEATING;
  const maxTemp = isDhw ? 65.0 : TEMP_MAX_DEFAULT;
  const displayTemp = isDhw && targetTemp < TEMP_MIN_DHW ? TEMP_MIN_DHW : targetTemp;
  const _fillHeight = Math.max(0, Math.min(100, ((displayTemp - minTemp) / (maxTemp - minTemp)) * 100));
  const isHeatingOn = state?.activityDataPoints?.heatingPower?.percentage > 0;

  return createPortal(
    <div 
      className="animate-fade-in modal-overlay-backdrop"
      onClick={onClose}
    >
      <div 
        className="animate-scale-in modal-container-card"
        style={{
          background: getBackgroundColor(),
          transition: 'background 0.25s ease'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <ZoneDetailHeader zoneName={zone.name} onClose={onClose} />

        {/* Scrollable Modal Content */}
        <div className="modal-content-scrollable">
          {/* Open Window Banner */}
          {openWindowDetected && (
            <div style={{
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              border: '1px solid #ef4444',
              borderRadius: '16px',
              padding: '0.75rem 1rem',
              width: '100%',
              display: 'flex',
              gap: '0.75rem',
              fontSize: '0.85rem',
              marginBottom: '1rem'
            }}>
              <AlertTriangle size={18} style={{ flexShrink: 0, color: '#ef4444' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', width: '100%' }}>
                <strong>{t('zone_detail.open_window_detected')}</strong>
                <button 
                  onClick={handleDismissOpenWindow}
                  style={{
                    backgroundColor: '#ffffff',
                    border: 'none',
                    color: '#ef4444',
                    padding: '3px 8px',
                    borderRadius: '8px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    alignSelf: 'flex-start',
                    marginTop: '2px'
                  }}
                >
                  {t('zone_detail.dismiss')}
                </button>
              </div>
            </div>
          )}

          {/* Telemetry Display (Sensors) */}
          <ZoneDetailSensors isDhw={isDhw} sensorData={state.sensorDataPoints} leaderName={leaderName} t={t} />

          {/* Telemetry Chart or Vertical Capsule Slider Switcher */}
          {showTelemetry ? (
            <div style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.75rem',
              backgroundColor: theme === 'light' ? '#ffffff' : '#1f2937',
              borderRadius: '16px',
              padding: '1rem',
              border: `1px solid ${theme === 'light' ? '#e5e7eb' : '#374151'}`
            }}>
              {/* Date selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.5rem', width: '100%', justifyContent: 'center' }}>
                <button 
                  type="button"
                  onClick={() => {
                    const d = new Date(telemetryDate);
                    d.setDate(d.getDate() - 1);
                    setTelemetryDate(d.toLocaleDateString('sv'));
                  }}
                  style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: theme === 'light' ? '#374151' : '#fff', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  &lt;
                </button>
                <input 
                  type="date" 
                  value={telemetryDate} 
                  onChange={(e) => setTelemetryDate(e.target.value)}
                  style={{
                    backgroundColor: theme === 'light' ? '#f3f4f6' : 'rgba(255,255,255,0.15)',
                    border: `1px solid ${theme === 'light' ? '#d1d5db' : 'rgba(255,255,255,0.3)'}`,
                    color: theme === 'light' ? '#1f2937' : '#fff',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    outline: 'none',
                    cursor: 'pointer',
                    fontWeight: 600,
                    fontSize: '0.85rem'
                  }}
                />
                <button 
                  type="button"
                  onClick={() => {
                    const d = new Date(telemetryDate);
                    d.setDate(d.getDate() + 1);
                    setTelemetryDate(d.toLocaleDateString('sv'));
                  }}
                  style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: theme === 'light' ? '#374151' : '#fff', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  &gt;
                </button>
              </div>

              {telemetryError && (
                <div style={{ color: '#ef4444', fontSize: '0.85rem', padding: '1rem', textAlign: 'center' }}>
                  {t('zone.failed_load_telemetry')}
                </div>
              )}

              {!telemetryData && !telemetryError ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <span style={{ fontSize: '0.85rem', color: theme === 'light' ? '#6b7280' : 'rgba(255, 255, 255, 0.7)' }}>{t('zone_detail.loading_chart')}</span>
                </div>
              ) : (
                <Suspense fallback={
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                    <span style={{ fontSize: '0.85rem', color: theme === 'light' ? '#6b7280' : 'rgba(255, 255, 255, 0.7)' }}>{t('zone_detail.loading_chart')}</span>
                  </div>
                }>
                  <CombinedTelemetryChart dayReportData={telemetryData} />
                </Suspense>
              )}
            </div>
          ) : (
            /* Temperature Dial */
            !isOffline && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', marginBottom: '1.25rem' }}>
                <TemperatureDial 
                  value={targetTemp} 
                  onChange={handleDialChange}
                  disabled={isOffline}
                  min={isDhw ? TEMP_MIN_DHW : TEMP_MIN_HEATING}
                  max={isDhw ? 65.0 : TEMP_MAX_DEFAULT}
                  step={isDhw ? 1.0 : TEMP_STEP}
                  currentTemp={state?.sensorDataPoints?.insideTemperature?.celsius}
                />
                {isHeatingOn && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ff5d00', marginTop: '0.5rem', fontWeight: 600, fontSize: '0.9rem' }}>
                    <Flame size={16} style={{ fill: 'currentColor', animation: 'pulse-soft 1.5s infinite' }} />
                    <span>{t('zone_detail.heating_active') || 'Heating active'}</span>
                  </div>
                )}
              </div>
            )
          )}

          {/* Actions Link Bar (Schedule / Charts Trigger) */}
          <ZoneDetailSchedule 
            isAdmin={isAdmin}
            zone={zone}
            showTelemetry={showTelemetry}
            toggleTelemetry={() => setShowTelemetry(prev => !prev)}
            onClose={onClose}
            navigate={navigate}
            t={t}
          />

          {/* Active Overlay Info / Mode selectors */}
          <ZoneDetailControls 
            isOverlay={isOverlay}
            isPreviewMode={isPreviewMode}
            termType={termType}
            durationInMinutes={durationInMinutes}
            countdownSeconds={countdownSeconds}
            state={state}
            t={t}
            handleResumeSchedule={handleResumeSchedule}
            onTermTypeChange={async (newType) => {
              setTermType(newType);
              const payload = {
                setting: {
                  type: isDhw ? 'HOT_WATER' : 'HEATING',
                  power: isDhw ? (targetTemp < 30.0 ? 'OFF' : 'ON') : (targetTemp <= 5.0 ? 'OFF' : 'ON')
                },
                termination: {
                  type: newType
                }
              };
              if (newType === 'TIMER') {
                payload.termination.durationInSeconds = durationInMinutes * 60;
              }
              if (isDhw) {
                if (targetTemp >= 30.0) payload.setting.temperature = { celsius: targetTemp };
              } else {
                if (targetTemp > 5.0) payload.setting.temperature = { celsius: targetTemp };
              }
              try {
                await setZoneOverlay(activeHomeId, zoneId, payload);
                mutateZoneStates();
              } catch (err) {
                logger.error('Failed to change term type:', err);
              }
            }}
            onDurationChange={async (newMins) => {
              setDurationInMinutes(newMins);
              const payload = {
                setting: {
                  type: isDhw ? 'HOT_WATER' : 'HEATING',
                  power: isDhw ? (targetTemp < 30.0 ? 'OFF' : 'ON') : (targetTemp <= 5.0 ? 'OFF' : 'ON')
                },
                termination: {
                  type: 'TIMER',
                  durationInSeconds: newMins * 60
                }
              };
              if (isDhw) {
                if (targetTemp >= 30.0) payload.setting.temperature = { celsius: targetTemp };
              } else {
                if (targetTemp > 5.0) payload.setting.temperature = { celsius: targetTemp };
              }
              try {
                await setZoneOverlay(activeHomeId, zoneId, payload);
                mutateZoneStates();
              } catch (err) {
                logger.error('Failed to change timer duration:', err);
              }
            }}
            formatAbsoluteTime={formatAbsoluteTime}
            getTimerEndTime={getTimerEndTime}
            formatCountdown={formatCountdown}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
