import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

/**
 * Unitaire, zero I/O — valide uniquement la logique de `loadEnv` (schema Zod), pas une connexion
 * Redis/Postgres reelle (voir test/shared-kernel/integration/ pour les tests d'integration reels).
 */
describe('loadEnv — validation REDIS_URL conditionnelle par environnement (revue de securite, etape 6/13)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://sih_app:pw@localhost:5432/sih_dev?schema=public',
    PAYMENT_PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
  };

  it('accepte redis:// non authentifie en developpement (environnement local non expose)', () => {
    const env = loadEnv({ ...baseEnv, NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('accepte redis:// non authentifie en test', () => {
    const env = loadEnv({ ...baseEnv, NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' });
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('refuse redis:// (non chiffre) en production', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'production', REDIS_URL: 'redis://user:pw@redis.example.sn:6380' })).toThrow(
      /rediss/,
    );
  });

  it('refuse rediss:// sans identifiants en staging', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'staging', REDIS_URL: 'rediss://redis.example.sn:6380' })).toThrow(
      /authentification/,
    );
  });

  it('accepte rediss:// avec identifiants en production', () => {
    const env = loadEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://user:pw@redis.example.sn:6380',
    });
    expect(env.REDIS_URL).toBe('rediss://user:pw@redis.example.sn:6380');
  });

  it('refuse une REDIS_URL non parsable en production', () => {
    expect(() => loadEnv({ ...baseEnv, NODE_ENV: 'production', REDIS_URL: 'not-a-url' })).toThrow();
  });
});
