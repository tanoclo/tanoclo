/**
 * @file test/test_zone_coordinator.test.js
 * @brief Unit tests for zone coordinator engine, observer registry, gating, and demand calculation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import zoneCoordinator from '../lib/zone-coordinator';
import tlv from '../lib/tlv';
import coap from '../lib/coap';

describe('Zone Coordinator Engine', () => {
    beforeEach(() => {
        zoneCoordinator.clearAll();
        tlv.init({
            '0x4060': { type: 's16be' },
            '0x40a0': { type: 'u8' },
            '0x4000': { type: 's16be' },
            '0x0135': { type: 'u16be' }
        });
    });

    describe('calculateZoneDemand', () => {
        it('returns 0 when heating is turned OFF', () => {
            expect(zoneCoordinator.calculateZoneDemand(18.0, 22.0, false)).toBe(0);
        });

        it('returns 0 when ambient temperature exceeds target setpoint', () => {
            expect(zoneCoordinator.calculateZoneDemand(22.5, 21.0, true)).toBe(0);
            expect(zoneCoordinator.calculateZoneDemand(21.0, 21.0, true)).toBe(0);
        });

        it('returns proportional demand within proportional band (1.5°C)', () => {
            // Error = 0.75°C on 1.5°C band -> 50%
            expect(zoneCoordinator.calculateZoneDemand(20.25, 21.0, true, 1.5)).toBe(50);
            // Error = 0.3°C on 1.5°C band -> 20%
            expect(zoneCoordinator.calculateZoneDemand(20.7, 21.0, true, 1.5)).toBe(20);
            // Error = 1.5°C on 1.5°C band -> 100%
            expect(zoneCoordinator.calculateZoneDemand(19.5, 21.0, true, 1.5)).toBe(100);
        });

        it('clamps demand between 0 and 100%', () => {
            // Very cold room: error = 5°C -> 100%
            expect(zoneCoordinator.calculateZoneDemand(15.0, 21.0, true, 1.5)).toBe(100);
            // Overheating room: error = -2°C -> 0%
            expect(zoneCoordinator.calculateZoneDemand(23.0, 21.0, true, 1.5)).toBe(0);
        });

        it('handles null or missing inputs safely', () => {
            expect(zoneCoordinator.calculateZoneDemand(null, 21.0)).toBe(0);
            expect(zoneCoordinator.calculateZoneDemand(20.0, null)).toBe(0);
            expect(zoneCoordinator.calculateZoneDemand(null, null)).toBe(0);
        });

        it('calculates demand using custom PID gains (Kp, Ki, Kd)', () => {
            const state = {};
            // Error = 1.0°C (100 raw) with default Kp=10.00 (1000), Ki=5.00 (500), Kd=15.00 (1500)
            // P = (1000 * 100) / 2000 = 50
            // I = (500 * 100) / 30000 = 1
            // D = 0 (first tick)
            const demand1 = zoneCoordinator.calculateZoneDemand(20.0, 21.0, true, { kp: 10.00, ki: 5.00, kd: 15.00 }, state);
            expect(demand1).toBe(51);
            expect(state.pidAccumulator).toBe(100);
            expect(state.pidPrevTempRaw).toBe(2000);

            // Dynamic derivative braking on fast temperature rise:
            // Temp rises from 20.0°C to 20.6°C (error decreases from 1.0°C to 0.4°C / 40 raw, delta = +60 raw)
            // P = (1000 * 40) / 2000 = 20
            // I = (500 * (100 + 40)) / 30000 = 2
            // D = (1500 * 60) / 2000 = 45
            // Demand = clamp(20 + 2 - 45, 0, 100) = 0
            const demand2 = zoneCoordinator.calculateZoneDemand(20.6, 21.0, true, { kp: 10.00, ki: 5.00, kd: 15.00 }, state);
            expect(demand2).toBe(0);
            expect(state.pidDState).toBe(45);
        });

        it('respects custom underfloor heating gains (lower Kp)', () => {
            const state = {};
            // Low Kp=4.00 (400 raw) for high thermal mass underfloor
            // For 1.0°C error: P = (400 * 100) / 2000 = 20
            const demand = zoneCoordinator.calculateZoneDemand(20.0, 21.0, true, { kp: 4.00, ki: 1.50, kd: 25.00 }, state);
            expect(demand).toBe(20);
        });
    });

    describe('shouldDispatchDownlink (Battery Preservation Gating)', () => {
        it('allows first push when lastPushedTs is null', () => {
            const state = { lastPushedTs: null, lastPushedTemp: null, lastPushedDemand: null };
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.0, 20)).toBe(true);
        });

        it('allows push when force flag is set', () => {
            const state = { lastPushedTs: Date.now(), lastPushedTemp: 21.0, lastPushedDemand: 20 };
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.05, 21, true)).toBe(true);
        });

        it('suppresses push for tiny temperature and demand fluctuations', () => {
            const now = Date.now();
            const state = { lastPushedTs: now - 30000, lastPushedTemp: 21.0, lastPushedDemand: 20 };
            // Temp delta 0.1°C (<0.2°C), demand delta 2% (<5%), elapsed 30s (<10m)
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.1, 22)).toBe(false);
        });

        it('triggers push when temperature changes by >= 0.2°C', () => {
            const now = Date.now();
            const state = { lastPushedTs: now - 30000, lastPushedTemp: 21.0, lastPushedDemand: 20 };
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.2, 20)).toBe(true);
            expect(zoneCoordinator.shouldDispatchDownlink(state, 20.8, 20)).toBe(true);
        });

        it('triggers push when demand changes by >= 5%', () => {
            const now = Date.now();
            const state = { lastPushedTs: now - 30000, lastPushedTemp: 21.0, lastPushedDemand: 20 };
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.05, 25)).toBe(true);
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.05, 15)).toBe(true);
        });

        it('triggers keepalive push when 10 minutes have elapsed', () => {
            const tenMinutesAgo = Date.now() - 600001;
            const state = { lastPushedTs: tenMinutesAgo, lastPushedTemp: 21.0, lastPushedDemand: 20 };
            // Even with identical temp and demand, keepalive triggers push
            expect(zoneCoordinator.shouldDispatchDownlink(state, 21.0, 20)).toBe(true);
        });
    });

    describe('buildZoneParamsTLV', () => {
        it('encodes temperature 0x4060, demand 0x40a0, target 0x4000, humidity 0x0135', () => {
            const buf = zoneCoordinator.buildZoneParamsTLV({
                temp: 21.54,
                demand: 45,
                targetTemp: 22.0,
                humidity: 55.2
            });

            expect(buf).toBeInstanceOf(Buffer);
            expect(buf.length).toBeGreaterThan(0);

            const decoded = tlv.decode(buf);
            expect(decoded.ok).toBe(true);

            // 0x4060 is scaled by 100 -> 2154
            expect(decoded.fields['0x4060']).toBe(2154);
            // 0x40a0 is unsigned 8-bit demand -> 45
            expect(decoded.fields['0x40a0']).toBe(45);
            // 0x4000 is target setpoint scaled by 100 -> 2200
            expect(decoded.fields['0x4000']).toBe(2200);
            // 0x0135 is humidity scaled by 100 -> 5520
            expect(decoded.fields['0x0135']).toBe(5520);
        });
    });

    describe('Observer Registry', () => {
        it('registers and retrieves observers per zone', () => {
            const token1 = Buffer.from([0xAA, 0xBB]);
            zoneCoordinator.registerObserver({
                homeId: 100,
                zoneId: 2,
                deviceSerial: 'VA1234567890',
                ipv6: 'fe80::1',
                udpPort: 5683,
                token: token1,
                ws: {}
            });

            const obs = zoneCoordinator.getObservers(100, 2);
            expect(obs).toHaveLength(1);
            expect(obs[0].deviceSerial).toBe('VA1234567890');
            expect(obs[0].token).toEqual(token1);
        });

        it('unregisters an observer cleanly', () => {
            zoneCoordinator.registerObserver({
                homeId: 100,
                zoneId: 2,
                deviceSerial: 'VA1234567890',
                ipv6: 'fe80::1',
                udpPort: 5683,
                token: Buffer.from([0x01]),
                ws: {}
            });

            expect(zoneCoordinator.getObservers(100, 2)).toHaveLength(1);
            zoneCoordinator.unregisterObserver(100, 2, 'VA1234567890');
            expect(zoneCoordinator.getObservers(100, 2)).toHaveLength(0);
        });
    });
});
