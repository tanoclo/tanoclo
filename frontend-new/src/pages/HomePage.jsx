/**
 * @file src/pages/HomePage.jsx
 * @brief Primary user dashboard/control page.
 * 
 * Renders all active heating and domestic hot water (DHW) zones in a grid layout.
 * Provides controls for presence locks (HOME/AWAY/AUTO), weather telemetry display,
 * bulk overlay controls (Resume Schedules, Boost All, Turn Off All), and triggers
 * the room ordering panel.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import useSWR from 'swr';
import AppShell from '../components/layout/AppShell';
import ZoneCard from '../components/zone/ZoneCard';
import ClimateQualityCard from '../components/zone/ClimateQualityCard';
import ZoneDetail from '../components/zone/ZoneDetail';
import ReorderRooms from '../components/zone/ReorderRooms';
import Button from '../components/common/Button';
import Spinner from '../components/common/Spinner';
import Card from '../components/common/Card';
import { useHome } from '../context/HomeContext';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { SWR_KEYS } from '../utils/swrKeys';
import { setHomeOverlay, resumeHomeSchedule } from '../api/zones';
import { setHomePresenceLock, releaseHomePresenceLock, getHomeUsers } from '../api/homes';
import { getMobileDevices } from '../api/users';
import { getClimateQuality } from '../api/weather';
import { getDeviceBatteryData } from '../api/tanoclo';
import { getAutoPresenceState } from '../utils/presence';
import { Sun, CloudRain, Flame, RotateCcw, ArrowUpDown, Cloud, AlertTriangle, ChevronDown } from 'lucide-react';
import { formatTemperature } from '../utils/temperature';
import logger from '../utils/logger';

/**
 * @brief Main Dashboard page displaying zones, temperature dials, and global switches.
 */
