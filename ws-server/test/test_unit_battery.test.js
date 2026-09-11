/**
 * @file test/test_unit_battery.test.js
 * @brief Vitest testing suite validating server battery modules and state downgrade guards.
 */

'use strict';

const battery = require('../lib/battery');

test('battery discharge curves and percentage calculations', () => {
  let passed = 0;
  let failed = 0;

  function test(name, condition, detail = '') {
    if (condition) { passed++; }
    else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  }

  // 1. inferCellsFromMv
  test('0mV = null', battery.inferCellsFromMv(0) === null);
  test('-1mV = null', battery.inferCellsFromMv(-1) === null);
  test('1500mV = 1 cell', battery.inferCellsFromMv(1500) === 1);
  test('2500mV = 2 cells (VA)', battery.inferCellsFromMv(2500) === 2);
  test('3000mV = 2 cells', battery.inferCellsFromMv(3000) === 2);
  test('3599mV = 2 cells', battery.inferCellsFromMv(3599) === 2);
  test('3600mV = 3 cells (RU)', battery.inferCellsFromMv(3600) === 3);
  test('4500mV = 3 cells', battery.inferCellsFromMv(4500) === 3);

  // 2. VA Alkaline (2-cell)
  test('VA full (3000mV): 100%', battery.getBatteryPercent(3000, 'VA0123456789', 'alkaline') === 100);
  test('VA mid (2700mV): 68%', battery.getBatteryPercent(2700, 'VA0123456789', 'alkaline') === 68);
  test('VA low threshold (2400mV): 25%', battery.getBatteryPercent(2400, 'VA0123456789', 'alkaline') === 25);
  test('VA critical threshold (2200mV): 5%', battery.getBatteryPercent(2200, 'VA0123456789', 'alkaline') === 5);
  test('VA empty (2100mV): 0%', battery.getBatteryPercent(2100, 'VA0123456789', 'alkaline') === 0);

  // 3. RU Alkaline (3-cell)
  test('RU full (4500mV): 100%', battery.getBatteryPercent(4500, 'RU0123456789', 'alkaline') === 100);
  test('RU mid (3900mV): 60%', battery.getBatteryPercent(3900, 'RU0123456789', 'alkaline') === 60);
  test('RU low threshold (3480mV): 25%', battery.getBatteryPercent(3480, 'RU0123456789', 'alkaline') === 25);
  test('RU critical threshold (3000mV): 5%', battery.getBatteryPercent(3000, 'RU0123456789', 'alkaline') === 5);
  test('RU empty (2850mV): 0%', battery.getBatteryPercent(2850, 'RU0123456789', 'alkaline') === 0);

  // 4. VA NiMH (2-cell)
  test('VA NiMH full (2700mV): 100%', battery.getBatteryPercent(2700, 'VA0123456789', 'nimh') === 100);
  test('VA NiMH working plateau (2560mV): 85%', battery.getBatteryPercent(2560, 'VA0123456789', 'nimh') === 85);
  test('VA NiMH mid plateau (2480mV): 60%', battery.getBatteryPercent(2480, 'VA0123456789', 'nimh') === 60);
  test('VA NiMH knee (2360mV): 20%', battery.getBatteryPercent(2360, 'VA0123456789', 'nimh') === 20);
  test('VA NiMH critical (2200mV): 5%', battery.getBatteryPercent(2200, 'VA0123456789', 'nimh') === 5);
  test('VA NiMH empty (2100mV): 0%', battery.getBatteryPercent(2100, 'VA0123456789', 'nimh') === 0);

  // 5. RU NiMH (3-cell)
  test('RU NiMH full (4050mV): 100%', battery.getBatteryPercent(4050, 'RU0123456789', 'nimh') === 100);
  test('RU NiMH working plateau (3840mV): 85%', battery.getBatteryPercent(3840, 'RU0123456789', 'nimh') === 85);
  test('RU NiMH mid plateau (3720mV): 60%', battery.getBatteryPercent(3720, 'RU0123456789', 'nimh') === 60);
  test('RU NiMH knee (3540mV): 20%', battery.getBatteryPercent(3540, 'RU0123456789', 'nimh') === 20);
  test('RU NiMH critical (3300mV): 5%', battery.getBatteryPercent(3300, 'RU0123456789', 'nimh') === 5);
  test('RU NiMH empty (3000mV): 0%', battery.getBatteryPercent(3000, 'RU0123456789', 'nimh') === 0);

  // 6. Monotonicity checks
  for (const [prefix, chem] of [['VA01', 'alkaline'], ['VA01', 'nimh'], ['RU01', 'alkaline'], ['RU01', 'nimh']]) {
    let prev = 101;
    for (let mv = (prefix.startsWith('RU') ? 4600 : 3100); mv >= (prefix.startsWith('RU') ? 2800 : 2000); mv -= 50) {
      const p = battery.getBatteryPercent(mv, prefix, chem);
      test(`Monotonic ${prefix} ${chem} at ${mv}mV`, p <= prev);
      prev = p;
    }
  }

  // 7. Edge cases
  test('null mV = null', battery.getBatteryPercent(null, 'VA001', 'alkaline') === null);
  test('0 mV = null', battery.getBatteryPercent(0, 'VA001', 'alkaline') === null);
  test('-100 mV = null', battery.getBatteryPercent(-100, 'VA001', 'alkaline') === null);
  test('Result clamped: max 100', battery.getBatteryPercent(9999, 'VA001', 'alkaline') === 100);
  test('Result clamped: min 0', battery.getBatteryPercent(1000, 'VA001', 'alkaline') === 0);

  if (failed > 0) throw new Error(`${failed} tests failed`);
});

