/**
 * @file src/components/climatequality/MoldDetailModal.jsx
 * @brief Detailed building physics and mold risk diagnostics modal.
 */

import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { ShieldCheck, AlertTriangle, AlertOctagon, Clock, Droplets, Thermometer, Wind, Home } from 'lucide-react';

export default function MoldDetailModal({ isOpen, onClose, zoneName, comfort, state, outsideTemp }) {
  const { t } = useTranslation();

  if (!isOpen || !comfort) return null;

  const mold = comfort.mold || {};
  const isCalibrating = mold.status === 'CALIBRATING';
  const level = (mold.level || 'LOW').toUpperCase();
  const index = mold.index != null ? mold.index : 0.0;
  const progress = mold.progressPercentage != null ? mold.progressPercentage : 100;

  const roomTemp = state?.sensorDataPoints?.insideTemperature?.celsius;
  const roomHum = state?.sensorDataPoints?.humidity?.percentage;

  const surfaceTemp = mold.surfaceTemperature;
  const surfaceHum = mold.surfaceRelativeHumidity;
  const dewPoint = mold.dewPoint;
  const condensationRisk = mold.condensationRisk;
  const fRsi = mold.effectiveInsulationFactor != null ? mold.effectiveInsulationFactor : 0.70;

  // Visual status config
  let statusColor = '#10b981';
  let StatusIcon = ShieldCheck;
  let statusTitle = t('air_comfort.mold_low', { defaultValue: 'Low Mold Risk' });
  let statusDesc = t('air_comfort.mold_low_desc', {
    defaultValue: 'Indoor conditions and wall surface temperatures are safely within dry limits. No spore germination risk.'
  });

  if (isCalibrating) {
    statusColor = '#94a3b8';
    StatusIcon = Clock;
    statusTitle = t('air_comfort.mold_calibrating', { defaultValue: `Calibrating (${progress}%)`, progress });
    statusDesc = t('air_comfort.mold_calibrating_desc', {
      defaultValue: 'Collecting initial temperature and humidity history. A minimum of 48 hours is required to establish a reliable baseline.'
    });
  } else if (level === 'HIGH' || condensationRisk) {
    statusColor = '#ef4444';
    StatusIcon = AlertOctagon;
    statusTitle = t('air_comfort.mold_high', { defaultValue: 'High Mold Risk' });
    statusDesc = t('air_comfort.mold_high_desc', {
      defaultValue: 'Cold exterior walls or high humidity have reached critical levels. Condensation and spore colony formation are likely without ventilation.'
    });
  } else if (level === 'ELEVATED') {
    statusColor = '#f59e0b';
    StatusIcon = AlertTriangle;
    statusTitle = t('air_comfort.mold_elevated', { defaultValue: 'Elevated Risk' });
    statusDesc = t('air_comfort.mold_elevated_desc', {
      defaultValue: 'Surface relative humidity frequently exceeds critical thresholds. Increased moisture may support early fungal spore growth.'
    });
  }

  // Smart ventilation advice
  let advice = null;
  if (outsideTemp != null && roomHum != null && roomHum > 55) {
    if (outsideTemp < (roomTemp || 20)) {
      advice = t('air_comfort.mold_advice_vent_cold_outside', {
        defaultValue: 'Outdoor air is cooler and contains less absolute water vapor. Airing for 5–10 minutes will quickly drop indoor relative humidity.'
      });
    } else {
      advice = t('air_comfort.mold_advice_vent_warm_outside', {
        defaultValue: 'Outdoor air is warm. Ventilate during cooler morning or evening hours to avoid introducing warm moisture.'
      });
    }
  } else if (condensationRisk) {
    advice = t('air_comfort.mold_advice_warm_walls', {
      defaultValue: 'Cold walls are near the dew point. Slightly increase room heating to raise wall temperatures above condensation limits.'
    });
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${zoneName} — ${t('air_comfort.mold_diagnostics_title', { defaultValue: 'Mold Risk Diagnostics' })}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '0.25rem' }}>

        {/* Status Banner */}
        <div style={{
          display: 'flex',
          gap: '1rem',
          padding: '1rem',
          borderRadius: '12px',
          backgroundColor: `${statusColor}15`,
          border: `1px solid ${statusColor}35`
        }}>
          <div style={{ color: statusColor, flexShrink: 0, marginTop: '2px' }}>
            <StatusIcon size={28} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '4px' }}>
              <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: statusColor }}>
                {statusTitle}
              </h4>
              {!isCalibrating && (
                <span style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  backgroundColor: `${statusColor}25`,
                  padding: '1px 6px',
                  borderRadius: '6px'
                }}>
                  Index {index.toFixed(2)} / 6.0
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {statusDesc}
            </p>
          </div>
        </div>

        {/* Mold Index Scale Bar */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '6px', color: 'var(--text-secondary)' }}>
            <span>{t('air_comfort.vtt_scale_low', { defaultValue: 'Low (0.0)' })}</span>
            <span>{t('air_comfort.vtt_scale_elevated', { defaultValue: 'Elevated (1.0)' })}</span>
            <span>{t('air_comfort.vtt_scale_high', { defaultValue: 'High (2.0+)' })}</span>
          </div>

          <div style={{
            position: 'relative',
            height: '10px',
            borderRadius: '5px',
            background: 'linear-gradient(to right, #10b981 0%, #10b981 16%, #f59e0b 17%, #f59e0b 33%, #ef4444 34%, #ef4444 100%)',
            overflow: 'hidden'
          }}>
            {!isCalibrating && (
              <div style={{
                position: 'absolute',
                left: `${Math.min(100, Math.max(0, (index / 6.0) * 100))}%`,
                top: 0,
                bottom: 0,
                width: '4px',
                backgroundColor: '#ffffff',
                boxShadow: '0 0 4px rgba(0,0,0,0.8)',
                transform: 'translateX(-50%)'
              }} />
            )}
          </div>
        </div>

        {/* Physics Metrics Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '0.75rem'
        }}>
          {/* Surface Temperature */}
          <div style={{
            padding: '0.75rem',
            borderRadius: '10px',
            backgroundColor: 'var(--bg-tertiary, rgba(255,255,255,0.05))',
            border: '1px solid var(--border-color, rgba(255,255,255,0.1))'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <Thermometer size={14} style={{ color: 'var(--primary)' }} />
              <span>{t('air_comfort.metric_surface_temp', { defaultValue: 'Wall Surface' })}</span>
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px' }}>
              {surfaceTemp != null ? `${surfaceTemp.toFixed(1)}°` : '--'}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              Room: {roomTemp != null ? `${roomTemp.toFixed(1)}°` : '--'}
            </div>
          </div>

          {/* Surface Relative Humidity */}
          <div style={{
            padding: '0.75rem',
            borderRadius: '10px',
            backgroundColor: 'var(--bg-tertiary, rgba(255,255,255,0.05))',
            border: '1px solid var(--border-color, rgba(255,255,255,0.1))'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <Droplets size={14} style={{ color: 'var(--secondary)' }} />
              <span>{t('air_comfort.metric_surface_hum', { defaultValue: 'Surface RH' })}</span>
            </div>
            <div style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              marginTop: '4px',
              color: surfaceHum != null && surfaceHum >= 80 ? '#ef4444' : 'inherit'
            }}>
              {surfaceHum != null ? `${surfaceHum.toFixed(0)}%` : '--'}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              Room: {roomHum != null ? `${roomHum.toFixed(0)}%` : '--'}
            </div>
          </div>

          {/* Dew Point */}
          <div style={{
            padding: '0.75rem',
            borderRadius: '10px',
            backgroundColor: 'var(--bg-tertiary, rgba(255,255,255,0.05))',
            border: '1px solid var(--border-color, rgba(255,255,255,0.1))'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <Droplets size={14} style={{ color: '#06b6d4' }} />
              <span>{t('air_comfort.metric_dew_point', { defaultValue: 'Dew Point' })}</span>
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px' }}>
              {dewPoint != null ? `${dewPoint.toFixed(1)}°` : '--'}
            </div>
            <div style={{ fontSize: '0.7rem', color: condensationRisk ? '#ef4444' : 'var(--text-secondary)' }}>
              {condensationRisk ? t('air_comfort.condensation_risk', { defaultValue: 'Condensation Risk!' }) : t('air_comfort.no_condensation', { defaultValue: 'Safe margin' })}
            </div>
          </div>

          {/* Insulation Factor */}
          <div style={{
            padding: '0.75rem',
            borderRadius: '10px',
            backgroundColor: 'var(--bg-tertiary, rgba(255,255,255,0.05))',
            border: '1px solid var(--border-color, rgba(255,255,255,0.1))'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <Home size={14} style={{ color: '#8b5cf6' }} />
              <span>{t('air_comfort.metric_insulation', { defaultValue: 'Insulation (f_Rsi)' })}</span>
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px' }}>
              {fRsi.toFixed(2)}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              {mold.isInherited ? t('air_comfort.inherited_home', { defaultValue: 'Home default' }) : t('air_comfort.custom_room', { defaultValue: 'Room override' })}
            </div>
          </div>
        </div>

        {/* Actionable Advice */}
        {advice && (
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            padding: '0.85rem',
            borderRadius: '10px',
            backgroundColor: 'rgba(56, 189, 248, 0.1)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            fontSize: '0.85rem',
            lineHeight: 1.4
          }}>
            <Wind size={18} style={{ color: '#38bdf8', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <strong>{t('air_comfort.recommendation', { defaultValue: 'Recommendation' })}: </strong>
              <span>{advice}</span>
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
}
