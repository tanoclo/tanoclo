import { useState } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import Badge from '../common/Badge';
import { apiFetch } from '../../api/client';
import { CloudSun, Radio, Check, Copy, AlertCircle, Clock } from 'lucide-react';

export default function WeatherSourceSettings({ homeId, t: propT }) {
  const t = propT || ((k, opts) => (typeof opts === 'object' && opts?.defaultValue ? opts.defaultValue : (typeof opts === 'string' ? opts : k)));
  const url = `/api/v2/homes/${homeId}/weather-source`;
  const { data, error, mutate } = useSWR(homeId ? url : null, apiFetch, { refreshInterval: 30000 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [copiedTopic, setCopiedTopic] = useState(false);

  async function changeSource(source) {
    setSaving(true);
    setSaveError('');
    try {
      await apiFetch(url, { method: 'PUT', body: JSON.stringify({ source }) });
      await mutate();
    } catch (err) {
      setSaveError(err.message || t('settings.weather_source_save_error', { defaultValue: 'Could not save weather source.' }));
    } finally {
      setSaving(false);
    }
  }

  const handleCopyTopic = (topic) => {
    if (!topic) return;
    navigator.clipboard?.writeText(topic).then(() => {
      setCopiedTopic(true);
      setTimeout(() => setCopiedTopic(false), 2000);
    }).catch(() => {});
  };

  return (
    <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            backgroundColor: 'var(--primary-glow, rgba(0, 180, 216, 0.15))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--primary, #00b4d8)',
            flexShrink: 0
          }}>
            <CloudSun size={20} />
          </div>
          <div>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              {t('settings.weather_source_title', { defaultValue: 'Outdoor Temperature & Weather' })}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '2px 0 0 0' }}>
              {t('settings.weather_source_desc', { defaultValue: 'Source for ambient outside temperature used in flow optimization and mold risk detection.' })}
            </p>
          </div>
        </div>

        {saving && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <Clock size={12} className="spin" />
            {t('common.saving', { defaultValue: 'Saving...' })}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <label htmlFor="weather-source" style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
          {t('settings.weather_source_label', { defaultValue: 'Weather source' })}
        </label>
        <select
          id="weather-source"
          value={data?.source || 'open_meteo'}
          disabled={!data || saving}
          onChange={(event) => changeSource(event.target.value)}
          style={{
            backgroundColor: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '0.5rem 0.75rem',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            fontWeight: 600,
            cursor: !data || saving ? 'not-allowed' : 'pointer',
            width: '100%',
            boxSizing: 'border-box',
            fontSize: '0.875rem'
          }}
        >
          <option value="open_meteo">
            {t('settings.weather_source_open_meteo', { defaultValue: 'Open-Meteo (default)' })}
          </option>
          <option value="mqtt">
            {t('settings.weather_source_mqtt', { defaultValue: 'External sensor (MQTT)' })}
          </option>
        </select>
      </div>

      {data?.source === 'mqtt' ? (
        <div style={{
          backgroundColor: 'var(--bg-tertiary, rgba(255, 255, 255, 0.03))',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-sm, 6px)',
          padding: '0.875rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.625rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary, #00b4d8)' }}>
            <Radio size={16} />
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              {t('settings.mqtt_instructions_title', { defaultValue: 'MQTT Telemetry Configuration' })}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
              {t('settings.mqtt_topic_label', { defaultValue: 'Publish a JSON temperature in °C to this topic:' })}
            </span>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.4rem 0.65rem',
              gap: '0.5rem'
            }}>
              <code style={{
                fontFamily: 'monospace',
                fontSize: '0.825rem',
                color: 'var(--primary, #00b4d8)',
                overflowWrap: 'anywhere'
              }}>
                {data.mqttTopic}
              </code>
              <button
                type="button"
                onClick={() => handleCopyTopic(data.mqttTopic)}
                title={copiedTopic ? 'Copied' : 'Copy topic'}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: copiedTopic ? 'var(--success)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0
                }}
              >
                {copiedTopic ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
              {t('settings.mqtt_sample_payload', { defaultValue: 'Payload format:' })}
            </span>
            <div style={{
              backgroundColor: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.4rem 0.65rem'
            }}>
              <code style={{ fontFamily: 'monospace', fontSize: '0.825rem', color: 'var(--text-primary)' }}>
                {'{"temperature": 5.2}'}
              </code>
            </div>
          </div>

          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t('settings.mqtt_optional_fields', { defaultValue: 'Optional fields: condition (for example, cloudy), solar_radiation (W/m²), aqi (US AQI), pollen, and forecast. Include observed_at as an ISO 8601 timestamp to preserve the sensor’s observation time.' })}
          </p>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t('settings.mqtt_reading_limits', { defaultValue: 'Readings older than two hours are unavailable. There is no automatic fallback to Open-Meteo.' })}
          </p>
        </div>
      ) : (
        <div style={{
          backgroundColor: 'var(--bg-tertiary, rgba(255, 255, 255, 0.03))',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-sm, 6px)',
          padding: '0.75rem 1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem'
        }}>
          <CloudSun size={18} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
            {t('settings.open_meteo_desc', { defaultValue: 'Uses the home coordinates. Requires internet access and the weather refresh job to be enabled.' })}
          </p>
        </div>
      )}

      {data && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.75rem',
            padding: '0.625rem 0.875rem',
            backgroundColor: 'var(--bg-tertiary, rgba(255, 255, 255, 0.02))',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm, 6px)',
            fontSize: '0.85rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <Badge variant={!data.reading ? 'secondary' : data.stale ? 'warning' : 'success'}>
              {!data.reading
                ? t('common.no_reading', { defaultValue: 'No reading' })
                : data.stale
                  ? t('common.stale', { defaultValue: 'Stale' })
                  : t('common.live', { defaultValue: 'Live' })}
            </Badge>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              {!data.reading
                ? t('settings.no_reading_received', { defaultValue: 'No reading received.' })
                : data.stale
                  ? t('settings.reading_is_stale', { defaultValue: 'Reading is stale.' })
                  : `${data.reading.outside_temp_celsius} °C`}
            </span>
            {data.reading?.weather_state && data.reading.weather_state !== 'UNKNOWN' && (
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                · {data.reading.weather_state}
              </span>
            )}
          </div>

          {data.timestamp && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Clock size={12} />
              <span>
                {t('settings.last_observation', { defaultValue: 'Last observation:' })}{' '}
                {new Date(data.timestamp).toLocaleString()}
              </span>
            </span>
          )}
        </div>
      )}

      {(error || saveError) && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            backgroundColor: 'var(--danger-glow, rgba(239, 68, 68, 0.15))',
            border: '1px solid hsla(0, 75%, 55%, 0.3)',
            color: 'var(--danger, #ef4444)',
            padding: '0.5rem 0.75rem',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.8rem'
          }}
        >
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <span>{saveError || (error?.message || t('settings.weather_source_load_error', { defaultValue: 'Could not load weather source.' }))}</span>
        </div>
      )}
    </Card>
  );
}