export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { 
    activeHomeId,
    zones, 
    zoneStates, 
    weather, 
    isLoading, 
    refreshAll,
    homeInfo,
    homeState
  } = useHome();
  const { user } = useAuth();

  const isAdmin = homeInfo && user ? (homeInfo.isCurrentUserAdmin || String(user.id) === String(homeInfo.adminUserId)) : false;

  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [isReorderOpen, setIsReorderOpen] = useState(false);
  const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [isQuickActionsOpen, setIsQuickActionsOpen] = useState(false);

  // Fetch climate quality diagnostics
  const { data: climateQuality } = useSWR(
    activeHomeId ? SWR_KEYS.climateQuality(activeHomeId) : null,
    () => getClimateQuality(activeHomeId),
    { revalidateOnFocus: false }
  );

  // Fetch device battery data
  const { data: batteryDevices } = useSWR(
    activeHomeId ? SWR_KEYS.batteryDevicesRaw(activeHomeId) : null,
    () => getDeviceBatteryData(activeHomeId),
    { refreshInterval: 30000 }
  );

  // Fetch home users for geofencing presence auto calculation
  const { data: homeUsers } = useSWR(
    activeHomeId ? SWR_KEYS.users(activeHomeId) : null,
    () => getHomeUsers(activeHomeId),
    { revalidateOnFocus: false }
  );

  // Fetch mobile devices for geofencing presence auto calculation
  const { data: mobileDevices } = useSWR(
    activeHomeId ? SWR_KEYS.mobileDevices(activeHomeId) : null,
    () => getMobileDevices(activeHomeId),
    { refreshInterval: 30000 }
  );

  const autoPresenceState = getAutoPresenceState(homeUsers, mobileDevices);

  // Fallback timeout for SWR stuck spinner
  React.useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => {
        setLoadingTimedOut(true);
      }, 5000);
      return () => clearTimeout(timer);
    } else {
      setLoadingTimedOut(prev => prev ? false : prev);
    }
  }, [isLoading]);

  // Map weather state to icon
  const getWeatherIcon = (stateStr) => {
    switch (stateStr?.toUpperCase()) {
      case 'SUNNY':
      case 'CLEAR':
        return <Sun size={20} style={{ color: '#ffb300' }} />;
      case 'RAINY':
      case 'RAIN':
        return <CloudRain size={20} style={{ color: '#0288d1' }} />;
      case 'CLOUDY':
      default:
        return <Cloud size={20} style={{ color: '#b0bec5' }} />;
    }
  };

  const zoneList = zones || [];
  const statesObj = zoneStates?.zoneStates || {};

  // Find if any zone is ON (HEATING / HOT_WATER and power !== 'OFF')
  const hasOnZone = zoneList.some(z => {
    const s = statesObj[z.id];
    return s && s.setting?.power !== 'OFF';
  });

  // Find if all zones are OFF
  const allZonesOff = zoneList.length > 0 && zoneList.every(z => {
    const s = statesObj[z.id];
    return s && s.setting?.power === 'OFF';
  });

  // Find if any zone has an active overlay (not running schedule)
  const hasOverlayZone = zoneList.some(z => {
    const s = statesObj[z.id];
    return s && !!s.overlay;
  });

  const handleBoostAll = async () => {
    setIsBulkActionLoading(true);
    try {
      const overlayList = zoneList.map(z => {
        const isDhw = z.type === 'HOT_WATER' || z.type === 'DHW';
        return {
          room: z.id,
          overlay: {
            setting: isDhw 
              ? { type: 'HOT_WATER', power: 'ON' } 
              : { type: 'HEATING', power: 'ON', temperature: { celsius: 25.0 } },
            termination: {
              type: 'MANUAL'
            }
          }
        };
      });
      await setHomeOverlay(activeHomeId, { overlays: overlayList });
      await refreshAll();
    } catch (err) {
      logger.error('Failed to boost all rooms:', err);
    } finally {
      setIsBulkActionLoading(false);
    }
  };

  const handleTurnOffAll = async () => {
    setIsBulkActionLoading(true);
    try {
      const overlayList = zoneList.map(z => {
        const type = z.type === 'HOT_WATER' || z.type === 'DHW' ? 'HOT_WATER' : 'HEATING';
        return {
          room: z.id,
          overlay: {
            setting: {
              type,
              power: 'OFF'
            },
            termination: {
              type: 'MANUAL'
            }
          }
        };
      });
      await setHomeOverlay(activeHomeId, { overlays: overlayList });
      await refreshAll();
    } catch (err) {
      logger.error('Failed to turn off all zones:', err);
    } finally {
      setIsBulkActionLoading(false);
    }
  };

  const handleTurnOnAll = async () => {
    setIsBulkActionLoading(true);
    try {
      const overlayList = zoneList.map(z => {
        const isDhw = z.type === 'HOT_WATER' || z.type === 'DHW';
        return {
          room: z.id,
          overlay: {
            setting: isDhw 
              ? { type: 'HOT_WATER', power: 'ON' } 
              : { type: 'HEATING', power: 'ON', temperature: { celsius: 21.0 } },
            termination: {
              type: 'MANUAL'
            }
          }
        };
      });
      await setHomeOverlay(activeHomeId, { overlays: overlayList });
      await refreshAll();
    } catch (err) {
      logger.error('Failed to turn on all zones:', err);
    } finally {
      setIsBulkActionLoading(false);
    }
  };

  const handleResumeAll = async () => {
    setIsBulkActionLoading(true);
    try {
      await resumeHomeSchedule(activeHomeId);
      await refreshAll();
    } catch (err) {
      logger.error('Failed to resume all schedules:', err);
    } finally {
      setIsBulkActionLoading(false);
    }
  };

  const currentPresenceMode = homeState?.presenceLocked 
    ? homeState?.presence 
    : 'AUTO';

  const handlePresenceModeChange = async (mode) => {
    try {
      if (mode === 'AUTO') {
        await releaseHomePresenceLock(activeHomeId);
      } else {
        await setHomePresenceLock(activeHomeId, mode);
      }
      await refreshAll();
    } catch (err) {
      logger.error('Failed to change presence mode:', err);
    }
  };

  // The zones list fetched from the API is already sorted by the backend's zone_order_json configuration.
  const orderedZones = zones || [];

  return (
    <AppShell title={homeInfo?.name || t('dashboard.title')}>
      <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        
        {/* Small consolidated control bar: presence + weather + quick actions */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          backgroundColor: 'var(--bg-card)',
          padding: '0.75rem 1.25rem',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-color)',
          boxShadow: 'var(--glass-shadow)'
        }}>
          {/* Presence Selector Section */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('dashboard.presence.mode')}
              </span>
              <div style={{ display: 'flex', gap: '8px', marginTop: '2px', padding: '4px' }}>
                {['HOME', 'AWAY', 'AUTO'].map(mode => {
                  const isActive = currentPresenceMode === mode;
                  
                  // Decide base color dynamically
                  let baseColor;
                  if (mode === 'HOME') {
                    baseColor = 'var(--success)';
                  } else if (mode === 'AWAY') {
                    baseColor = 'var(--danger)';
                  } else {
                    baseColor = autoPresenceState === 'HOME' ? 'var(--success)' : 'var(--danger)';
                  }

                  const isSuccess = baseColor === 'var(--success)';
                  const shadowColor = isSuccess ? 'rgba(76, 175, 80, 0.5)' : 'rgba(244, 67, 54, 0.5)';

                  return (
                    <button
                      key={mode}
                      onClick={() => handlePresenceModeChange(mode)}
                      style={{
                        padding: '0.45rem 1.1rem',
                        fontSize: '0.8rem',
                        fontWeight: 800,
                        borderRadius: '20px',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                        
                        // Solid green/red backgrounds always
                        backgroundColor: baseColor,
                        color: '#ffffff',
                        border: isActive ? '3px solid var(--text-primary)' : '3px solid transparent',
                        transform: isActive ? 'scale(1.05)' : 'scale(0.96)',
                        boxShadow: isActive ? `0 0 12px ${shadowColor}` : 'none',
                        opacity: isActive ? 1.0 : 0.55
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.opacity = '0.8';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.opacity = '0.55';
                        }
                      }}
                    >
                      {mode === 'HOME' ? t('dashboard.presence.home') : mode === 'AWAY' ? t('dashboard.presence.away') : t('dashboard.presence.auto')}
                    </button>
                  );
                })}
              </div>
            </div>

          </div>

          {/* Weather Info Section */}
          {weather && (
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.6rem', 
              padding: '0.35rem 0.85rem', 
              borderRadius: '20px',
              backgroundColor: 'var(--bg-app)',
              border: '1px solid var(--border-color)',
              margin: 0
            }}>
              {getWeatherIcon(weather.weatherState?.value)}
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                {t(`weather.states.${weather.weatherState?.value}`, { defaultValue: weather.weatherState?.value })}
              </span>
              <div style={{ width: '1px', height: '12px', backgroundColor: 'var(--border-color)' }} />
              <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                {formatTemperature(weather.outsideTemperature?.celsius)}
              </span>
            </div>
          )}

          {/* Home Actions Dropdown */}
          <div style={{ position: 'relative', zIndex: 100 }}>
            <Button 
              variant="secondary" 
              onClick={() => setIsQuickActionsOpen(prev => !prev)}
              disabled={isLoading || isBulkActionLoading}
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', height: '32px', display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <span>{t('dashboard.zones.quick_actions') || 'Home Actions'}</span>
              <ChevronDown size={14} />
            </Button>
            
            {isQuickActionsOpen && (
              <>
                <div 
                  onClick={() => setIsQuickActionsOpen(false)}
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 998
                  }}
                />
                <div style={{
                  position: 'absolute',
                  right: 0,
                  top: '38px',
                  backgroundColor: 'var(--bg-card-solid)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35)',
                  padding: '0.5rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  minWidth: '160px',
                  zIndex: 999
                }}>
                  <button
                    onClick={() => {
                      handleBoostAll();
                      setIsQuickActionsOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      border: 'none',
                      backgroundColor: 'transparent',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <Flame size={14} style={{ color: 'var(--primary)' }} />
                    <span>{t('dashboard.zones.boost')}</span>
                  </button>

                  {hasOnZone && (
                    <button
                      onClick={() => {
                        handleTurnOffAll();
                        setIsQuickActionsOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'var(--danger)',
                        border: 'none',
                        backgroundColor: 'transparent',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <RotateCcw size={14} style={{ transform: 'rotate(-45deg)' }} />
                      <span>{t('dashboard.zones.turn_off_all')}</span>
                    </button>
                  )}

                  {allZonesOff && (
                    <button
                      onClick={() => {
                        handleTurnOnAll();
                        setIsQuickActionsOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        border: 'none',
                        backgroundColor: 'transparent',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <Sun size={14} />
                      <span>{t('dashboard.zones.turn_on_all')}</span>
                    </button>
                  )}

                  {hasOverlayZone && (
                    <button
                      onClick={() => {
                        handleResumeAll();
                        setIsQuickActionsOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                        border: 'none',
                        backgroundColor: 'transparent',
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                        textAlign: 'left'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-card-hover)'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <RotateCcw size={14} />
                      <span>{t('dashboard.zones.resume_all')}</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Loading Spinner */}
        {isLoading && !loadingTimedOut && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
            <Spinner size={32} />
          </div>
        )}

        {/* Zone Cards Grid */}
        {(!isLoading || loadingTimedOut) && orderedZones.length > 0 && (
          <>
            {/* Persistent low/depleted battery warnings */}
            {(() => {
              const lowBatteryDevices = (batteryDevices || []).filter(d => 
                d.battery_state === 'LOW' || d.battery_state === 'CRITICAL' || d.battery_state === 'DEPLETED'
              );
              if (lowBatteryDevices.length === 0) return null;
              return (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  maxHeight: '150px',
                  overflowY: 'auto',
                  marginBottom: '1rem',
                  paddingRight: '4px'
                }}>
                  {lowBatteryDevices.map(d => {
                    const isDepleted = d.battery_state === 'DEPLETED' || d.battery_state === 'CRITICAL';
                    const label = d.friendly_name || d.serial_no;
                    return (
                      <div
                        key={d.serial_no}
                        onClick={() => navigate(`/settings?section=devices&deviceId=${d.serial_no}`)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.75rem',
                          backgroundColor: isDepleted ? 'var(--danger-glow)' : 'var(--warning-glow)',
                          border: `1px solid ${isDepleted ? 'var(--danger)' : 'var(--warning)'}`,
                          borderRadius: 'var(--radius-md)',
                          padding: '0.6rem 1rem',
                          cursor: 'pointer',
                          transition: 'transform var(--transition-fast)',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.005)'}
                        onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                      >
                        <AlertTriangle size={16} style={{ color: isDepleted ? 'var(--danger)' : 'var(--warning)', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {isDepleted 
                            ? t('settings.battery_depleted_warning', { name: label }) 
                            : t('settings.battery_low_warning', { name: label })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: '1.25rem'
            }}>
              {orderedZones.map(zone => (
                <ZoneCard 
                  key={zone.id} 
                  zone={zone}
                  state={zoneStates?.zoneStates?.[zone.id]}
                  onClick={() => setSelectedZoneId(zone.id)}
                />
              ))}
              
              {/* Climate Quality Card */}
              {activeHomeId && (
                <ClimateQualityCard 
                  climateQuality={climateQuality}
                  onClick={() => navigate('/climate-quality')}
                />
              )}
            </div>
            
            {/* Reorder rooms button placed last */}
            {isAdmin && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem', paddingBottom: '1rem' }}>
                <Button 
                  variant="secondary" 
                  onClick={() => setIsReorderOpen(true)}
                  disabled={isLoading}
                  style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
                >
                  <ArrowUpDown size={14} />
                  <span>{t('dashboard.zones.reorder')}</span>
                </Button>
              </div>
            )}
          </>
        )}

        {/* Empty State */}
        {(!isLoading || loadingTimedOut) && orderedZones.length === 0 && (
          <Card style={{ padding: '3rem', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)' }}>{t('dashboard.zones.no_zones_home')}</p>
            {loadingTimedOut && (
              <Button 
                variant="secondary" 
                onClick={refreshAll} 
                style={{ marginTop: '1rem' }}
              >
                {t('common.refresh')}
              </Button>
            )}
          </Card>
        )}

        {/* Zone Details Modal */}
        {selectedZoneId !== null && (
          <ZoneDetail 
            zoneId={selectedZoneId}
            isOpen={selectedZoneId !== null}
            onClose={() => setSelectedZoneId(null)}
          />
        )}

        {/* Room Reordering Modal */}
        {isAdmin && (
          <ReorderRooms 
            isOpen={isReorderOpen}
            onClose={() => setIsReorderOpen(false)}
          />
        )}

      </div>
    </AppShell>
  );
}
