/**
 * @file test/test_interface_modules.test.js
 * @brief Unit tests for Interface Module Family catalogue and supported telemetry filtering.
 */

import { describe, it, expect } from 'vitest';
const interfaceModules = require('../lib/interface-modules');

describe('Interface Module Family Catalogue', () => {
    it('correctly classifies OpenTherm (module 71)', () => {
        const info = interfaceModules.getInterfaceModuleInfo(71);
        expect(info.family).toBe('OPENTHERM');
        expect(info.familyName).toBe('OpenTherm');
        expect(info.isDigitalBus).toBe(true);
        expect(info.isOpenTherm).toBe(true);
        expect(info.isModulating).toBe(true);
        expect(info.isRelay).toBe(false);
    });

    it('correctly classifies Analog Relay modules (3, 10, 11, etc.)', () => {
        for (const id of [3, 10, 11, 12, 30, 40, 42, 60, 61]) {
            const info = interfaceModules.getInterfaceModuleInfo(id);
            expect(info.family).toBe('ANALOG_RELAY');
            expect(info.familyName).toBe('Analog (On/Off Relay)');
            expect(info.isDigitalBus).toBe(false);
            expect(info.isOpenTherm).toBe(false);
            expect(info.isModulating).toBe(false);
            expect(info.isRelay).toBe(true);
        }
    });

    it('correctly classifies digital modulating bus families (eBus, EMS, KM, BSB, SCOM, HT)', () => {
        expect(interfaceModules.getInterfaceModuleInfo(120).family).toBe('EMS');
        expect(interfaceModules.getInterfaceModuleInfo(120).isModulating).toBe(true);
        expect(interfaceModules.getInterfaceModuleInfo(1).family).toBe('EBUS_A');
        expect(interfaceModules.getInterfaceModuleInfo(121).family).toBe('EBUS_B');
        expect(interfaceModules.getInterfaceModuleInfo(122).family).toBe('EBUS_C');
        expect(interfaceModules.getInterfaceModuleInfo(20).family).toBe('KM');
        expect(interfaceModules.getInterfaceModuleInfo(41).family).toBe('HT_BUS');
        expect(interfaceModules.getInterfaceModuleInfo(100).family).toBe('BSB');
        expect(interfaceModules.getInterfaceModuleInfo(31).family).toBe('SCOM');
    });

    it('correctly classifies wireless sensor (200) and valve (112)', () => {
        const ws = interfaceModules.getInterfaceModuleInfo(200);
        expect(ws.family).toBe('WIRELESS_SENSOR');
        expect(ws.isModulating).toBe(false);

        const valve = interfaceModules.getInterfaceModuleInfo(112);
        expect(valve.family).toBe('VALVE');
        expect(valve.isModulating).toBe(false);
    });

    it('handles null, undefined, or unconfigured gracefully', () => {
        const infoNull = interfaceModules.getInterfaceModuleInfo(null);
        expect(infoNull.family).toBe('GENERIC');
        expect(infoNull.isModulating).toBe(false);

        const infoUndef = interfaceModules.getInterfaceModuleInfo(undefined);
        expect(infoUndef.family).toBe('GENERIC');

        const infoUnknown = interfaceModules.getInterfaceModuleInfo(9999);
        expect(infoUnknown.family).toBe('GENERIC');
    });

    describe('computeSupportedMetrics', () => {
        it('includes valid non-sentinel telemetry for OpenTherm', () => {
            const hvacRow = {
                field_044c: 65.5,
                field_044d: 52.0,
                field_0450: 68.0,
                field_0452: 45,
                field_0457: 1,
                field_0462: 1.8,
                field_0463: 1200,
                // Flue temp is sentinel 65535 (unsupported by physical boiler)
                field_044e: 65535,
                // Return temp sentinel 4294967295
                field_0464: 4294967295
            };

            const supported = interfaceModules.computeSupportedMetrics(71, hvacRow);
            expect(supported).toContain('flowTemperature');
            expect(supported).toContain('returnTemperature');
            expect(supported).toContain('controlSetpoint');
            expect(supported).toContain('modulationPercentage');
            expect(supported).toContain('flameActive');
            expect(supported).toContain('waterPressureBar');
            expect(supported).toContain('burnerStarts');

            // Sentinels should be excluded
            expect(supported).not.toContain('exhaustTemperature');
            expect(supported).not.toContain('dhwBurnerStarts');
        });

        it('restricts Analog Relay to relay metrics and excludes digital FIDs even if columns have old data', () => {
            const hvacRow = {
                field_044c: 65.5, // stale or old digital reading
                field_0457: 1,
                field_0462: 1.8
            };

            const supported = interfaceModules.computeSupportedMetrics(3, hvacRow);
            // Analog Relay does NOT have flowTemperature or waterPressureBar in potential metrics
            expect(supported).not.toContain('flowTemperature');
            expect(supported).not.toContain('waterPressureBar');
            expect(supported).toContain('flameActive');
            expect(supported).toContain('operatingMode');
            expect(supported).toContain('circuitDemand');
        });
    });
});
