/**
 * @file test/test_unit_battery.test.js
 * @brief Vitest testing suite validating server modules.
 */

'use strict';

/**
 * Unit Tests for lib/battery.js
 *
 * Run: node ws-server/test/test_unit_battery.js
 */

const battery = require('../lib/battery');


test('legacy test suite runs successfully', async () => {
  let passed = 0;
  let failed = 0;

  function test(name, condition, detail = '') {
    if (condition) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function section(title) { console.log(`\n══ ${title} ══`); }

  // ═══════════════════════════════════════════
  // 1. inferCellsFromMv
  // ═══════════════════════════════════════════
  section('1. inferCellsFromMv');

  test('0mV = null', battery.inferCellsFromMv(0) === null);
  test('-1mV = null', battery.inferCellsFromMv(-1) === null);
  test('1500mV = 1 cell', battery.inferCellsFromMv(1500) === 1);
  test('2500mV = 2 cells (VA)', battery.inferCellsFromMv(2500) === 2);
  test('3000mV = 2 cells', battery.inferCellsFromMv(3000) === 2);
  test('3599mV = 2 cells', battery.inferCellsFromMv(3599) === 2);
  test('3600mV = 3 cells (RU)', battery.inferCellsFromMv(3600) === 3);
  test('4500mV = 3 cells', battery.inferCellsFromMv(4500) === 3);

  // ═══════════════════════════════════════════
  // 2. getBatteryPercent — VA device (2-cell, alkaline)
  // ═══════════════════════════════════════════
  section('2. VA device (2-cell alkaline)');

  // Full battery: 2 × 1.50V+ = 3000mV+ → 100%
  const va_full = battery.getBatteryPercent(3000, 'VA0123456789', 'alkaline');
  test('VA full (3000mV): 100%', va_full === 100);

  // Mid battery: 2 × 1.35V = 2700mV → ~70%
  const va_mid = battery.getBatteryPercent(2700, 'VA0123456789', 'alkaline');
  test('VA mid (2700mV): 50-80%', va_mid >= 50 && va_mid <= 80);

  // Low battery: 2 × 1.20V = 2400mV → ~20%
  const va_low = battery.getBatteryPercent(2400, 'VA0123456789', 'alkaline');
  test('VA low (2400mV): 10-30%', va_low >= 10 && va_low <= 30);

  // Empty battery: 2 × 1.05V = 2100mV → 0%
  const va_empty = battery.getBatteryPercent(2100, 'VA0123456789', 'alkaline');
  test('VA empty (2100mV): 0%', va_empty === 0);

  // ═══════════════════════════════════════════
  // 3. RU device (3-cell, alkaline)
  // ═══════════════════════════════════════════
  section('3. RU device (3-cell alkaline)');

  // Full: 3 × 1.50V+ = 4500mV+ → 100%
  const ru_full = battery.getBatteryPercent(4500, 'RU0123456789', 'alkaline');
  test('RU full (4500mV): 100%', ru_full === 100);

  // Mid: 3 × 1.35V = 4050mV → ~70%
  const ru_mid = battery.getBatteryPercent(4050, 'RU0123456789', 'alkaline');
  test('RU mid (4050mV): 50-80%', ru_mid >= 50 && ru_mid <= 80);

  // Low: 3 × 1.05V = 3150mV → 0%
  const ru_low = battery.getBatteryPercent(3150, 'RU0123456789', 'alkaline');
  test('RU low (3150mV): 0%', ru_low === 0);

  // ═══════════════════════════════════════════
  // 4. NiMH chemistry
  // ═══════════════════════════════════════════
  section('4. NiMH chemistry');

  // VA NiMH full: 2 × 1.45V = 2900mV → ~100%
  const nimh_full = battery.getBatteryPercent(2900, 'VA0123456789', 'nimh');
  test('VA NiMH full (2900mV): 100%', nimh_full === 100);

  // VA NiMH mid: 2 × 1.28V = 2560mV → ~50%
  const nimh_mid = battery.getBatteryPercent(2560, 'VA0123456789', 'nimh');
  test('VA NiMH mid (2560mV): 40-70%', nimh_mid >= 40 && nimh_mid <= 70);

  // VA NiMH low: 2 × 1.26V = 2520mV → ~10%
  const nimh_low = battery.getBatteryPercent(2520, 'VA0123456789', 'nimh');
  test('VA NiMH low (2520mV): 5-15%', nimh_low >= 5 && nimh_low <= 15);

  // VA NiMH empty: 2 × 1.05V = 2100mV → ~0%
  const nimh_empty = battery.getBatteryPercent(2100, 'VA0123456789', 'nimh');
  test('VA NiMH empty (2100mV): 0%', nimh_empty === 0);

  // ═══════════════════════════════════════════
  // 5. Edge cases
  // ═══════════════════════════════════════════
  section('5. Edge cases');

  // Null / zero
  test('null mV = null', battery.getBatteryPercent(null, 'VA001', 'alkaline') === null);
  test('0 mV = null', battery.getBatteryPercent(0, 'VA001', 'alkaline') === null);
  test('-100 mV = null', battery.getBatteryPercent(-100, 'VA001', 'alkaline') === null);

  // No device ID (auto-detect cells from voltage)
  const auto2 = battery.getBatteryPercent(2800, null, 'alkaline');
  test('Auto-detect 2-cell (2800mV): not null', auto2 !== null);
  test('Auto-detect 2-cell: reasonable %', auto2 >= 0 && auto2 <= 100);

  const auto3 = battery.getBatteryPercent(4200, null, 'alkaline');
  test('Auto-detect 3-cell (4200mV): not null', auto3 !== null);
  test('Auto-detect 3-cell: reasonable %', auto3 >= 0 && auto3 <= 100);

  // Default chemistry (null → alkaline)
  const def = battery.getBatteryPercent(2800, 'VA001', null);
  test('Default chemistry (null): uses alkaline', def !== null);

  // Unknown device prefix → auto-detect
  const unk = battery.getBatteryPercent(2600, 'XX0123456789', 'alkaline');
  test('Unknown prefix XX: auto-detects cells', unk !== null);

  // Result is always 0-100 integer
  test('Result clamped: max 100', battery.getBatteryPercent(9999, 'VA001', 'alkaline') === 100);
  const lowResult = battery.getBatteryPercent(1000, 'VA001', 'alkaline');
  test('Result clamped: min 0', lowResult === 0);

  // Various voltages produce monotonically decreasing percentages
  const voltages = [3300, 3100, 2900, 2700, 2500, 2300, 2200];
  const percentages = voltages.map(v => battery.getBatteryPercent(v, 'VA001', 'alkaline'));
  let monotonic = true;
  for (let i = 1; i < percentages.length; i++) {
    if (percentages[i] > percentages[i - 1]) {
      monotonic = false;
      break;
    }
  }
  test('Monotonically decreasing: higher V → higher %', monotonic);

  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  section('RESULTS');
  const total = passed + failed;
  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
  if (failed > 0) throw new Error('Some tests failed');

});

// ═══════════════════════════════════════════════════════════════════
// filterBatteryMv — voltage drop guard
// ═══════════════════════════════════════════════════════════════════

describe('filterBatteryMv — battery voltage drop guard', () => {
  beforeEach(() => {
    battery.resetBatteryGuardState();
  });

  test('first reading accepted as-is', () => {
    expect(battery.filterBatteryMv('RU001', 4192)).toBe(4192);
  });

  test('transient single drop suppressed (RU 3-cell, threshold 300mV)', () => {
    // Establish baseline
    battery.filterBatteryMv('RU001', 4192);
    // Single drop of 517 mV — should be suppressed
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4192);
    // Recovery — should accept immediately
    expect(battery.filterBatteryMv('RU001', 4179)).toBe(4179);
  });

  test('persistent drop accepted after 5 reports (RU)', () => {
    battery.filterBatteryMv('RU001', 4192);
    // Reports 1-4: suppressed
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4192);
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4192);
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4192);
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4192);
    // Report 5: accepted as genuine
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(3675);
  });

  test('voltage increase accepted immediately (battery replacement)', () => {
    battery.filterBatteryMv('RU001', 3675);
    // Fresh batteries — voltage jumps up
    expect(battery.filterBatteryMv('RU001', 4950)).toBe(4950);
  });

  test('gradual drain accepted immediately (drop < threshold)', () => {
    battery.filterBatteryMv('RU001', 4192);
    // 50 mV drop — well below 300 mV threshold for RU
    expect(battery.filterBatteryMv('RU001', 4142)).toBe(4142);
    // Another small drop
    expect(battery.filterBatteryMv('RU001', 4100)).toBe(4100);
  });

  test('VA device uses 200mV threshold (2-cell)', () => {
    battery.filterBatteryMv('VA001', 3000);
    // Drop of 250 mV — exceeds 200 mV threshold, should be suppressed
    expect(battery.filterBatteryMv('VA001', 2750)).toBe(3000);
    // Drop of 150 mV — below threshold, accepted immediately
    battery.resetBatteryGuardState('VA001');
    battery.filterBatteryMv('VA001', 3000);
    expect(battery.filterBatteryMv('VA001', 2850)).toBe(2850);
  });

  test('drop counter resets on recovery', () => {
    battery.filterBatteryMv('RU001', 4192);
    // 3 suppressed drops
    battery.filterBatteryMv('RU001', 3675);
    battery.filterBatteryMv('RU001', 3675);
    battery.filterBatteryMv('RU001', 3675);
    // Recovery resets counter
    battery.filterBatteryMv('RU001', 4185);
    // New drop — counter starts from 0 again
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4185);
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4185);
  });

  test('null and zero mV pass through unchanged', () => {
    expect(battery.filterBatteryMv('RU001', null)).toBe(null);
    expect(battery.filterBatteryMv('RU001', 0)).toBe(0);
  });

  test('custom requiredReports parameter', () => {
    battery.filterBatteryMv('RU001', 4192, 2);
    battery.filterBatteryMv('RU001', 3675, 2);
    // 2nd report should accept with requiredReports=2
    expect(battery.filterBatteryMv('RU001', 3675, 2)).toBe(3675);
  });

  test('per-device isolation', () => {
    battery.filterBatteryMv('RU001', 4192);
    battery.filterBatteryMv('RU002', 4200);
    // Drop on RU001 should not affect RU002
    battery.filterBatteryMv('RU001', 3675);
    expect(battery.filterBatteryMv('RU002', 4195)).toBe(4195);
  });

  test('resetBatteryGuardState clears specific device', () => {
    battery.filterBatteryMv('RU001', 4192);
    battery.resetBatteryGuardState('RU001');
    // After reset, next reading is treated as first — accepted as-is
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(3675);
  });

  test('resetBatteryGuardState() clears all', () => {
    battery.filterBatteryMv('RU001', 4192);
    battery.filterBatteryMv('RU002', 4200);
    battery.resetBatteryGuardState();
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(3675);
    expect(battery.filterBatteryMv('RU002', 3700)).toBe(3700);
  });
});