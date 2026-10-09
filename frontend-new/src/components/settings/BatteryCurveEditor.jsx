/**
 * @file src/components/settings/BatteryCurveEditor.jsx
 * @brief Inline editor for custom battery discharge curves.
 * 
 * Shows a table of [mV, %] points with add/remove controls and a simple
 * SVG line chart preview. Validates min=2, max=20 points, sorted desc by mV.
 */

import { useState, useEffect, useMemo } from 'react';
import Button from '../common/Button';
import Card from '../common/Card';
import Toggle from '../common/Toggle';

/**
 * Simple SVG line chart of the discharge curve.
 */
function CurvePreview({ points }) {
  if (!points || points.length < 2) return null;

  const sorted = [...points].sort((a, b) => b[0] - a[0]);
  const minMv = sorted[sorted.length - 1][0];
  const maxMv = sorted[0][0];
  const width = 280;
  const height = 120;
  const pad = 24;

  const scaleX = (mv) => pad + ((maxMv - mv) / (maxMv - minMv || 1)) * (width - 2 * pad);
  const scaleY = (pct) => pad + ((100 - pct) / 100) * (height - 2 * pad);

  const pathD = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p[0]).toFixed(1)},${scaleY(p[1]).toFixed(1)}`).join(' ');

  return (
    <svg width={width} height={height} style={{ background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
      {/* Axes labels */}
      <text x={width / 2} y={height - 4} textAnchor="middle" fill="var(--text-secondary)" fontSize="9">mV →</text>
      <text x={6} y={height / 2} textAnchor="middle" fill="var(--text-secondary)" fontSize="9" transform={`rotate(-90, 6, ${height / 2})`}>%</text>
      {/* Grid lines */}
      {[0, 25, 50, 75, 100].map(pct => (
        <line key={pct} x1={pad} y1={scaleY(pct)} x2={width - pad} y2={scaleY(pct)} stroke="var(--border-color)" strokeWidth="0.5" strokeDasharray="2,2" />
      ))}
      {/* Curve */}
      <path d={pathD} fill="none" stroke="var(--primary)" strokeWidth="2" />
      {/* Points */}
      {sorted.map((p, i) => (
        <circle key={i} cx={scaleX(p[0])} cy={scaleY(p[1])} r="3" fill="var(--primary)" />
      ))}
    </svg>
  );
}

export default function BatteryCurveEditor({
  customCurve,
  defaultCurve,
  onSave,
  isSaving,
  isVA,
  motorErrorDetection,
  onMotorErrorToggle,
  t
}) {
  const [useCustom, setUseCustom] = useState(Boolean(customCurve && customCurve.length >= 2));
  const [points, setPoints] = useState(() => {
    if (customCurve && customCurve.length >= 2) return [...customCurve];
    if (defaultCurve && defaultCurve.length >= 2) return [...defaultCurve];
    return [[3000, 100], [2100, 0]];
  });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (customCurve && customCurve.length >= 2) {
      setPoints([...customCurve]);
      setUseCustom(true);
    }
  }, [customCurve]);

  const sortedPoints = useMemo(() => [...points].sort((a, b) => b[0] - a[0]), [points]);

  const updatePoint = (idx, field, value) => {
    const next = [...points];
    next[idx] = [...next[idx]];
    next[idx][field] = Number(value);
    setPoints(next);
    setDirty(true);
  };

  const addPoint = () => {
    if (points.length >= 20) return;
    // Insert midpoint between first two sorted points
    const s = sortedPoints;
    const newMv = Math.round((s[0][0] + s[s.length - 1][0]) / 2);
    const newPct = Math.round((s[0][1] + s[s.length - 1][1]) / 2);
    setPoints([...points, [newMv, newPct]]);
    setDirty(true);
  };

  const removePoint = (idx) => {
    if (points.length <= 2) return;
    setPoints(points.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const handleSave = () => {
    if (useCustom) {
      const sorted = [...points].sort((a, b) => b[0] - a[0]);
      onSave(sorted);
    } else {
      onSave(null); // clear custom curve
    }
    setDirty(false);
  };

  const handleResetToDefault = () => {
    if (defaultCurve && defaultCurve.length >= 2) {
      setPoints([...defaultCurve]);
      setDirty(true);
    }
  };

  const handleToggleCustom = (enabled) => {
    setUseCustom(enabled);
    if (enabled && (!points || points.length < 2)) {
      setPoints(defaultCurve && defaultCurve.length >= 2 ? [...defaultCurve] : [[3000, 100], [2100, 0]]);
    }
    setDirty(true);
  };

  return (
    <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>
        {t('settings.battery_curve_title', 'Battery Discharge Curve')}
      </h3>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
        {t('settings.battery_curve_desc', 'Customize the voltage-to-percentage mapping for this device. Default uses built-in curves for the selected battery chemistry.')}
      </p>

      {/* Custom curve toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
          {t('settings.use_custom_curve', 'Use Custom Discharge Curve')}
        </span>
        <Toggle checked={useCustom} onChange={handleToggleCustom} />
      </div>

      {useCustom && (
        <>
          {/* Curve preview */}
          <CurvePreview points={sortedPoints} />

          {/* Point editor table */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', padding: '0 0.25rem' }}>
              <span style={{ flex: 1 }}>{t('settings.voltage_mv', 'Voltage (mV)')}</span>
              <span style={{ flex: 1 }}>{t('settings.capacity_pct', 'Capacity (%)')}</span>
              <span style={{ width: '32px' }}></span>
            </div>
            {sortedPoints.map((point) => {
              const realIdx = points.indexOf(point);
              return (
                <div key={realIdx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="number"
                    value={point[0]}
                    onChange={(e) => updatePoint(realIdx, 0, e.target.value)}
                    style={{
                      flex: 1, backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)', padding: '0.35rem 0.5rem', borderRadius: 'var(--radius-sm)',
                      fontSize: '0.85rem', fontFamily: 'monospace'
                    }}
                  />
                  <input
                    type="number"
                    min="0" max="100"
                    value={point[1]}
                    onChange={(e) => updatePoint(realIdx, 1, e.target.value)}
                    style={{
                      flex: 1, backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)', padding: '0.35rem 0.5rem', borderRadius: 'var(--radius-sm)',
                      fontSize: '0.85rem', fontFamily: 'monospace'
                    }}
                  />
                  <button
                    onClick={() => removePoint(realIdx)}
                    disabled={points.length <= 2}
                    style={{
                      width: '32px', height: '32px', background: 'none', border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-sm)', color: points.length <= 2 ? 'var(--text-muted)' : 'var(--danger)',
                      cursor: points.length <= 2 ? 'not-allowed' : 'pointer', fontSize: '1rem', lineHeight: 1
                    }}
                  >×</button>
                </div>
              );
            })}
          </div>

          {/* Add / Reset / Save buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={addPoint} disabled={points.length >= 20}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}>
              + {t('settings.add_point', 'Add Point')} ({points.length}/20)
            </Button>
            <Button variant="secondary" onClick={handleResetToDefault}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}>
              {t('settings.reset_to_default', 'Reset to Default')}
            </Button>
          </div>
        </>
      )}

      {/* VA Motor Error Detection */}
      {isVA && (
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block' }}>
                {t('settings.motor_error_detection', 'Motor Error Low Battery Detection')}
              </span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                {t('settings.motor_error_detection_desc', 'Flag battery as LOW when 3 consecutive motor/calibration errors are reported. This can indicate insufficient power to depress the thermostatic valve pin.')}
              </span>
            </div>
            <Toggle checked={Boolean(motorErrorDetection)} onChange={onMotorErrorToggle} />
          </div>
        </div>
      )}

      {/* Save button */}
      {(dirty || useCustom !== Boolean(customCurve && customCurve.length >= 2)) && (
        <Button variant="primary" onClick={handleSave} disabled={isSaving}
          style={{ alignSelf: 'flex-end' }}>
          {isSaving ? t('settings.saving') : t('common.save')}
        </Button>
      )}
    </Card>
  );
}
