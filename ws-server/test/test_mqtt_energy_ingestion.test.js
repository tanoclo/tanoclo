/**
 * @file test/test_mqtt_energy_ingestion.test.js
 * @brief Unit tests for MQTT gas meter & tariff ingestion handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
const mqttCommands = require('../lib/mqtt-commands');
const gasEnergy = require('../lib/gas-energy-analyzer');

describe('MQTT Gas Energy Ingestion', () => {
    let mockPool;

    beforeEach(() => {
        mockPool = {
            execute: vi.fn().mockResolvedValue([{ insertId: 1 }])
        };
        const db = { getPool: () => mockPool };
        const mockMqttClient = {
            subscribe: vi.fn(),
            publish: vi.fn()
        };
        mqttCommands.init(mockMqttClient, db, null, null, null, null);
    });

    it('parses raw float string payload for gas meter reading', async () => {
        const spy = vi.spyOn(gasEnergy, 'recordGasMeterReading').mockResolvedValue({ id: 10, meterM3: 1234.56 });

        await mqttCommands.handleGasMeterPayload('tado/tanoclo/h/1/energy/gas_meter', '1234.56');

        expect(spy).toHaveBeenCalledWith(expect.anything(), 1, 1234.56, null, 'mqtt');
        spy.mockRestore();
    });

    it('parses JSON payload for gas meter reading', async () => {
        const spy = vi.spyOn(gasEnergy, 'recordGasMeterReading').mockResolvedValue({ id: 11, meterM3: 9876.54 });

        await mqttCommands.handleGasMeterPayload('tado/tanoclo/h/2/energy/gas_meter', JSON.stringify({ value: 9876.54 }));

        expect(spy).toHaveBeenCalledWith(expect.anything(), 2, 9876.54, null, 'mqtt');
        spy.mockRestore();
    });

    it('parses tariff updates and updates home_energy_settings', async () => {
        await mqttCommands.handleGasCostPayload('tado/tanoclo/h/1/energy/gas_cost_per_m3', '1.65');

        expect(mockPool.execute).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO home_energy_settings'),
            [1, 1.65]
        );
    });

    it('ignores negative or malformed payloads', async () => {
        const spy = vi.spyOn(gasEnergy, 'recordGasMeterReading');

        await mqttCommands.handleGasMeterPayload('tado/tanoclo/h/1/energy/gas_meter', '-10.5');
        await mqttCommands.handleGasMeterPayload('tado/tanoclo/h/1/energy/gas_meter', 'not-a-number');

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
