// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, test, expect } from 'vitest';
import WeatherSourceSettings from '../../components/settings/WeatherSourceSettings';
import { apiFetch } from '../../api/client';
vi.mock('../../api/client', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('swr', () => ({ default: () => ({ data: { source: 'mqtt', mqttTopic: 'tado/tanoclo/h/1/weather/telemetry', stale: false, reading: { outside_temp_celsius: 5.2 }, timestamp: '2026-11-22T12:00:00Z' }, mutate: vi.fn(async () => {}) }) }));
test('shows the selected input, topic and observation; saves source without submitting the home form', async () => {
    render(<WeatherSourceSettings homeId={1} />);
    expect(screen.getByLabelText('Weather source').value).toBe('mqtt');
    expect(screen.getByText('tado/tanoclo/h/1/weather/telemetry')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('5.2 °C');
    fireEvent.change(screen.getByLabelText('Weather source'), { target: { value: 'open_meteo' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/weather-source', { method: 'PUT', body: '{"source":"open_meteo"}' }));
});
