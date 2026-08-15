/**
 * @file src/utils/datetime.js
 * @brief Datetime manipulation utilities for timezone transformations, schedule boundaries,
 * and HH:MM formatting calculations.
 */

/**
 * Formats a date string as local time or custom format
 * @param {string|Date} dateVal
 * @returns {string}
 */
export function formatLocalTime(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Formats a date string as YYYY-MM-DD
 * @param {Date} [date]
 * @returns {string}
 */
export function formatDateISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Converts minutes past midnight to HH:MM format
 * @param {number} minutes
 * @returns {string}
 */
export function minutesToTimeString(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Converts HH:MM string to minutes past midnight
 * @param {string} timeStr
 * @returns {number}
 */
export function timeStringToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}
