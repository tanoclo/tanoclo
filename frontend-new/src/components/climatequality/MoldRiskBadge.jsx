/**
 * @file src/components/climatequality/MoldRiskBadge.jsx
 * @brief Renders the visual badge for room mold risk levels.
 */

import { useTranslation } from 'react-i18next';
import { ShieldCheck, AlertTriangle, AlertOctagon, Clock } from 'lucide-react';

export default function MoldRiskBadge({ mold, onClick, size = 'sm' }) {
  const { t } = useTranslation();

  if (!mold) return null;

  const isCalibrating = mold.status === 'CALIBRATING';
  const level = (mold.level || 'LOW').toUpperCase();

  let bg = 'rgba(16, 185, 129, 0.15)';
  let color = '#10b981';
  let borderColor = 'rgba(16, 185, 129, 0.3)';
  let Icon = ShieldCheck;
  let label = t('air_comfort.mold_low', { defaultValue: 'Low Mold Risk' });

  if (isCalibrating) {
    bg = 'rgba(100, 116, 139, 0.15)';
    color = '#94a3b8';
    borderColor = 'rgba(100, 116, 139, 0.3)';
    Icon = Clock;
    const progress = mold.progressPercentage != null ? mold.progressPercentage : 0;
    label = t('air_comfort.mold_calibrating', { defaultValue: `Calibrating (${progress}%)`, progress });
  } else if (level === 'HIGH' || mold.condensationRisk) {
    bg = 'rgba(239, 68, 68, 0.15)';
    color = '#ef4444';
    borderColor = 'rgba(239, 68, 68, 0.3)';
    Icon = AlertOctagon;
    label = t('air_comfort.mold_high', { defaultValue: 'High Mold Risk' });
  } else if (level === 'ELEVATED') {
    bg = 'rgba(245, 158, 11, 0.15)';
    color = '#f59e0b';
    borderColor = 'rgba(245, 158, 11, 0.3)';
    Icon = AlertTriangle;
    label = t('air_comfort.mold_elevated', { defaultValue: 'Elevated Risk' });
  }

  const padding = size === 'sm' ? '3px 8px' : '6px 12px';
  const fontSize = size === 'sm' ? '0.725rem' : '0.825rem';
  const iconSize = size === 'sm' ? 12 : 15;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        backgroundColor: bg,
        color: color,
        border: `1px solid ${borderColor}`,
        borderRadius: '9999px',
        padding: padding,
        fontSize: fontSize,
        fontWeight: 600,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.15s ease',
        userSelect: 'none',
        lineHeight: 1
      }}
      title={t('air_comfort.mold_tooltip', { defaultValue: 'Click to view mold risk diagnostics' })}
    >
      <Icon size={iconSize} />
      <span>{label}</span>
    </button>
  );
}
