/**
 * @file src/utils/temperature.js
 * @brief Temperature unit conversion and localized text formatting helpers.
 */

/**
 * Converts Celsius to Fahrenheit
 * @param {number} celsius
 * @returns {number}
 */
export function celsiusToFahrenheit(celsius) {
  if (celsius == null) return null;
  return (celsius * 9) / 5 + 32;
}

/**
 * Converts Fahrenheit to Celsius
 * @param {number} fahrenheit
 * @returns {number}
 */
export function fahrenheitToCelsius(fahrenheit) {
  if (fahrenheit == null) return null;
  return ((fahrenheit - 32) * 5) / 9;
}

/**
 * Formats temperature value with optional unit
 * @param {number} tempValue
 * @param {string} unit - 'CELSIUS' or 'FAHRENHEIT'
 * @param {boolean} includeUnit
 * @returns {string}
 */
export function formatTemperature(tempValue, unit = 'CELSIUS', includeUnit = true) {
  if (tempValue == null) return '--';
  const val = unit === 'FAHRENHEIT' ? celsiusToFahrenheit(tempValue) : tempValue;
  const formatted = unit === 'FAHRENHEIT' ? Math.round(val).toString() : val.toFixed(1);
  return includeUnit ? `${formatted}°` : formatted;
}
