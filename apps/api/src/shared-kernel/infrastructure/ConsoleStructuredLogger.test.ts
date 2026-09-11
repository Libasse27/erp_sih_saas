import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleStructuredLogger } from './ConsoleStructuredLogger.js';

// ADR-0012 : redaction automatique des champs sensibles avant serialisation JSON. Intercepte
// `console.log` (utilise par `info`, seule methode a exiger la derogation eslint `no-console`)
// pour lire exactement ce qui aurait ete ecrit sur la sortie standard.
function lastLoggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const raw = spy.mock.calls.at(-1)?.[0] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('ConsoleStructuredLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logger: ConsoleStructuredLogger;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger = new ConsoleStructuredLogger();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('redacte une cle de la liste noire, quelle que soit sa casse', () => {
    logger.info({ password: 'secret123', Password: 'secret123', PASSWORD: 'secret123' }, 'test');
    const payload = lastLoggedPayload(logSpy);
    expect(payload['password']).toBe('[REDACTED]');
    expect(payload['Password']).toBe('[REDACTED]');
    expect(payload['PASSWORD']).toBe('[REDACTED]');
  });

  it('laisse passer une cle absente de la liste noire', () => {
    logger.info({ tenantId: 'tenant-1', eventType: 'registration.created' }, 'test');
    const payload = lastLoggedPayload(logSpy);
    expect(payload['tenantId']).toBe('tenant-1');
    expect(payload['eventType']).toBe('registration.created');
  });

  it('ne redacte pas une cle qui contient un mot de la liste sans la matcher exactement', () => {
    logger.info({ emailTemplate: 'welcome', phoneCountryCode: '+221' }, 'test');
    const payload = lastLoggedPayload(logSpy);
    expect(payload['emailTemplate']).toBe('welcome');
    expect(payload['phoneCountryCode']).toBe('+221');
  });

  it('ne redacte pas une cle sensible imbriquee (scan non recursif)', () => {
    logger.info({ context: { password: 'secret123' } }, 'test');
    const payload = lastLoggedPayload(logSpy);
    expect(payload['context']).toEqual({ password: 'secret123' });
  });

  it('garde le champ present dans le JSON produit, jamais supprime', () => {
    logger.info({ password: 'secret123' }, 'test');
    const payload = lastLoggedPayload(logSpy);
    expect('password' in payload).toBe(true);
  });

  it('applique la meme redaction sur warn et error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.warn({ token: 'abc' }, 'test');
    logger.error({ refreshToken: 'xyz' }, 'test');

    expect(lastLoggedPayload(warnSpy)['token']).toBe('[REDACTED]');
    expect(lastLoggedPayload(errorSpy)['refreshToken']).toBe('[REDACTED]');

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
