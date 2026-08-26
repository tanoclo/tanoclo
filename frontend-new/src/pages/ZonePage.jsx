/**
 * @file src/pages/ZonePage.jsx
 * @brief Renders the settings, dials, overlays, and charts for an individual Zone.
 * 
 * Exposes a Tabbed layout: "Control" (for temperature adjustments, manual overrides,
 * schedules, and window detection dismissals) and "Telemetry" (lazy loading CombinedTelemetryChart
 * and WeatherChart to display historical heat request distributions).
 */

import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import AppShell from '../components/layout/AppShell';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Spinner from '../components/common/Spinner';
import TemperatureDial from '../components/zone/TemperatureDial';
import OverlayControl from '../components/zone/OverlayControl';
const CombinedTelemetryChart = lazy(() => import('../components/charts/CombinedTelemetryChart'));
const WeatherChart = lazy(() => import('../components/charts/WeatherChart'));
import { useHome } from '../context/HomeContext';
import { setZoneOverlay, resumeZoneSchedule, dismissOpenWindow } from '../api/zones';
import { apiFetch } from '../api/client';
import { SWR_KEYS } from '../utils/swrKeys';
import { AlertTriangle, ArrowLeft, Thermometer, Calendar } from 'lucide-react';
import { TEMP_MIN_HEATING, TEMP_MAX_HEATING, TEMP_MIN_DHW, TEMP_MAX_DHW, TEMP_STEP } from '../utils/constants';
import logger from '../utils/logger';

/**
 * @brief Renders the settings panel for a target Zone (Heating or DHW).
 */