describe('classifyBatteryState', () => {
  test('percent > 30 is NORMAL', () => {
    expect(battery.classifyBatteryState(100)).toBe('NORMAL');
    expect(battery.classifyBatteryState(31)).toBe('NORMAL');
  });

  test('percent between 6 and 30 is LOW', () => {
    expect(battery.classifyBatteryState(30)).toBe('LOW');
    expect(battery.classifyBatteryState(15)).toBe('LOW');
    expect(battery.classifyBatteryState(6)).toBe('LOW');
  });

  test('percent <= 5 is CRITICAL', () => {
    expect(battery.classifyBatteryState(5)).toBe('CRITICAL');
    expect(battery.classifyBatteryState(1)).toBe('CRITICAL');
    expect(battery.classifyBatteryState(0)).toBe('CRITICAL');
  });

  test('null percent defaults to NORMAL', () => {
    expect(battery.classifyBatteryState(null)).toBe('NORMAL');
  });
});

describe('processBatteryReading — state downgrade guard and voltage drop guard', () => {
  beforeEach(() => {
    battery.resetBatteryGuardState();
  });

  test('initial reading establishes confirmed baseline', () => {
    const res = battery.processBatteryReading('VA001', 2800, 'alkaline');
    expect(res.mv).toBe(2800);
    expect(res.percent).toBe(80);
    expect(res.batteryState).toBe('NORMAL');
    expect(res.guarded).toBe(false);
  });

  test('NORMAL -> LOW requires 5 consecutive reports', () => {
    // Baseline: 2450mV -> ~32% (NORMAL)
    battery.processBatteryReading('VA001', 2450, 'alkaline');

    // Candidate drop to 2380mV -> ~22% (LOW)
    // Reports 1-4: state downgrade must be SUPPRESSED, holding confirmed percent and state
    for (let i = 1; i <= 4; i++) {
      const res = battery.processBatteryReading('VA001', 2380, 'alkaline');
      expect(res.batteryState).toBe('NORMAL');
      expect(res.percent).toBe(33);
      expect(res.mv).toBe(2450);
      expect(res.guarded).toBe(true);
    }

    // Report 5: accepted genuine downgrade to LOW
    const res5 = battery.processBatteryReading('VA001', 2380, 'alkaline');
    expect(res5.batteryState).toBe('LOW');
    expect(res5.percent).toBe(22);
    expect(res5.mv).toBe(2380);
    expect(res5.guarded).toBe(false);
  });

  test('LOW -> CRITICAL requires 5 consecutive reports', () => {
    // Establish confirmed LOW baseline with 5 reports at 2380mV (~22%)
    for (let i = 0; i < 5; i++) {
      battery.processBatteryReading('VA001', 2380, 'alkaline');
    }

    // Candidate drops to 2180mV -> ~4% (CRITICAL)
    for (let i = 1; i <= 4; i++) {
      const res = battery.processBatteryReading('VA001', 2180, 'alkaline');
      expect(res.batteryState).toBe('LOW');
      expect(res.percent).toBe(22);
      expect(res.guarded).toBe(true);
    }

    // Report 5: accepted as CRITICAL
    const res5 = battery.processBatteryReading('VA001', 2180, 'alkaline');
    expect(res5.batteryState).toBe('CRITICAL');
    expect(res5.percent).toBe(4);
    expect(res5.guarded).toBe(false);
  });

  test('NORMAL -> CRITICAL directly requires 5 consecutive reports', () => {
    // Establish NORMAL baseline: 2700mV (68%)
    battery.processBatteryReading('VA001', 2700, 'alkaline');

    // Extreme drop to 2150mV (2%, CRITICAL)
    for (let i = 1; i <= 4; i++) {
      const res = battery.processBatteryReading('VA001', 2150, 'alkaline');
      expect(res.batteryState).toBe('NORMAL');
      expect(res.percent).toBe(68);
      expect(res.guarded).toBe(true);
    }

    // Report 5: confirmed CRITICAL
    const res5 = battery.processBatteryReading('VA001', 2150, 'alkaline');
    expect(res5.batteryState).toBe('CRITICAL');
    expect(res5.percent).toBe(3);
    expect(res5.guarded).toBe(false);
  });

  test('downgrade counter resets when voltage recovers before 5 reports', () => {
    // Baseline: 2450mV (NORMAL, 32%)
    battery.processBatteryReading('VA001', 2450, 'alkaline');

    // 3 reports in LOW territory
    battery.processBatteryReading('VA001', 2380, 'alkaline');
    battery.processBatteryReading('VA001', 2380, 'alkaline');
    battery.processBatteryReading('VA001', 2380, 'alkaline');

    // Recovery back to NORMAL territory: 2460mV (34%)
    const rec = battery.processBatteryReading('VA001', 2460, 'alkaline');
    expect(rec.batteryState).toBe('NORMAL');
    expect(rec.percent).toBe(34);
    expect(rec.guarded).toBe(false);

    // Subsequent drop should start counting from 1 again (not trigger on 2nd)
    const dropAgain = battery.processBatteryReading('VA001', 2380, 'alkaline');
    expect(dropAgain.batteryState).toBe('NORMAL');
    expect(dropAgain.percent).toBe(34);
    expect(dropAgain.guarded).toBe(true);
  });

  test('battery replacement (upgrade) accepted immediately on first report', () => {
    // Device was at LOW
    for (let i = 0; i < 5; i++) {
      battery.processBatteryReading('VA001', 2380, 'alkaline');
    }

    // User puts in fresh batteries: 3000mV (100%, NORMAL)
    const fresh = battery.processBatteryReading('VA001', 3000, 'alkaline');
    expect(fresh.batteryState).toBe('NORMAL');
    expect(fresh.percent).toBe(100);
    expect(fresh.mv).toBe(3000);
    expect(fresh.guarded).toBe(false);
  });

  test('custom requiredReports option works', () => {
    battery.processBatteryReading('VA001', 2450, 'alkaline');

    // With requiredReports = 3
    battery.processBatteryReading('VA001', 2380, 'alkaline', { requiredReports: 3 });
    battery.processBatteryReading('VA001', 2380, 'alkaline', { requiredReports: 3 });
    const res3 = battery.processBatteryReading('VA001', 2380, 'alkaline', { requiredReports: 3 });
    expect(res3.batteryState).toBe('LOW');
    expect(res3.percent).toBe(22);
  });
});

