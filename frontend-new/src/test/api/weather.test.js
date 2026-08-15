import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import { getClimateQuality, getWeather } from '../../api/weather';

describe('api/weather.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getClimateQuality → GET', async () => {
    await getClimateQuality(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/climateQuality');
  });

  it('getWeather → GET', async () => {
    await getWeather(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/weather');
  });
});
