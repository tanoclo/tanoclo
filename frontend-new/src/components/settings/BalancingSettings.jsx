/**
 * @file src/components/settings/BalancingSettings.jsx
 * @brief Renders the Advisory Hydraulic Balancing settings panel.
 * 
 * Analyzes radiator temperature rise rates across heating sessions and offers
 * recommendations for valve sensitivity (FID 0x4160) to hydraulically balance the heating system.
 */

import React, { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import Slider from '../common/Slider';
import { SWR_KEYS } from '../../utils/swrKeys';
import {
  getBalancingAnalysis,
  applyBalancingSuggestions,
  getBalancingHistory
} from '../../api/balancing';
import { updateValveSensitivity } from '../../api/devices';
import {
  Sliders,
  Flame,
  Activity,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  History,
  TrendingUp,
  Gauge,
  HelpCircle,
  MapPin,
  BatteryLow
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../context/ToastContext';
import logger from '../../utils/logger';

/**
 * @brief Advisory Hydraulic Balancing settings component.
 * @param {number|string} props.homeId - Active home identifier.
 * @param {Array} props.devices - List of registered devices in home.
 * @param {boolean} props.isReadOnly - Whether configuration editing is locked.
 */
export default function BalancingSettings({ homeId, devices = [], zones = [], isReadOnly = false }) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [hours, setHours] = useState(72);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [errorPayload, setErrorPayload] = useState(null);
  const [manualSensitivities, setManualSensitivities] = useState({});
  const [savingDevices, setSavingDevices] = useState({});

  const { data: historyData, mutate: mutateHistory } = useSWR(
    homeId ? SWR_KEYS.balancingHistory(homeId) : null,
    () => getBalancingHistory(homeId)
  );

  // Initialize manual sensitivities from registered VA devices
  useEffect(() => {
    if (Array.isArray(devices)) {
      const initial = {};
      devices
        .filter(d => d.deviceType && d.deviceType.startsWith('VA'))
        .forEach(d => {
          initial[d.serialNo] = d.valveSensitivity !== undefined && d.valveSensitivity !== null
            ? d.valveSensitivity
            : 100;
        });
      setManualSensitivities(prev => ({ ...initial, ...prev }));
    }
  }, [devices]);

  const handleRunAnalysis = async () => {
    if (!homeId) return;
    setIsAnalyzing(true);
    setErrorPayload(null);
    try {
      const res = await getBalancingAnalysis(homeId, hours);
      setAnalysisResult(res);
      mutateHistory();
      showToast(t('balancing.analysis_complete', { defaultValue: 'Analysis completed successfully' }), 'success');
    } catch (err) {
      logger.error('Failed to run balancing analysis', err);
      if (err.data && err.data.error === 'insufficient_data') {
        setErrorPayload(err.data);
      } else {
        showToast(err.message || t('balancing.analysis_failed', { defaultValue: 'Failed to run analysis' }), 'error');
      }
      setAnalysisResult(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleApplyAll = async () => {
    if (!homeId || !analysisResult || !analysisResult.zones) return;
    setIsApplying(true);
    try {
      const devicesToApply = [];
      analysisResult.zones.forEach(zone => {
        (zone.devices || []).forEach(d => {
          devicesToApply.push({
            serial: d.serial,
            sensitivity: d.suggestedSensitivity
          });
        });
      });

      if (devicesToApply.length === 0) {
        showToast(t('balancing.no_devices_to_apply', { defaultValue: 'No devices to apply' }), 'warning');
        return;
      }

      await applyBalancingSuggestions(homeId, devicesToApply, analysisResult.snapshotId);
      showToast(t('balancing.applied_success', { defaultValue: 'Valve sensitivities updated successfully!' }), 'success');

      // Update manual sliders state locally
      setManualSensitivities(prev => {
        const next = { ...prev };
        devicesToApply.forEach(d => {
          next[d.serial] = d.sensitivity;
        });
        return next;
      });

      mutateHistory();
    } catch (err) {
      logger.error('Failed to apply suggestions', err);
      showToast(err.message || t('balancing.applied_error', { defaultValue: 'Failed to apply valve sensitivities' }), 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const handleResetDefaults = async () => {
    if (!homeId || !analysisResult || !analysisResult.zones) return;
    setIsApplying(true);
    try {
      const devicesToApply = [];
      analysisResult.zones.forEach(zone => {
        (zone.devices || []).forEach(d => {
          devicesToApply.push({
            serial: d.serial,
            sensitivity: 100
          });
        });
      });

      await applyBalancingSuggestions(homeId, devicesToApply, analysisResult.snapshotId);
      showToast(t('balancing.reset_success', { defaultValue: 'All valves reset to 100%' }), 'success');

      setManualSensitivities(prev => {
        const next = { ...prev };
        devicesToApply.forEach(d => {
          next[d.serial] = 100;
        });
        return next;
      });

      mutateHistory();
    } catch (err) {
      logger.error('Failed to reset defaults', err);
      showToast(err.message || t('balancing.applied_error', { defaultValue: 'Failed to reset sensitivities' }), 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const handleSingleDeviceChange = async (serial, value) => {
    if (!homeId || isReadOnly) return;
    setManualSensitivities(prev => ({ ...prev, [serial]: value }));
    setSavingDevices(prev => ({ ...prev, [serial]: true }));
    try {
      await updateValveSensitivity(homeId, serial, value);
      showToast(`${serial}: ${value}%`, 'success');
    } catch (err) {
      logger.error(`Failed to update sensitivity for ${serial}`, err);
      showToast(err.message || t('balancing.failed_update_single', { defaultValue: 'Failed to update sensitivity' }), 'error');
    } finally {
      setSavingDevices(prev => ({ ...prev, [serial]: false }));
    }
  };

  const vaDevices = useMemo(() => {
    return (devices || []).filter(d => d.deviceType && d.deviceType.startsWith('VA'));
  }, [devices]);

  const zoneGroups = useMemo(() => {
    const groups = [];
    const assignedSerials = new Set();

    (zones || []).forEach(zone => {
      const zoneDevs = vaDevices.filter(dev => {
        const isDirectMatch = (dev.zoneId != null && String(zone.id) === String(dev.zoneId)) ||
          (dev.zone_id != null && String(zone.id) === String(dev.zone_id));
        const isDeviceInZoneList = Array.isArray(zone.devices) && zone.devices.some(d => (d.serialNo || d.serial) === dev.serialNo);
        return isDirectMatch || isDeviceInZoneList;
      });

      if (zoneDevs.length > 0) {
        zoneDevs.forEach(d => assignedSerials.add(d.serialNo));
        const sorted = [...zoneDevs].sort((a, b) => (a.friendlyName || a.serialNo).localeCompare(b.friendlyName || b.serialNo));
        groups.push({
          zoneId: zone.id,
          zoneName: zone.name,
          devices: sorted
        });
      }
    });

    const unassignedDevs = vaDevices.filter(dev => !assignedSerials.has(dev.serialNo));
    if (unassignedDevs.length > 0) {
      const sorted = [...unassignedDevs].sort((a, b) => (a.friendlyName || a.serialNo).localeCompare(b.friendlyName || b.serialNo));
      groups.push({
        zoneId: 'unassigned',
        zoneName: t('settings.unassigned', { defaultValue: 'Unassigned' }),
        devices: sorted
      });
    }

    return groups;
  }, [vaDevices, zones, t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      {/* Header Card */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <div style={{
            padding: '0.5rem',
            borderRadius: '10px',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            color: 'var(--primary-dark, #2563eb)',
            display: 'flex'
          }}>
            <Sliders size={22} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
              {t('balancing.title', { defaultValue: 'Hydraulic Balancing' })}
            </h2>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {t('balancing.description', {
                defaultValue: 'Analyzes temperature rise rates during heating runs to calculate optimal radiator valve sensitivity values, preventing hot spots and underheated rooms.'
              })}
            </p>
          </div>
        </div>

        {/* Control toolbar */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          paddingTop: '1rem',
          borderTop: '1px solid var(--border-color)',
          marginTop: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('balancing.analysis_period', { defaultValue: 'Period:' })}
            </span>
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              disabled={isAnalyzing}
              style={{
                padding: '0.45rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-input, rgba(0,0,0,0.05))',
                color: 'var(--text-primary)',
                fontSize: '0.85rem',
                cursor: 'pointer'
              }}
            >
              <option value={24}>{t('balancing.period_24h', { defaultValue: '24 hours' })}</option>
              <option value={48}>{t('balancing.period_48h', { defaultValue: '48 hours' })}</option>
              <option value={72}>{t('balancing.period_72h', { defaultValue: '72 hours (Recommended)' })}</option>
              <option value={168}>{t('balancing.period_7d', { defaultValue: '7 days' })}</option>
              <option value={336}>{t('balancing.period_14d', { defaultValue: '14 days' })}</option>
            </select>
          </div>

          <Button
            variant="primary"
            onClick={handleRunAnalysis}
            disabled={isAnalyzing || isReadOnly}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            {isAnalyzing ? (
              <>
                <Spinner size="sm" />
                <span>{t('balancing.analyzing', { defaultValue: 'Analyzing...' })}</span>
              </>
            ) : (
              <>
                <Activity size={16} />
                <span>{t('balancing.run_analysis', { defaultValue: 'Run Analysis' })}</span>
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* Refusal / Insufficient Data Notification */}
      {errorPayload && (
        <Card style={{ borderLeft: '4px solid #f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.05)' }}>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <AlertTriangle size={22} style={{ color: '#f59e0b', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('balancing.insufficient_data', { defaultValue: 'Insufficient Heating Data' })}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {t('balancing.insufficient_data_desc', {
                  defaultValue: 'Reliable hydraulic balancing requires at least 12 hours of measurement data and 5 qualifying heating sessions.'
                })}
              </div>
              <div style={{
                display: 'flex',
                gap: '1.25rem',
                marginTop: '0.5rem',
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                backgroundColor: 'rgba(0,0,0,0.04)',
                fontSize: '0.8rem'
              }}>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>{t('balancing.data_span_label', { defaultValue: 'Data span:' })} </span>
                  <strong>{errorPayload.dataSpanHours || 0}h</strong> / 12h
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>{t('balancing.heating_runs_label', { defaultValue: 'Heating runs:' })} </span>
                  <strong>{errorPayload.heatingRunsTotal || 0}</strong> / 5
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Analysis Results View */}
      {analysisResult && analysisResult.zones && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
                {t('balancing.recommendations', { defaultValue: 'Balancing Recommendations' })}
              </h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                {t('balancing.analyzed_runs', {
                  runs: analysisResult.heatingRunsTotal,
                  hours: analysisResult.dataSpanHours,
                  defaultValue: `Based on ${analysisResult.heatingRunsTotal} heating sessions over ${analysisResult.dataSpanHours}h`
                })}
              </div>
            </div>

            {/* Metrics Pills */}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <div style={{
                padding: '0.3rem 0.6rem',
                borderRadius: '6px',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                color: 'var(--primary-dark, #2563eb)',
                fontSize: '0.75rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem'
              }}>
                <Gauge size={13} />
                <span>{t('balancing.median_prefix', { defaultValue: 'Median:' })} +{(analysisResult.houseMedianRiseRate || 0).toFixed(3)}°C/min</span>
              </div>

              {analysisResult.avgCircuitDeltaT !== null && (
                <div style={{
                  padding: '0.3rem 0.6rem',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(16, 185, 129, 0.1)',
                  color: '#10b981',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.3rem'
                }}>
                  <Flame size={13} />
                  <span>ΔT: {analysisResult.avgCircuitDeltaT}°C</span>
                </div>
              )}
            </div>
          </div>

          {/* Zones & Devices Table */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {analysisResult.zones.map(zone => (
              <div
                key={zone.zoneId}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}
              >
                {/* Zone Header */}
                <div style={{
                  padding: '0.6rem 0.85rem',
                  backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.03))',
                  borderBottom: '1px solid var(--border-color)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {zone.zoneName}
                  </span>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: '0.75rem' }}>
                    <span>{t('balancing.avg_rise', { defaultValue: 'Avg rise:' })} +{(zone.avgRiseRate || 0).toFixed(3)}°C/min</span>
                    {zone.avgHeatingPower > 0 && <span>{t('balancing.power', { defaultValue: 'Power:' })} {zone.avgHeatingPower}%</span>}
                  </div>
                </div>

                {/* Devices List */}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {(zone.devices || []).map(device => {
                    const isBoost = device.changeDirection === 'INCREASE_OPENING';
                    const isReduce = device.changeDirection === 'DECREASE_OPENING';
                    const diffPct = Math.abs(device.suggestedSensitivity - device.currentSensitivity);
                    const localizedReasoning = isBoost
                      ? t('balancing.reasoning_boost', {
                          rate: (device.avgRiseRate || 0).toFixed(3),
                          median: (analysisResult.houseMedianRiseRate || 0).toFixed(3),
                          diff: diffPct,
                          defaultValue: `Rise rate (+${(device.avgRiseRate || 0).toFixed(3)}°C/min) is below house median (+${(analysisResult.houseMedianRiseRate || 0).toFixed(3)}°C/min). Boost valve flow by ${diffPct}%.`
                        })
                      : isReduce
                      ? t('balancing.reasoning_reduce', {
                          rate: (device.avgRiseRate || 0).toFixed(3),
                          median: (analysisResult.houseMedianRiseRate || 0).toFixed(3),
                          diff: diffPct,
                          defaultValue: `Rise rate (+${(device.avgRiseRate || 0).toFixed(3)}°C/min) exceeds house median (+${(analysisResult.houseMedianRiseRate || 0).toFixed(3)}°C/min). Reduce valve flow by ${diffPct}%.`
                        })
                      : t('balancing.reasoning_balanced', {
                          rate: (device.avgRiseRate || 0).toFixed(3),
                          median: (analysisResult.houseMedianRiseRate || 0).toFixed(3),
                          defaultValue: `Rise rate (+${(device.avgRiseRate || 0).toFixed(3)}°C/min) is well balanced with house median.`
                        });

                    return (
                      <div
                        key={device.serial}
                        style={{
                          padding: '0.75rem 0.85rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.4rem',
                          borderBottom: '1px solid var(--border-color)'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {(() => {
                              const devObj = (devices || []).find(d => d.serialNo === device.serial);
                              return devObj?.friendlyName ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {devObj.friendlyName}
                                  </span>
                                  <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                                    ({device.serial})
                                  </span>
                                </div>
                              ) : (
                                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                  {device.serial}
                                </span>
                              );
                            })()}
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              (+{(device.avgRiseRate || 0).toFixed(3)}°C/min)
                            </span>
                          </div>

                          {/* Sensitivity suggestion pill */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{
                              fontSize: '0.85rem',
                              fontFamily: 'monospace',
                              fontWeight: 600,
                              color: 'var(--text-muted)'
                            }}>
                              {device.currentSensitivity}% →
                            </span>
                            <span style={{
                              fontSize: '0.85rem',
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              color: isBoost ? '#2563eb' : isReduce ? '#8b5cf6' : '#10b981'
                            }}>
                              {device.suggestedSensitivity}%
                            </span>
                            <span style={{
                              fontSize: '0.7rem',
                              padding: '0.15rem 0.45rem',
                              borderRadius: '4px',
                              backgroundColor: isBoost ? 'rgba(37, 99, 235, 0.1)' : isReduce ? 'rgba(139, 92, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                              color: isBoost ? '#2563eb' : isReduce ? '#8b5cf6' : '#10b981',
                              fontWeight: 600
                            }}>
                              {isBoost ? t('balancing.boost', { defaultValue: 'Boost Opening' })
                               : isReduce ? t('balancing.reduce', { defaultValue: 'Reduce Flow' })
                               : t('balancing.balanced', { defaultValue: 'Balanced' })}
                            </span>
                          </div>
                        </div>

                        {/* Reasoning note */}
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {localizedReasoning}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Action Buttons */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '1.25rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--border-color)',
            flexWrap: 'wrap',
            gap: '0.75rem'
          }}>
            <Button
              variant="secondary"
              onClick={handleResetDefaults}
              disabled={isApplying || isReadOnly}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <RotateCcw size={15} />
              <span>{t('balancing.reset_defaults', { defaultValue: 'Reset to Defaults (100%)' })}</span>
            </Button>

            <Button
              variant="primary"
              onClick={handleApplyAll}
              disabled={isApplying || isReadOnly}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}
            >
              {isApplying ? (
                <>
                  <Spinner size="sm" />
                  <span>{t('balancing.applying', { defaultValue: 'Applying...' })}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={16} />
                  <span>{t('balancing.apply_all', { defaultValue: 'Apply All Suggestions' })}</span>
                </>
              )}
            </Button>
          </div>
        </Card>
      )}

      {/* Manual Fine-Tuning Section */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <Sliders size={18} style={{ color: 'var(--primary-dark, #2563eb)' }} />
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
            {t('balancing.manual_override', { defaultValue: 'Manual Valve Sensitivities' })}
          </h3>
        </div>
        <p style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('balancing.manual_desc', {
            defaultValue: 'Fine-tune individual valve sensitivities directly (50% = maximum opening boost, 100% = standard gain).'
          })}
        </p>

        {vaDevices.length === 0 ? (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '0.5rem 0' }}>
            {t('balancing.no_devices', { defaultValue: 'No radiator valves (VA) found in home.' })}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {zoneGroups.map(group => (
              <div
                key={String(group.zoneId)}
                style={{
                  borderRadius: '10px',
                  border: '1px solid var(--border-color)',
                  backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.02))',
                  padding: '1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.85rem'
                }}
              >
                {/* Zone Section Header */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid var(--border-color)',
                  paddingBottom: '0.5rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{
                      padding: '0.3rem',
                      borderRadius: '6px',
                      backgroundColor: group.zoneId === 'unassigned' ? 'rgba(0,0,0,0.05)' : 'rgba(59, 130, 246, 0.1)',
                      color: group.zoneId === 'unassigned' ? 'var(--text-muted)' : 'var(--primary-dark, #2563eb)',
                      display: 'flex'
                    }}>
                      <MapPin size={15} />
                    </div>
                    <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {group.zoneName}
                    </span>
                  </div>
                  <span style={{
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    backgroundColor: 'var(--bg-card, rgba(0,0,0,0.05))',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '12px',
                    fontWeight: 500
                  }}>
                    {t('balancing.valve_count', {
                      count: group.devices.length,
                      defaultValue: `${group.devices.length} valve${group.devices.length === 1 ? '' : 's'}`
                    })}
                  </span>
                </div>

                {/* Devices in this zone */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  {group.devices.map(dev => {
                    const currentVal = manualSensitivities[dev.serialNo] !== undefined
                      ? manualSensitivities[dev.serialNo]
                      : (dev.valveSensitivity || 100);
                    const isSaving = Boolean(savingDevices[dev.serialNo]);

                    const isLowBattery = dev.batteryState === 'LOW' || dev.batteryState === 'CRITICAL' || dev.batteryState === 'DEPLETED';
                    const multiplier = (100 / (currentVal || 100)).toFixed(2);
                    const boostPct = Math.round(((100 / (currentVal || 100)) - 1) * 100);
                    const isDefault = currentVal === 100;

                    const presets = [
                      { val: 100, label: t('balancing.preset_standard', { defaultValue: '100% (Default)' }) },
                      { val: 85, label: t('balancing.preset_mild', { defaultValue: '85%' }) },
                      { val: 70, label: t('balancing.preset_moderate', { defaultValue: '70%' }) },
                      { val: 50, label: t('balancing.preset_max', { defaultValue: '50% (Max)' }) }
                    ];

                    return (
                      <div
                        key={dev.serialNo}
                        style={{
                          padding: '0.85rem',
                          borderRadius: '8px',
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-card, #ffffff)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.65rem'
                        }}
                      >
                        {/* Top Row: Device Name, Serial, Badges & Current Sensitivity */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {dev.friendlyName || dev.serialNo}
                              </span>
                              {dev.friendlyName && (
                                <span style={{
                                  fontSize: '0.75rem',
                                  fontFamily: 'monospace',
                                  color: 'var(--text-secondary)',
                                  backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.05))',
                                  padding: '0.1rem 0.35rem',
                                  borderRadius: '4px'
                                }}>
                                  {dev.serialNo}
                                </span>
                              )}
                              {isSaving && <Spinner size="sm" />}
                            </div>

                            {/* Metadata Badges: Type, Battery */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <span style={{
                                fontSize: '0.7rem',
                                fontFamily: 'monospace',
                                padding: '0.15rem 0.4rem',
                                borderRadius: '4px',
                                backgroundColor: 'var(--bg-subtle, rgba(0,0,0,0.04))',
                                color: 'var(--text-muted)',
                                fontWeight: 500
                              }}>
                                {dev.deviceType || 'VA'}
                              </span>

                              {isLowBattery && (
                                <span style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.2rem',
                                  fontSize: '0.7rem',
                                  color: 'var(--danger, #ef4444)',
                                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                  padding: '0.15rem 0.4rem',
                                  borderRadius: '4px',
                                  fontWeight: 600
                                }}>
                                  <BatteryLow size={11} />
                                  <span>{t('common.low', { defaultValue: 'Low Battery' })}</span>
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Right Side: Sensitivity Value & Flow Multiplier */}
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem' }}>
                            <span style={{ fontSize: '1rem', fontWeight: 700, fontFamily: 'monospace', color: 'var(--primary-dark, #2563eb)' }}>
                              {currentVal}%
                            </span>
                            <span style={{
                              fontSize: '0.7rem',
                              padding: '0.15rem 0.45rem',
                              borderRadius: '4px',
                              backgroundColor: isDefault ? 'rgba(16, 185, 129, 0.1)' : 'rgba(37, 99, 235, 0.1)',
                              color: isDefault ? '#10b981' : '#2563eb',
                              fontWeight: 600
                            }}>
                              {isDefault
                                ? t('balancing.flow_standard', { defaultValue: '1.00× (Standard)' })
                                : t('balancing.flow_boost', {
                                    multiplier,
                                    boost: boostPct,
                                    defaultValue: `${multiplier}× (+${boostPct}% boost)`
                                  })}
                            </span>
                          </div>
                        </div>

                        {/* Slider Control */}
                        <div style={{ marginTop: '0.25rem' }}>
                          <Slider
                            min={50}
                            max={100}
                            step={5}
                            value={currentVal}
                            disabled={isReadOnly || isSaving}
                            onChange={(val) => setManualSensitivities(prev => ({ ...prev, [dev.serialNo]: val }))}
                            onMouseUp={() => handleSingleDeviceChange(dev.serialNo, manualSensitivities[dev.serialNo] || currentVal)}
                            onTouchEnd={() => handleSingleDeviceChange(dev.serialNo, manualSensitivities[dev.serialNo] || currentVal)}
                          />
                          <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            marginTop: '0.2rem'
                          }}>
                            <span>{t('balancing.slider_max_boost', { defaultValue: '50% (Max Boost)' })}</span>
                            <span>{t('balancing.slider_standard', { defaultValue: '100% (Standard)' })}</span>
                          </div>
                        </div>

                        {/* Quick Preset Buttons */}
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.25rem' }}>
                          {presets.map(p => {
                            const isSelected = currentVal === p.val;
                            return (
                              <button
                                key={p.val}
                                type="button"
                                disabled={isReadOnly || isSaving}
                                onClick={() => handleSingleDeviceChange(dev.serialNo, p.val)}
                                style={{
                                  padding: '0.25rem 0.55rem',
                                  borderRadius: '6px',
                                  border: isSelected ? '1px solid var(--primary-dark, #2563eb)' : '1px solid var(--border-color)',
                                  backgroundColor: isSelected ? 'rgba(37, 99, 235, 0.12)' : 'var(--bg-card, rgba(0,0,0,0.03))',
                                  color: isSelected ? 'var(--primary-dark, #2563eb)' : 'var(--text-secondary)',
                                  fontSize: '0.75rem',
                                  fontWeight: isSelected ? 600 : 500,
                                  cursor: isReadOnly || isSaving ? 'not-allowed' : 'pointer',
                                  transition: 'all 0.15s ease'
                                }}
                              >
                                {p.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* History Snapshots */}
      {historyData && Array.isArray(historyData.snapshots) && historyData.snapshots.length > 0 && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <History size={18} style={{ color: 'var(--text-muted)' }} />
            <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
              {t('balancing.history', { defaultValue: 'Analysis History' })}
            </h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {historyData.snapshots.map(item => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  fontSize: '0.8rem'
                }}
              >
                <div>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                  {item.analysis && item.analysis.heatingRunsTotal && (
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                      ({t('balancing.history_runs_hours', {
                        runs: item.analysis.heatingRunsTotal,
                        hours: item.analysis.dataSpanHours,
                        defaultValue: `${item.analysis.heatingRunsTotal} runs, ${item.analysis.dataSpanHours}h`
                      })})
                    </span>
                  )}
                </div>

                <span style={{
                  padding: '0.15rem 0.45rem',
                  borderRadius: '4px',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  backgroundColor: item.applied ? 'rgba(16, 185, 129, 0.1)' : 'rgba(156, 163, 175, 0.1)',
                  color: item.applied ? '#10b981' : 'var(--text-muted)'
                }}>
                  {item.applied ? t('balancing.history_applied', { defaultValue: 'Applied ✓' }) : t('balancing.history_not_applied', { defaultValue: 'Not applied' })}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
