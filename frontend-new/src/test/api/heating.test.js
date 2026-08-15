import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../api/client';
import {
  getSupplyTemperatureOptimization, updateSupplyTemperatureOptimization,
  getRunningTimes, updateHeatingCircuitDriver
} from '../../api/heating';

describe('api/heating.js', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({});
  });

  it('getSupplyTemperatureOptimization → GET', async () => {
    await getSupplyTemperatureOptimization(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/heatingCircuits/0/supplyTemperatureOptimization');
  });

  it('updateSupplyTemperatureOptimization → PUT', async () => {
    const settings = { maxSupplyTemp: 60 };
    await updateSupplyTemperatureOptimization(1, settings);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/heatingCircuits/0/supplyTemperatureOptimization', {
      method: 'PUT', body: settings
    });
  });

  it('getRunningTimes with all params builds query string', async () => {
    await getRunningTimes(1, { from: '2026-01-01', to: '2026-01-31', aggregate: 'day', summary_only: true });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v2/homes/1/runningTimes?from=2026-01-01&to=2026-01-31&aggregate=day&summary_only=true'
    );
  });

  it('getRunningTimes with no params omits query string', async () => {
    await getRunningTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/runningTimes');
  });

  it('getRunningTimes with partial params', async () => {
    await getRunningTimes(1, { from: '2026-01-01' });
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/runningTimes?from=2026-01-01');
  });

  it('updateHeatingCircuitDriver → PUT', async () => {
    await updateHeatingCircuitDriver(1, 0, 'SN001');
    expect(apiFetch).toHaveBeenCalledWith('/api/v2/homes/1/heatingCircuits/0/driverDevice', {
      method: 'PUT', body: { serialNo: 'SN001' }
    });
  });
});
