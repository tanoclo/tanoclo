/**
 * @file src/utils/pidPresets.js
 * @brief Thermodynamic size-based PID preset calculation for heating zones.
 * 
 * Provides physics-grounded instant PID presets (Kp, Ki, Kd) scaled by room floor area (m²)
 * and heat emitter type (Radiators vs Underfloor Heating with concrete screed or dry panels).
 */

/**
 * Predefined room size preset templates.
 */
export const ROOM_SIZE_PRESETS = [
  { labelKey: 'settings.room_size_small', defaultLabel: 'Small (~10 m²)', value: 10.0, tier: 'SMALL', descKey: 'settings.room_size_small_desc', defaultDesc: 'Bathrooms, hallways, box rooms' },
  { labelKey: 'settings.room_size_medium', defaultLabel: 'Medium (~20 m²)', value: 20.0, tier: 'MEDIUM', descKey: 'settings.room_size_medium_desc', defaultDesc: 'Standard bedrooms, kitchens, offices' },
  { labelKey: 'settings.room_size_large', defaultLabel: 'Large (~35 m²)', value: 35.0, tier: 'LARGE', descKey: 'settings.room_size_large_desc', defaultDesc: 'Living rooms, master bedrooms' },
  { labelKey: 'settings.room_size_xl', defaultLabel: 'Extra Large (~55 m²)', value: 55.0, tier: 'XL', descKey: 'settings.room_size_xl_desc', defaultDesc: 'Open plan living areas, lofts' }
];

/**
 * Calculates suggested PID gains based on floor area and heat emitter type.
 * 
 * @param {Object} params
 * @param {number|null} [params.roomSizeSqm=20] - Floor area in m²
 * @param {string} [params.heatingType='RADIATOR'] - 'RADIATOR' | 'UNDERFLOOR'
 * @param {string} [params.underfloorMass='SCREED'] - 'SCREED' | 'DRY_SYSTEM'
 * @returns {Object} { kp, ki, kd, tier, explanationKey, defaultExplanation }
 */
export function calculatePidPreset({ roomSizeSqm = 20, heatingType = 'RADIATOR', underfloorMass = 'SCREED' } = {}) {
  const size = typeof roomSizeSqm === 'number' && !isNaN(roomSizeSqm) && roomSizeSqm > 0 ? roomSizeSqm : 20.0;
  const isUfh = heatingType === 'UNDERFLOOR';
  const isDrySystem = isUfh && underfloorMass === 'DRY_SYSTEM';

  let tier;
  if (size < 15) {
    tier = 'SMALL';
  } else if (size <= 28) {
    tier = 'MEDIUM';
  } else if (size <= 45) {
    tier = 'LARGE';
  } else {
    tier = 'XL';
  }

  let kp, ki, kd;
  let explanationKey;
  let defaultExplanation;

  if (isUfh) {
    if (isDrySystem) {
      if (tier === 'SMALL') {
        kp = 5.00; ki = 2.00; kd = 24.00;
        explanationKey = 'settings.pid_explain_ufh_dry_small';
        defaultExplanation = 'Small room with dry underfloor panels: moderate proportional gain and heightened derivative damping prevent rapid overshoot.';
      } else if (tier === 'MEDIUM') {
        kp = 6.50; ki = 2.50; kd = 20.00;
        explanationKey = 'settings.pid_explain_ufh_dry_medium';
        defaultExplanation = 'Medium room with dry underfloor panels: balanced response tuned for standard panel response times (45–90m).';
      } else if (tier === 'LARGE') {
        kp = 8.00; ki = 3.00; kd = 16.00;
        explanationKey = 'settings.pid_explain_ufh_dry_large';
        defaultExplanation = 'Large room with dry underfloor panels: boosted proportional gain delivers sufficient thermal flow across extended floor runs.';
      } else {
        kp = 9.50; ki = 3.50; kd = 14.00;
        explanationKey = 'settings.pid_explain_ufh_dry_xl';
        defaultExplanation = 'Open-plan dry underfloor space: maximum radiant gain to counteract large air volume while maintaining stable integral tracking.';
      }
    } else {
      if (tier === 'SMALL') {
        kp = 3.00; ki = 1.00; kd = 32.00;
        explanationKey = 'settings.pid_explain_ufh_screed_small';
        defaultExplanation = 'Small room with concrete slab screed: conservative Kp and strong Kd derivative braking prevent massive slab thermal overshoot.';
      } else if (tier === 'MEDIUM') {
        kp = 4.00; ki = 1.50; kd = 25.00;
        explanationKey = 'settings.pid_explain_ufh_screed_medium';
        defaultExplanation = 'Standard screed slab underfloor heating: baseline gains tailored for 2–4h concrete thermal lag.';
      } else if (tier === 'LARGE') {
        kp = 4.80; ki = 1.80; kd = 22.00;
        explanationKey = 'settings.pid_explain_ufh_screed_large';
        defaultExplanation = 'Large screed zone: elevated Kp and Ki overcome heavy slab thermal inertia without causing surface temperature runaway.';
      } else {
        kp = 5.50; ki = 2.20; kd = 18.00;
        explanationKey = 'settings.pid_explain_ufh_screed_xl';
        defaultExplanation = 'Extra-large screed open space: sustained heat integration to overcome extensive thermal mass while damping oscillations.';
      }
    }
  } else {
    if (tier === 'SMALL') {
      kp = 7.50; ki = 4.00; kd = 20.00;
      explanationKey = 'settings.pid_explain_rad_small';
      defaultExplanation = 'Small room with radiator: low air volume heats fast. Reduced Kp softens valve surges; elevated Kd brakes heat early before overshoot.';
    } else if (tier === 'MEDIUM') {
      kp = 10.00; ki = 5.00; kd = 15.00;
      explanationKey = 'settings.pid_explain_rad_medium';
      defaultExplanation = 'Standard medium room with radiator: balanced factory baseline (10.00 / 5.00 / 15.00) providing stable equilibrium.';
    } else if (tier === 'LARGE') {
      kp = 13.50; ki = 6.00; kd = 12.00;
      explanationKey = 'settings.pid_explain_rad_large';
      defaultExplanation = 'Large room with radiators: higher thermal mass and air volume. Increased Kp opens valves wider; reduced Kd prevents sluggish response.';
    } else {
      kp = 16.50; ki = 7.50; kd = 10.00;
      explanationKey = 'settings.pid_explain_rad_xl';
      defaultExplanation = 'Extra-large / open-plan radiator space: high proportional and integral drive overcomes heavy thermal inertia without settling below target.';
    }
  }

  return {
    kp: Number(kp.toFixed(2)),
    ki: Number(ki.toFixed(2)),
    kd: Number(kd.toFixed(2)),
    tier,
    roomSizeSqm: size,
    heatingType,
    underfloorMass,
    explanationKey,
    defaultExplanation
  };
}
