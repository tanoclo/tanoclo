import { describe, it, expect } from 'vitest';
import { celsiusToFahrenheit, fahrenheitToCelsius, formatTemperature } from '../utils/temperature';

describe('temperature utils', () => {
  describe('celsiusToFahrenheit', () => {
    it('handles null/undefined inputs', () => {
      expect(celsiusToFahrenheit(null)).toBeNull();
      expect(celsiusToFahrenheit(undefined)).toBeNull();
    });

    it('converts celsius to fahrenheit', () => {
      expect(celsiusToFahrenheit(0)).toBe(32);
      expect(celsiusToFahrenheit(100)).toBe(212);
      expect(celsiusToFahrenheit(-40)).toBe(-40);
      expect(celsiusToFahrenheit(20)).toBe(68);
    });
  });

  describe('fahrenheitToCelsius', () => {
    it('handles null/undefined inputs', () => {
      expect(fahrenheitToCelsius(null)).toBeNull();
      expect(fahrenheitToCelsius(undefined)).toBeNull();
    });

    it('converts fahrenheit to celsius', () => {
      expect(fahrenheitToCelsius(32)).toBe(0);
      expect(fahrenheitToCelsius(212)).toBe(100);
      expect(fahrenheitToCelsius(-40)).toBe(-40);
      expect(fahrenheitToCelsius(68)).toBe(20);
    });
  });

  describe('formatTemperature', () => {
    it('handles null/undefined inputs', () => {
      expect(formatTemperature(null)).toBe('--');
      expect(formatTemperature(undefined)).toBe('--');
    });

    it('formats CELSIUS with one decimal place by default', () => {
      expect(formatTemperature(21.5)).toBe('21.5°');
      expect(formatTemperature(21.52)).toBe('21.5°');
      expect(formatTemperature(21.55)).toBe('21.6°');
    });

    it('converts and rounds to nearest integer for FAHRENHEIT', () => {
      expect(formatTemperature(20, 'FAHRENHEIT')).toBe('68°');
      expect(formatTemperature(21.5, 'FAHRENHEIT')).toBe('71°');
    });

    it('can optionally exclude the degree unit symbol', () => {
      expect(formatTemperature(21.5, 'CELSIUS', false)).toBe('21.5');
      expect(formatTemperature(20, 'FAHRENHEIT', false)).toBe('68');
    });
  });
});
