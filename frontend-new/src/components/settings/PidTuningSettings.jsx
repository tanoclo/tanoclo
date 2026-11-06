/**
 * @file src/components/settings/PidTuningSettings.jsx
 * @brief Renders the Advisory Thermodynamic Room PID Tuning settings panel.
 * 
 * Evaluates room temperature transient responses (overshoot, droop, oscillations)
 * against active setpoints and provides recommendations for tuning Kp, Ki, and Kd.
 * Emphasizes performing hydraulic balancing first before fine-tuning PID parameters.
 */

import React, { useState } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import { SWR_KEYS } from '../../utils/swrKeys';
import {
  getPidTuningAnalysis,
  applyPidTuningSuggestions,
  getPidTuningHistory
} from '../../api/pidTuning';
import {
  Activity,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  History,
  TrendingUp,
  HelpCircle,
  ShieldAlert,
  ArrowRight
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../context/ToastContext';
import logger from '../../utils/logger';

export default function PidTuningSettings({ homeId, zones = [], isReadOnly = false }) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [hours, setHours] = useState(72);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);

  const { data: historyData, mutate: mutateHistory } = useSWR(
    homeId ? SWR_KEYS.pidTuningHistory(homeId) : null,
    () => getPidTuningHistory(homeId)
  );

  const handleRunAnalysis = async () => {
    if (!homeId) return;
    setIsAnalyzing(true);
    try {
      const res = await getPidTuningAnalysis(homeId, hours);
      setAnalysisResult(res);
      mutateHistory();
      showToast(t('pid_tuning.analysis_complete', { defaultValue: 'Thermodynamic PID analysis completed successfully' }), 'success');
    } catch (err) {
      logger.error('Failed to run PID tuning analysis', err);
      showToast(err.message || t('pid_tuning.analysis_failed', { defaultValue: 'Failed to run analysis' }), 'error');
      setAnalysisResult(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleApplyAll = async () => {
    if (!homeId || !analysisResult || !analysisResult.zones) return;
    setIsApplying(true);
    try {
      const zonesToApply = analysisResult.zones
        .filter(z => z.suggestedKp !== undefined && z.suggestedKi !== undefined && z.suggestedKd !== undefined)
        .map(z => ({
          zoneId: z.zoneId,
          kp: z.suggestedKp,
          ki: z.suggestedKi,
          kd: z.suggestedKd
        }));

      if (zonesToApply.length === 0) {
        showToast(t('pid_tuning.no_zones_to_apply', { defaultValue: 'No zones ready to apply' }), 'warning');
        return;
      }

      await applyPidTuningSuggestions(homeId, zonesToApply, analysisResult.snapshotId);
      showToast(t('pid_tuning.applied_success', { defaultValue: 'Zone PID parameters updated successfully!' }), 'success');
      mutateHistory();
    } catch (err) {
      logger.error('Failed to apply PID tuning suggestions', err);
      showToast(err.message || t('pid_tuning.apply_failed', { defaultValue: 'Failed to apply PID settings' }), 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const handleApplySingleZone = async (z) => {
    if (!homeId || !z) return;
    setIsApplying(true);
    try {
      await applyPidTuningSuggestions(homeId, [{
        zoneId: z.zoneId,
        kp: z.suggestedKp,
        ki: z.suggestedKi,
        kd: z.suggestedKd
      }], analysisResult?.snapshotId);
      showToast(t('pid_tuning.zone_applied_success', { defaultValue: 'Updated PID settings for {{name}}!', name: z.zoneName }), 'success');
      mutateHistory();
    } catch (err) {
      logger.error('Failed to apply PID settings for zone', err);
      showToast(err.message || t('pid_tuning.apply_failed', { defaultValue: 'Failed to apply PID settings' }), 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const getDiagnosisBadge = (diagnosis) => {
    switch (diagnosis) {
      case 'OPTIMAL':
        return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>{t('pid_tuning.diagnosis_optimal', { defaultValue: 'Optimal' })}</span>;
      case 'OVERSHOOT':
        return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(249, 115, 22, 0.15)', color: '#f97316' }}>{t('pid_tuning.diagnosis_overshoot', { defaultValue: 'Overshooting' })}</span>;
      case 'DROOP':
        return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(234, 179, 8, 0.15)', color: '#eab308' }}>{t('pid_tuning.diagnosis_droop', { defaultValue: 'Steady-State Droop' })}</span>;
      case 'HUNTING':
        return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>{t('pid_tuning.diagnosis_hunting', { defaultValue: 'Hunting / Oscillating' })}</span>;
      case 'SLUGGISH':
        return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>{t('pid_tuning.diagnosis_sluggish', { defaultValue: 'Sluggish' })}</span>;
      default:
        return <span style={{ padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600, background: 'rgba(156, 163, 175, 0.15)', color: '#9ca3af' }}>{t('pid_tuning.diagnosis_insufficient', { defaultValue: 'Need Data' })}</span>;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '1000px', margin: '0 auto' }}>
      {/* 1. Header Information & Hydraulic Balancing Prerequisite Notice */}
      <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: 'rgba(59, 130, 246, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent, #3b82f6)'
          }}>
            <Activity size={22} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              {t('pid_tuning.title', { defaultValue: 'Thermodynamic Room PID Tuning' })}
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0 0' }}>
              {t('pid_tuning.subtitle', { defaultValue: 'Iteratively optimize room heating gains (Kp, Ki, Kd) based on measured thermal transient response.' })}
            </p>
          </div>
        </div>

        {/* Note: Hydraulic Balancing Prerequisite */}
        <div style={{
          padding: '1rem',
          borderRadius: '8px',
          background: 'rgba(234, 179, 8, 0.08)',
          border: '1px solid rgba(234, 179, 8, 0.25)',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start'
        }}>
          <ShieldAlert size={20} color="#eab308" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: '1.45' }}>
            <strong>{t('pid_tuning.prerequisite_title', { defaultValue: 'Step 1: Perform Hydraulic Balancing First!' })}</strong>
            <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-secondary)' }}>
              {t('pid_tuning.prerequisite_desc', { defaultValue: 'Before tuning room PID parameters, hydraulic balancing must be performed to ensure radiators across your home warm at uniform rates. Once hydraulic balance is set, room PID tuning fine-tunes response speed, steady-state error, and prevents overshoot.' })}
            </p>
            {analysisResult && (
              <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {analysisResult.hydraulicBaseline ? (
                  <span style={{ color: '#22c55e', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600 }}>
                    <CheckCircle2 size={15} /> {t('pid_tuning.hydraulic_baseline_active', { defaultValue: 'Hydraulic balancing baseline detected (Snapshot #{id})', id: analysisResult.hydraulicBaseline.id })}
                  </span>
                ) : (
                  <span style={{ color: '#eab308', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 600 }}>
                    <AlertTriangle size={15} /> {t('pid_tuning.no_hydraulic_baseline', { defaultValue: 'No hydraulic snapshot applied yet. We recommend applying hydraulic balancing first.' })}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Analysis Window Controls */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          paddingTop: '0.5rem',
          borderTop: '1px solid var(--border-color)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              {t('pid_tuning.time_window', { defaultValue: 'History Window:' })}
            </span>
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              disabled={isAnalyzing}
              style={{
                padding: '0.4rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                background: 'var(--bg-input, var(--bg-card))',
                color: 'var(--text-primary)',
                fontSize: '0.875rem'
              }}
            >
              <option value={24}>24 {t('common.hours', { defaultValue: 'hours' })}</option>
              <option value={48}>48 {t('common.hours', { defaultValue: 'hours' })}</option>
              <option value={72}>72 {t('common.hours', { defaultValue: 'hours' })} (Recommended)</option>
              <option value={168}>7 {t('common.days', { defaultValue: 'days' })}</option>
            </select>
          </div>

          <Button
            variant="primary"
            onClick={handleRunAnalysis}
            disabled={isAnalyzing}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              minWidth: '160px',
              height: '38px',
              flexShrink: 0
            }}
          >
            {isAnalyzing ? <Spinner size={16} /> : <TrendingUp size={16} />}
            <span>{isAnalyzing ? t('pid_tuning.analyzing', { defaultValue: 'Analyzing...' }) : t('pid_tuning.run_analysis', { defaultValue: 'Run PID Analysis' })}</span>
          </Button>
        </div>
      </Card>

      {/* 2. Analysis Results & Zone Recommendations */}
      {analysisResult && (
        <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                {t('pid_tuning.results_title', { defaultValue: 'Zone PID Tuning Recommendations' })}
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0.2rem 0 0 0' }}>
                {t('pid_tuning.results_summary', {
                  defaultValue: 'Evaluated {{windows}} transient windows over {{hours}}h',
                  windows: analysisResult.totalTransientWindows,
                  hours: analysisResult.analyzedHours
                })}
              </p>
            </div>

            <Button
              variant="primary"
              onClick={handleApplyAll}
              disabled={isApplying || isReadOnly}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                minWidth: '180px',
                height: '38px',
                flexShrink: 0
              }}
            >
              {isApplying ? <Spinner size={16} /> : <CheckCircle2 size={16} />}
              <span>{t('pid_tuning.apply_all', { defaultValue: 'Apply Suggested Gains' })}</span>
            </Button>
          </div>

          {/* Zones Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {analysisResult.zones.map((zone) => (
              <div
                key={zone.zoneId}
                style={{
                  padding: '1.25rem',
                  borderRadius: '10px',
                  background: 'var(--bg-secondary, rgba(255, 255, 255, 0.03))',
                  border: '1px solid var(--border-color)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>
                      {zone.zoneName}
                    </span>
                    {zone.roomSize && (
                      <span style={{
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(59, 130, 246, 0.12)',
                        color: 'var(--primary, #3b82f6)'
                      }}>
                        {zone.roomSize} m²
                      </span>
                    )}
                    {(zone.heatingType === 'UNDERFLOOR' || zone.heating_type === 'UNDERFLOOR') && (
                      <span style={{
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(234, 88, 12, 0.1)',
                        color: 'var(--warning, #ea580c)',
                        textTransform: 'uppercase'
                      }}>
                        {t('settings.emitter_underfloor', { defaultValue: 'Underfloor' })}
                      </span>
                    )}
                    {getDiagnosisBadge(zone.diagnosis)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Confidence: <strong>{zone.confidence}</strong> ({zone.metrics.validWindowsCount} windows)
                    </span>
                    <Button
                      variant="secondary"
                      onClick={() => handleApplySingleZone(zone)}
                      disabled={isApplying || isReadOnly}
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.65rem' }}
                    >
                      {t('pid_tuning.apply_zone_btn', { defaultValue: 'Apply' })}
                    </Button>
                  </div>
                </div>

                {/* Metrics row */}
                <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <div>Max Overshoot: <strong style={{ color: 'var(--text-primary)' }}>{zone.metrics.maxOvershoot}°C</strong></div>
                  <div>Steady-State Error: <strong style={{ color: 'var(--text-primary)' }}>{zone.metrics.avgSteadyStateError}°C</strong></div>
                  <div>Oscillation Score: <strong style={{ color: 'var(--text-primary)' }}>{zone.metrics.oscillationScore}</strong></div>
                  <div>Avg Rise Time: <strong style={{ color: 'var(--text-primary)' }}>{zone.metrics.avgRiseTimeMinutes}m</strong></div>
                </div>

                {/* Gains Comparison */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '1rem',
                  padding: '0.75rem',
                  borderRadius: '8px',
                  background: 'rgba(0, 0, 0, 0.08)'
                }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      Proportional Gain (Kp / 0x6080)
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                      <span>{zone.currentKp.toFixed(2)}</span>
                      <ArrowRight size={14} color="var(--text-muted)" />
                      <strong style={{ color: zone.suggestedKp !== zone.currentKp ? 'var(--accent, #3b82f6)' : 'inherit' }}>
                        {zone.suggestedKp.toFixed(2)}
                      </strong>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      Integral Gain (Ki / 0x60a0)
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                      <span>{zone.currentKi.toFixed(2)}</span>
                      <ArrowRight size={14} color="var(--text-muted)" />
                      <strong style={{ color: zone.suggestedKi !== zone.currentKi ? 'var(--accent, #3b82f6)' : 'inherit' }}>
                        {zone.suggestedKi.toFixed(2)}
                      </strong>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      Derivative Gain (Kd / 0x60c0)
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                      <span>{zone.currentKd.toFixed(2)}</span>
                      <ArrowRight size={14} color="var(--text-muted)" />
                      <strong style={{ color: zone.suggestedKd !== zone.currentKd ? 'var(--accent, #3b82f6)' : 'inherit' }}>
                        {zone.suggestedKd.toFixed(2)}
                      </strong>
                    </div>
                  </div>
                </div>

                {/* Explanation text */}
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                  {zone.reason}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 3. Historical PID Snapshots */}
      {historyData && historyData.length > 0 && (
        <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <History size={18} color="var(--text-secondary)" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              {t('pid_tuning.history_title', { defaultValue: 'Tuning History' })}
            </h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {historyData.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.75rem 1rem',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary, rgba(255, 255, 255, 0.02))',
                  border: '1px solid var(--border-color)',
                  fontSize: '0.85rem'
                }}
              >
                <div>
                  <strong>Snapshot #{s.id}</strong> — {new Date(s.createdAt).toLocaleString()}
                  {s.hydraulicSnapshotId && (
                    <span style={{ marginLeft: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      (Hydraulic Baseline #{s.hydraulicSnapshotId})
                    </span>
                  )}
                </div>

                <div>
                  {s.applied ? (
                    <span style={{ color: '#22c55e', fontWeight: 600, fontSize: '0.8rem' }}>
                      ✓ {t('pid_tuning.applied', { defaultValue: 'Applied' })}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      {t('pid_tuning.not_applied', { defaultValue: 'Advisory only' })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