export default function ZonePage() {
  const { id } = useParams();
  const zoneId = Number(id);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  
  const { activeHomeId, zones, zoneStates, mutateZoneStates } = useHome();
  
  const activeTab = searchParams.get('tab') === 'telemetry' ? 'telemetry' : 'control';
  
  // Get date in YYYY-MM-DD format (local timezone)
  const getTodayStr = () => new Date().toLocaleDateString('sv'); // 'sv' locale outputs YYYY-MM-DD
  const [date, setDate] = useState(getTodayStr());
  
  const zone = zones?.find(z => z.id === zoneId);
  const state = zoneStates?.zoneStates?.[zoneId];
  
  const [targetTemp, setTargetTemp] = useState(20.0);
  const lastServerTempRef = useRef(null);

  // Set initial temperature target
  useEffect(() => {
    const isDhw = zone?.type === 'HOT_WATER' || zone?.type === 'DHW';
    let serverTemp = null;
    if (state?.setting?.temperature?.celsius != null) {
      serverTemp = state.setting.temperature.celsius;
    } else if (state?.setting?.power === 'OFF') {
      serverTemp = isDhw ? TEMP_MIN_DHW : TEMP_MIN_HEATING;
    }

    if (serverTemp !== null) {
      if (lastServerTempRef.current === null || lastServerTempRef.current !== serverTemp) {
        setTargetTemp(serverTemp);
        lastServerTempRef.current = serverTemp;
      }
    }
  }, [state, zone]);

  // Fetch Day Report via SWR
  const { 
    data: dayReport, 
    error: dayReportError, 
    isLoading: isDayReportLoading 
  } = useSWR(
    activeHomeId && (zoneId !== null && zoneId !== undefined) && activeTab === 'telemetry' && date
      ? SWR_KEYS.standardDayReport(activeHomeId, zoneId, date)
      : null,
    () => apiFetch(`/api/v2/homes/${activeHomeId}/zones/${zoneId}/dayReport?date=${date}`),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  if (!zone || !state) {
    return (
      <AppShell title={t('common.loading')}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Spinner size={32} />
        </div>
      </AppShell>
    );
  }

  const isDhw = zone.type === 'HOT_WATER' || zone.type === 'DHW';
  const isOffline = state.link?.state === 'OFFLINE';
  const openWindowDetected = state.openWindowDetected || state.openWindow?.detected || false;

  const handleApplyOverlay = async (overlayPayload) => {
    try {
      if (isDhw) {
        overlayPayload.setting.power = targetTemp < 30.0 ? 'OFF' : 'ON';
        if (targetTemp >= 30.0) {
          overlayPayload.setting.temperature = { celsius: targetTemp };
        } else {
          delete overlayPayload.setting.temperature;
        }
      } else {
        overlayPayload.setting.power = targetTemp <= 5.0 ? 'OFF' : 'ON';
        if (targetTemp > 5.0) {
          overlayPayload.setting.temperature = { celsius: targetTemp };
        } else {
          delete overlayPayload.setting.temperature;
        }
      }
      await setZoneOverlay(activeHomeId, zoneId, overlayPayload);
      mutateZoneStates();
    } catch (err) {
      logger.error('Failed to apply overlay:', err);
    }
  };

  const handleResumeSchedule = async () => {
    try {
      await resumeZoneSchedule(activeHomeId, zoneId);
      mutateZoneStates();
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

  return (
    <AppShell title={zone.name}>
      <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        {/* Navigation Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <Button 
            variant="secondary" 
            onClick={() => navigate('/')} 
            aria-label={t('common.back')}
            style={{ padding: '0.5rem', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ArrowLeft size={18} />
          </Button>
          <div>
            <span style={{ 
              fontSize: '0.875rem', 
              color: isOffline ? 'var(--danger)' : 'var(--success)', 
              fontWeight: 600 
            }}>
              {isOffline ? t('common.disconnected') : t('common.connected')}
            </span>
          </div>
        </div>

        {/* Tab Selector */}
        <div style={{
          display: 'flex',
          backgroundColor: 'var(--bg-input)',
          padding: '4px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-color)',
          alignSelf: 'flex-start',
          width: '100%',
          maxWidth: '320px'
        }}>
          <button
            onClick={() => navigate('?tab=control')}
            style={{
              flex: 1,
              padding: '0.5rem 1rem',
              borderRadius: 'calc(var(--radius-md) - 4px)',
              border: 'none',
              backgroundColor: activeTab === 'control' ? 'var(--bg-card-hover)' : 'transparent',
              color: activeTab === 'control' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)'
            }}
          >
            {t('common.control')}
          </button>
          <button
            onClick={() => navigate('?tab=telemetry')}
            style={{
              flex: 1,
              padding: '0.5rem 1rem',
              borderRadius: 'calc(var(--radius-md) - 4px)',
              border: 'none',
              backgroundColor: activeTab === 'telemetry' ? 'var(--bg-card-hover)' : 'transparent',
              color: activeTab === 'telemetry' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)'
            }}
          >
            {t('common.telemetry')}
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'control' ? (
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: '1fr', 
            gap: '1.5rem',
            maxWidth: '600px',
            width: '100%',
            alignSelf: 'center' 
          }}>
            
            {/* Open Window Warning */}
            {openWindowDetected && (
              <div style={{
                backgroundColor: 'var(--danger-glow)',
                border: '1px solid var(--danger)',
                borderRadius: 'var(--radius-md)',
                padding: '1rem',
                display: 'flex',
                gap: '0.75rem',
                fontSize: '0.875rem',
                lineHeight: 1.4,
                color: 'hsl(0, 75%, 85%)'
              }}>
                <AlertTriangle size={20} style={{ flexShrink: 0, color: 'var(--danger)' }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
                  <div>
                    <strong>{t('zone_detail.open_window_detected')}</strong>
                    <p style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {t('zone_detail.open_window_desc')}
                    </p>
                  </div>
                  <button 
                    onClick={handleDismissOpenWindow}
                    style={{
                      backgroundColor: 'transparent',
                      border: '1px solid var(--danger)',
                      color: 'var(--text-primary)',
                      padding: '0.25rem 0.75rem',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      alignSelf: 'flex-end',
                      cursor: 'pointer'
                    }}
                  >
                    {t('zone_detail.dismiss')}
                  </button>
                </div>
              </div>
            )}

            {/* Readings Summary Card */}
            <Card style={{ 
              display: 'flex', 
              justifyContent: 'space-around', 
              padding: '1.5rem' 
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                  {t('zone.current_temp')}
                </span>
                <span style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--primary)' }}>
                  {state.sensorDataPoints?.insideTemperature?.celsius != null 
                    ? `${state.sensorDataPoints.insideTemperature.celsius.toFixed(1)}°C`
                    : '--'
                  }
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                  {t('common.humidity')}
                </span>
                <span style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--secondary)' }}>
                  {state.sensorDataPoints?.humidity?.percentage != null 
                    ? `${state.sensorDataPoints.humidity.percentage.toFixed(0)}%`
                    : '--'
                  }
                </span>
              </div>
            </Card>

            {/* Dial Settings Card */}
            {!isOffline && (
              <Card style={{ padding: '2rem', display: 'flex', justifyContent: 'center' }}>
                <TemperatureDial 
                  value={targetTemp} 
                  onChange={setTargetTemp} 
                  disabled={isOffline}
                  min={isDhw ? TEMP_MIN_DHW : TEMP_MIN_HEATING}
                  max={isDhw ? TEMP_MAX_DHW : TEMP_MAX_HEATING}
                  step={isDhw ? 1.0 : TEMP_STEP}
                />
              </Card>
            )}

            {/* Override Controls Card */}
            <Card style={{ padding: '1.5rem' }}>
              <OverlayControl 
                zone={zone}
                state={state}
                onApply={handleApplyOverlay}
                onResume={handleResumeSchedule}
              />
            </Card>

          </div>
        ) : (
          /* Telemetry View */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            
            {/* Date Selector Banner */}
            <Card style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between',
              gap: '1rem',
              padding: '1rem 1.25rem',
              flexWrap: 'wrap'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Calendar size={18} style={{ color: 'var(--primary)' }} />
                <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{t('zone.select_diagnostic_date')}</span>
              </div>
              <input 
                type="date"
                value={date}
                max={getTodayStr()}
                onChange={(e) => setDate(e.target.value)}
                style={{
                  backgroundColor: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.4rem 0.75rem',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  cursor: 'pointer',
                  fontWeight: 600
                }}
              />
            </Card>

            {/* Charts Loading or Data */}
            {isDayReportLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Spinner size={32} />
              </div>
            ) : dayReportError ? (
              <Card style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--danger)' }}>
                <AlertTriangle size={32} style={{ margin: '0 auto 0.75rem' }} />
                <p style={{ fontWeight: 600 }}>{t('zone.failed_load_telemetry')}</p>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  {dayReportError.message || t('zone.check_date_prior')}
                </p>
              </Card>
            ) : (
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr', 
                gap: '1.5rem',
                width: '100%',
                maxWidth: '1000px',
                alignSelf: 'center'
              }}>
                
                {/* Combined Telemetry Chart */}
                <Card style={{ padding: '1.25rem' }}>
                  <h4 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Thermometer size={16} color="var(--primary)" />
                    {t('zone.system_telemetry_profiles')}
                  </h4>
                  <Suspense fallback={<div style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t('common.loading')}</div>}>
                    <CombinedTelemetryChart dayReportData={dayReport} />
                  </Suspense>
                </Card>

                {/* Weather Chart */}
                <Card style={{ padding: '1.25rem' }}>
                  <h4 style={{ margin: '0 0 1rem', fontSize: '0.95rem', fontWeight: 700 }}>
                    {t('zone.outside_solar_temp')}
                  </h4>
                  <Suspense fallback={<div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t('common.loading')}</div>}>
                    <WeatherChart dayReportData={dayReport} />
                  </Suspense>
                </Card>

              </div>
            )}

          </div>
        )}

      </div>
    </AppShell>
  );
}