describe('filterBatteryMv and seedBatteryGuardState compatibility', () => {
  beforeEach(() => {
    battery.resetBatteryGuardState();
  });

  test('filterBatteryMv suppresses single large drop', () => {
    battery.filterBatteryMv('RU001', 4192);
    expect(battery.filterBatteryMv('RU001', 3675)).toBe(4192);
    expect(battery.filterBatteryMv('RU001', 4179)).toBe(4179);
  });

  test('seedBatteryGuardState initializes confirmed state and percent', () => {
    battery.seedBatteryGuardState([
      { device_serial: 'RU001', field_0162: 4200, battery_state: 'NORMAL', battery_percent: 80 },
      { serial_no: 'VA001', battery_mv: 2380, battery_state: 'LOW', battery_percent: 22 }
    ]);

    // Single large drop on RU001 suppressed
    const resRU = battery.processBatteryReading('RU001', 3500, 'alkaline');
    expect(resRU.batteryState).toBe('NORMAL');
    expect(resRU.percent).toBe(80);

    // VA001 already seeded as LOW; single drop to CRITICAL suppressed
    const resVA = battery.processBatteryReading('VA001', 2150, 'alkaline');
    expect(resVA.batteryState).toBe('LOW');
    expect(resVA.percent).toBe(22);
  });
});