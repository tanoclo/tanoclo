/**
 * @file src/utils/validators.js
 * @brief Input format validation helpers.
 * 
 * Verifies email patterns and numeric temperature range boundaries.
 */

/**
 * Validates an email address
 * @param {string} email
 * @returns {boolean}
 */
export function validateEmail(email) {
  if (!email) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/**
 * Validates that a string is a number in range
 * @param {string|number} val
 * @param {number} min
 * @param {number} max
 * @returns {boolean}
 */
export function validateTemperatureRange(val, min = 5, max = 25) {
  const num = Number(val);
  return !isNaN(num) && num >= min && num <= max;
}
