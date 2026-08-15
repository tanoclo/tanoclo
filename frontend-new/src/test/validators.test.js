import { describe, it, expect } from 'vitest';
import { validateEmail, validateTemperatureRange } from '../utils/validators';

describe('validators', () => {
  describe('validateEmail', () => {
    it('returns false for empty inputs', () => {
      expect(validateEmail('')).toBe(false);
      expect(validateEmail(null)).toBe(false);
    });

    it('validates correct email formats', () => {
      expect(validateEmail('test@example.com')).toBe(true);
      expect(validateEmail('user.name+tag@sub.domain.co')).toBe(true);
    });

    it('rejects incorrect email formats', () => {
      expect(validateEmail('test')).toBe(false);
      expect(validateEmail('test@')).toBe(false);
      expect(validateEmail('@domain.com')).toBe(false);
      expect(validateEmail('test@domain')).toBe(false);
    });
  });

  describe('validateTemperatureRange', () => {
    it('validates standard boundaries', () => {
      // Default: min=5, max=25
      expect(validateTemperatureRange(20)).toBe(true);
      expect(validateTemperatureRange(5)).toBe(true);
      expect(validateTemperatureRange(25)).toBe(true);
      expect(validateTemperatureRange(4.9)).toBe(false);
      expect(validateTemperatureRange(25.1)).toBe(false);
    });

    it('handles numeric string inputs', () => {
      expect(validateTemperatureRange('20')).toBe(true);
      expect(validateTemperatureRange('5.5')).toBe(true);
      expect(validateTemperatureRange('abc')).toBe(false);
    });

    it('respects custom boundaries', () => {
      expect(validateTemperatureRange(10, 15, 30)).toBe(false);
      expect(validateTemperatureRange(20, 15, 30)).toBe(true);
    });
  });
});
