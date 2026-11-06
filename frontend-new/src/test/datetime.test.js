import { describe, it, expect } from 'vitest';
import { formatLocalTime, parseTimestampToDate, formatDateISO, minutesToTimeString, timeStringToMinutes } from '../utils/datetime';

describe('datetime utils', () => {
  describe('parseTimestampToDate', () => {
    it('returns null for falsy input', () => {
      expect(parseTimestampToDate(null)).toBeNull();
      expect(parseTimestampToDate('')).toBeNull();
    });

    it('parses SQL UTC datetime string without timezone as UTC', () => {
      const d = parseTimestampToDate('2026-10-24 19:58:00');
      expect(d.toISOString()).toBe('2026-10-24T19:58:00.000Z');
    });

    it('parses ISO string with Z correctly', () => {
      const d = parseTimestampToDate('2026-10-24T19:58:00.000Z');
      expect(d.toISOString()).toBe('2026-10-24T19:58:00.000Z');
    });

    it('returns Date instances as-is', () => {
      const orig = new Date();
      expect(parseTimestampToDate(orig)).toBe(orig);
    });
  });

  describe('formatLocalTime', () => {
    it('returns empty string for falsy input', () => {
      expect(formatLocalTime(null)).toBe('');
      expect(formatLocalTime(undefined)).toBe('');
    });

    it('formats a date or timestamp to local time HH:MM', () => {
      const d = new Date('2026-07-13T12:34:56Z');
      const res = formatLocalTime(d);
      expect(res).toContain(':');
      expect(res.length).toBeGreaterThanOrEqual(4);
    });

    it('formats with specific timezone', () => {
      const resBerlin = formatLocalTime('2026-10-24 19:58:00', 'Europe/Berlin');
      expect(resBerlin).toBe('21:58');

      const resLondon = formatLocalTime('2026-10-24 19:58:00', 'Europe/London');
      expect(resLondon).toBe('20:58');

      const resUTC = formatLocalTime('2026-10-24 19:58:00', 'UTC');
      expect(resUTC).toBe('19:58');
    });

    it('supports includeSeconds parameter', () => {
      const res = formatLocalTime('2026-10-24 19:58:30', 'UTC', true);
      expect(res).toBe('19:58:30');
    });
  });

  describe('formatDateISO', () => {
    it('formats date as YYYY-MM-DD', () => {
      const d = new Date(2026, 6, 13); // July 13, 2026
      expect(formatDateISO(d)).toBe('2026-07-13');
    });

    it('defaults to current date', () => {
      const res = formatDateISO();
      expect(res).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('minutesToTimeString', () => {
    it('converts minutes to HH:MM format', () => {
      expect(minutesToTimeString(0)).toBe('00:00');
      expect(minutesToTimeString(60)).toBe('01:00');
      expect(minutesToTimeString(725)).toBe('12:05');
      expect(minutesToTimeString(1439)).toBe('23:59');
    });
  });

  describe('timeStringToMinutes', () => {
    it('returns 0 for empty or falsy inputs', () => {
      expect(timeStringToMinutes('')).toBe(0);
      expect(timeStringToMinutes(null)).toBe(0);
    });

    it('converts HH:MM string to minutes', () => {
      expect(timeStringToMinutes('00:00')).toBe(0);
      expect(timeStringToMinutes('01:00')).toBe(60);
      expect(timeStringToMinutes('12:05')).toBe(725);
      expect(timeStringToMinutes('23:59')).toBe(1439);
    });
  });
});
