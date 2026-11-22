import { useState } from 'react';
import useSWR from 'swr';
import Card from '../common/Card';
import { apiFetch } from '../../api/client';

export default function WeatherSourceSettings({ homeId }) {
  const url = `/api/v2/homes/${homeId}/weather-source`;
  const { data, error, mutate } = useSWR(homeId ? url : null, apiFetch, { refreshInterval: 30000 });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  async function changeSource(source) {
    setSaving(true);
    setSaveError('');
    try {
      await apiFetch(url, { method: 'PUT', body: JSON.stringify({ source }) });
      await mutate();
    } catch (err) { setSaveError(err.message || 'Could not save weather source.'); }
    finally { setSaving(false); }
  }
  return <Card style={{ padding: '1.25rem', display: 'grid', gap: '0.75rem' }}>
    <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Outdoor temperature source</h3>
    <label htmlFor="weather-source">Weather source</label>
    <select id="weather-source" value={data?.source || 'open_meteo'} disabled={!data || saving} onChange={event => changeSource(event.target.value)}>
      <option value="open_meteo">Open-Meteo (default)</option>
      <option value="mqtt">External sensor (MQTT)</option>
    </select>
    {data?.source === 'mqtt' ? <>
      <p style={{ margin: 0 }}>Publish a JSON temperature in °C to this topic:</p>
      <code style={{ overflowWrap: 'anywhere' }}>{data.mqttTopic}</code>
      <code>{'{"temperature": 5.2}'}</code>
      <p style={{ margin: 0 }}>Optionally include observed_at as an ISO 8601 timestamp to preserve the sensor’s observation time.</p>
      <p style={{ margin: 0 }}>Readings older than two hours are unavailable. There is no automatic fallback to Open-Meteo.</p>
    </> : <p style={{ margin: 0 }}>Uses the home coordinates. Requires internet access and the weather refresh job to be enabled.</p>}
    {data && <p role="status" style={{ margin: 0 }}>
      {!data.reading ? 'No reading received.' : data.stale ? 'Reading is stale.' : `${data.reading.outside_temp_celsius} °C`}
      {data.timestamp && ` · Last observation: ${new Date(data.timestamp).toLocaleString()}`}
    </p>}
    {(error || saveError) && <p role="alert">{saveError || 'Could not load weather source.'}</p>}
  </Card>;
}
