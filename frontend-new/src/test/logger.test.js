import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('utils/logger.js', () => {
  let logger;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    const mod = await import('../utils/logger');
    logger = mod.default;
  });

  it('default level is DEBUG in dev environment', () => {
    expect(logger.getLevel()).toBe('DEBUG');
  });

  it('debug() calls console.debug with prefix', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('test message');
    expect(spy).toHaveBeenCalledWith('[DEBUG]', 'test message');
    spy.mockRestore();
  });

  it('info() calls console.info with prefix', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('info msg');
    expect(spy).toHaveBeenCalledWith('[INFO]', 'info msg');
    spy.mockRestore();
  });

  it('warn() calls console.warn with prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('warn msg');
    expect(spy).toHaveBeenCalledWith('[WARN]', 'warn msg');
    spy.mockRestore();
  });

  it('error() calls console.error with prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('err msg');
    expect(spy).toHaveBeenCalledWith('[ERROR]', 'err msg');
    spy.mockRestore();
  });

  it('setLevel(ERROR) suppresses debug/info/warn', () => {
    logger.setLevel('ERROR');
    expect(logger.getLevel()).toBe('ERROR');

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('x');
    logger.info('x');
    logger.warn('x');
    logger.error('x');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[ERROR]', 'x');

    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('setLevel(SILENT) suppresses all output', () => {
    logger.setLevel('SILENT');
    expect(logger.getLevel()).toBe('SILENT');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('x');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('setLevel persists to localStorage', () => {
    logger.setLevel('WARN');
    expect(localStorage.getItem('tanoclo_log_level')).toBe('WARN');
  });

  it('reads initial level from localStorage', async () => {
    localStorage.setItem('tanoclo_log_level', 'ERROR');
    vi.resetModules();
    const mod = await import('../utils/logger');
    expect(mod.default.getLevel()).toBe('ERROR');
  });
});
