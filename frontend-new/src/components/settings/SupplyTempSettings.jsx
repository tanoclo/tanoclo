/**
 * @file src/components/settings/SupplyTempSettings.jsx
 * @brief Renders the Boiler Supply Flow Temperature settings form and optimizer telemetry.
 * 
 * Allows configuring user-defined guardrail bounds (min/max limits), default manual flow temp,
 * and enabling server-side dynamic flow optimization based on weather and room demand.
 */

import { SWR_KEYS } from '../../utils/swrKeys';
import { useState, useEffect } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Button from '../common/Button';
import Spinner from '../common/Spinner';
import Toggle from '../common/Toggle';
import Slider from '../common/Slider';
import {
  getSupplyTemperatureOptimization,
  updateSupplyTemperatureOptimization,
  getSupplyTemperatureHistory
} from '../../api/heating';
import { Save, Flame, Thermometer, Wind, Activity, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logger from '../../utils/logger';
import { useToast } from '../../context/ToastContext';

/**
 * @brief Supply temperature optimization settings panel.
 * @param {number} props.homeId - Active home identifier.
 */
export default function SupplyTempSettings({ homeId }) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const { data: optData, error, mutate } = useSWR(
    homeId ? SWR_KEYS.supplyTempOptimization(homeId) : null,
    () => getSupplyTemperatureOptimization(homeId)
  );

  const { data: histData } = useSWR(
    homeId ? SWR_KEYS.supplyTempHistory(homeId) : null,
    () => getSupplyTemperatureHistory(homeId, 15)
  );

  const [maxTemp, setMaxTemp] = useState(60);
  const [minTemp, setMinTemp] = useState(30);
  const [maxLimit, setMaxLimit] = useState(80);
  const [autoAdapt, setAutoAdapt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (optData) {
      const serverMax = optData.maxFlowTemperature ?? 60;
      const serverMin = optData.minFlowTemperature ?? optData.maxFlowTemperatureConstraints?.min ?? 30;
      const serverLimit = optData.maxFlowTemperatureLimit ?? optData.maxFlowTemperatureConstraints?.max ?? 80;
      const serverAuto = optData.autoAdaptation?.enabled ?? false;

      setMaxTemp(prev => prev !== serverMax ? serverMax : prev);
      setMinTemp(prev => prev !== serverMin ? serverMin : prev);
      setMaxLimit(prev => prev !== serverLimit ? serverLimit : prev);
      setAutoAdapt(prev => prev !== serverAuto ? serverAuto : prev);
    }
  }, [optData]);

  // Keep maxTemp clamped within [minTemp, maxLimit]
  const handleMinChange = (val) => {
    const clampedMin = Math.min(val, maxLimit - 5);
    setMinTemp(clampedMin);
    if (maxTemp < clampedMin) setMaxTemp(clampedMin);
  };

  const handleMaxLimitChange = (val) => {
    const clampedLimit = Math.max(val, minTemp + 5);
    setMaxLimit(clampedLimit);
    if (maxTemp > clampedLimit) setMaxTemp(clampedLimit);
  };

  const handleMaxTempChange = (val) => {
    const clamped = Math.max(minTemp, Math.min(maxLimit, val));
    setMaxTemp(clamped);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = {
        maxFlowTemperature: maxTemp,
        minFlowTemperature: minTemp,
        maxFlowTemperatureLimit: maxLimit,
        maxFlowTemperatureConstraints: {
          min: minTemp,
          max: maxLimit
        },
        autoAdaptation: {
          enabled: autoAdapt
        }
      };
      await updateSupplyTemperatureOptimization(homeId, payload);
      await mutate();
      showToast(t('settings.flow_temp_saved'), 'success');
    } catch (err) {
      logger.error('Failed to save supply temperature optimization settings:', err);
    } finally {
      setIsSaving(false);
    }
  };

  if (error) return <div style={{ color: 'var(--danger)', padding: '1rem' }}>{t('settings.flow_temp_failed_load')}</div>;
  if (!optData) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
        <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.flow_temp_opt')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            {t('settings.flow_temp_opt_desc')}
          </p>
        </div>
        <div style={{ padding: '3rem', textAlign: 'center' }}><Spinner size={24} /></div>
      </div>
    );
  }

  const autoState = optData.autoAdaptation || {};
  const historyList = histData?.history || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%', maxWidth: '800px' }}>
      <div style={{ minHeight: '42px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, lineHeight: 1.2 }}>{t('settings.flow_temp_opt')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
          {t('settings.flow_temp_opt_desc')}
        </p>
      </div>

      {/* Live boiler status telemetry card */}
      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: 'var(--bg-secondary, rgba(255,255,255,0.03))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity size={18} style={{ color: 'var(--primary)' }} />
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.live_boiler_metrics')}</h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
          <div style={{ padding: '0.75rem', borderRadius: '8px', background: 'var(--card-bg, rgba(255,255,255,0.02))', border: '1px solid var(--border-color, rgba(255,255,255,0.05))' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Flame size={14} color="#f97316" /> {t('settings.current_flow_temp')}
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, marginTop: '4px' }}>
              {autoState.currentActualFlowTemperature !== null && autoState.currentActualFlowTemperature !== undefined
                ? `${autoState.currentActualFlowTemperature.toFixed(1)}°C`
                : '—'}
            </div>
          </div>

          <div style={{ padding: '0.75rem', borderRadius: '8px', background: 'var(--card-bg, rgba(255,255,255,0.02))', border: '1px solid var(--border-color, rgba(255,255,255,0.05))' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Thermometer size={14} color="#38bdf8" /> {t('settings.current_return_temp')}
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, marginTop: '4px' }}>
              {autoState.currentReturnTemperature !== null && autoState.currentReturnTemperature !== undefined
                ? `${autoState.currentReturnTemperature.toFixed(1)}°C`
                : '—'}
            </div>
          </div>

          <div style={{ padding: '0.75rem', borderRadius: '8px', background: 'var(--card-bg, rgba(255,255,255,0.02))', border: '1px solid var(--border-color, rgba(255,255,255,0.05))' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Wind size={14} color="#eab308" /> {t('settings.outside_temp')}
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, marginTop: '4px' }}>
              {autoState.currentOutsideTemperature !== null && autoState.currentOutsideTemperature !== undefined
                ? `${autoState.currentOutsideTemperature.toFixed(1)}°C`
                : '—'}
            </div>
          </div>

          <div style={{ padding: '0.75rem', borderRadius: '8px', background: 'var(--card-bg, rgba(255,255,255,0.02))', border: '1px solid var(--border-color, rgba(255,255,255,0.05))' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <ShieldCheck size={14} color="#10b981" /> {t('settings.current_modulation')}
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, marginTop: '4px' }}>
              {autoState.currentModulation !== null && autoState.currentModulation !== undefined
                ? `${autoState.currentModulation}%`
                : '—'}
            </div>
          </div>
        </div>

        {autoState.lastReason && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center', borderTop: '1px solid var(--border-color, rgba(255,255,255,0.05))', paddingTop: '0.5rem' }}>
            <span>Active strategy:</span>
            <code style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', padding: '2px 6px', borderRadius: '4px', color: 'var(--primary)' }}>
              {autoState.lastReason}
            </code>
            {autoState.lastOptimized && (
              <span style={{ marginLeft: 'auto', fontSize: '0.7rem' }}>
                Updated: {new Date(autoState.lastOptimized).toLocaleTimeString()}
              </span>
            )}
          </div>
        )}
      </Card>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

        {/* Dynamic Thermal Adaptation toggle */}
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong style={{ fontSize: '0.95rem', fontWeight: 700 }}>{t('settings.auto_adaptation')}</strong>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '4px 0 0', maxWidth: '600px' }}>
                {t('settings.auto_adaptation_desc')}
              </p>
            </div>
            <Toggle checked={autoAdapt} onChange={setAutoAdapt} />
          </div>
        </Card>

        {/* Minimum Flow Temperature slider (Lower Bound Guardrail) */}
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.min_flow_temp')}</h3>
            <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#38bdf8' }}>
              {minTemp}°C
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.min_flow_temp_desc')}
          </p>
          <Slider
            min={20}
            max={50}
            step={1}
            value={minTemp}
            onChange={handleMinChange}
          />
        </Card>

        {/* Default / Target Max Flow Temperature slider */}
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.max_flow_temp')}</h3>
            <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--primary)' }}>
              {maxTemp}°C
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.max_flow_temp_desc')}
          </p>
          <Slider
            min={minTemp}
            max={maxLimit}
            step={1}
            value={maxTemp}
            onChange={handleMaxTempChange}
          />
        </Card>

        {/* Maximum Flow Temperature Ceiling slider (Upper Bound Guardrail) */}
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.max_flow_limit')}</h3>
            <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f97316' }}>
              {maxLimit}°C
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('settings.max_flow_limit_desc')}
          </p>
          <Slider
            min={45}
            max={85}
            step={1}
            value={maxLimit}
            onChange={handleMaxLimitChange}
          />
        </Card>
        <Button
          type="submit"
          variant="primary"
          disabled={isSaving}
          style={{ alignSelf: 'flex-end' }}
        >
          <Save size={16} />
          <span>{isSaving ? t('settings.saving') : t('settings.save_settings')}</span>
        </Button>
      </form>

      {/* History table */}
      {historyList.length > 0 && (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>{t('settings.optimization_history')}</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.1))', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '0.5rem' }}>Time</th>
                  <th style={{ padding: '0.5rem' }}>Optimized</th>
                  <th style={{ padding: '0.5rem' }}>Actual</th>
                  <th style={{ padding: '0.5rem' }}>Outside</th>
                  <th style={{ padding: '0.5rem' }}>Strategy</th>
                </tr>
              </thead>
              <tbody>
                {historyList.slice(-10).reverse().map((row, idx) => (
                  <tr key={row.id || idx} style={{ borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '0.5rem' }}>{row.timestamp ? row.timestamp.slice(11, 16) : '—'}</td>
                    <td style={{ padding: '0.5rem', fontWeight: 700, color: 'var(--primary)' }}>
                      {row.computed_flow_temp !== null ? `${row.computed_flow_temp}°C` : '—'}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      {row.actual_flow_temp !== null ? `${row.actual_flow_temp}°C` : '—'}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      {row.outside_temp !== null ? `${row.outside_temp}°C` : '—'}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      <span style={{ fontSize: '0.75rem', opacity: 0.85 }}>{row.reason || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

    </div>
  );
}