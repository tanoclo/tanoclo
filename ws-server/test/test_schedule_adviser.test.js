/**
 * @file test/test_schedule_adviser.test.js
 * @brief Unit tests for schedule advisory engine.
 */

'use strict';

import { describe, it, expect } from 'vitest';
const { evaluateScheduleAdvice } = require('../lib/schedule-adviser');

describe('Schedule Advisory Engine', () => {
    it('returns empty array on empty blocks', () => {
        expect(evaluateScheduleAdvice([])).toEqual([]);
        expect(evaluateScheduleAdvice(null)).toEqual([]);
    });

    it('flags deep setback on underfloor heating when drop > 2.0°C', () => {
        const blocks = [
            {
                start: '06:00',
                end: '22:00',
                setting: { power: 'ON', temperature: { celsius: 21.0 } }
            },
            {
                start: '22:00',
                end: '06:00',
                setting: { power: 'ON', temperature: { celsius: 17.0 } } // 4°C drop
            }
        ];

        const advice = evaluateScheduleAdvice(blocks, {
            heatingType: 'UNDERFLOOR',
            underfloorMass: 'SCREED',
            earlyStartEnabled: true
        });

        const deepSetback = advice.find(a => a.type === 'DEEP_SETBACK');
        expect(deepSetback).toBeDefined();
        expect(deepSetback.severity).toBe('WARNING');
        expect(deepSetback.message).toContain('temperature drop is 4°C');
    });

    it('does not flag deep setback on radiators for normal 4°C drop', () => {
        const blocks = [
            {
                start: '06:00',
                end: '22:00',
                setting: { power: 'ON', temperature: { celsius: 21.0 } }
            },
            {
                start: '22:00',
                end: '06:00',
                setting: { power: 'ON', temperature: { celsius: 17.0 } }
            }
        ];

        const advice = evaluateScheduleAdvice(blocks, {
            heatingType: 'RADIATOR',
            earlyStartEnabled: true
        });

        expect(advice).toEqual([]);
    });

    it('advises early start when disabled for underfloor heating', () => {
        const blocks = [
            {
                start: '07:00',
                end: '23:00',
                setting: { power: 'ON', temperature: { celsius: 20.5 } }
            },
            {
                start: '23:00',
                end: '07:00',
                setting: { power: 'ON', temperature: { celsius: 19.5 } }
            }
        ];

        const advice = evaluateScheduleAdvice(blocks, {
            heatingType: 'UNDERFLOOR',
            underfloorMass: 'SCREED',
            earlyStartEnabled: false
        });

        const earlyStart = advice.find(a => a.type === 'EARLY_START_ADVICE');
        expect(earlyStart).toBeDefined();
        expect(earlyStart.message).toContain('warm-up time');
    });
});
