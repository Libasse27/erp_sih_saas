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
    MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    MFA_RECOVERY_CODE_PEPPER: 'b'.repeat(32),
    REFRESH_TOKEN_HASH_PEPPER: 'd'.repeat(32),
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

describe('loadEnv — validation des secrets MFA (etape 7/13, ADR-0005)', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://sih_app:pw@localhost:5432/sih_dev?schema=public',
    PAYMENT_PROVIDER_WEBHOOK_SECRET: 'a'.repeat(32),
    REDIS_URL: 'rediss://user:pw@redis.example.sn:6380',
    REFRESH_TOKEN_HASH_PEPPER: 'd'.repeat(32),
  };

  it('refuse une MFA_SECRET_ENCRYPTION_KEY qui ne decode pas en exactement 32 octets', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'development',
        MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
        MFA_RECOVERY_CODE_PEPPER: 'b'.repeat(32),
      }),
    ).toThrow(/32 octets/);
  });

  it('refuse un MFA_RECOVERY_CODE_PEPPER de moins de 32 caracteres', () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'development',
        MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        MFA_RECOVERY_CODE_PEPPER: 'trop-court',
      }),
    ).toThrow(/32 caracteres/);
  });

  it('accepte des secrets MFA valides en developpement', () => {
    const env = loadEnv({
      ...baseEnv,
      NODE_ENV: 'development',
      MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      MFA_RECOVERY_CODE_PEPPER: 'c'.repeat(32),
    });
    expect(env.MFA_SECRET_ENCRYPTION_KEY_ID).toBe('k1');
    expect(env.MFA_RECOVERY_CODE_PEPPER_ID).toBe('p1');
    expect(env.MFA_TOTP_ISSUER).toBe('SIH');
  });

  it("refuse la valeur d'exemple de developpement exacte de MFA_SECRET_ENCRYPTION_KEY en production", () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        MFA_SECRET_ENCRYPTION_KEY: 'ZGV2X29ubHlfbmV2ZXJfdXNlX3Byb2RfMzJieXRlcyE=',
        MFA_RECOVERY_CODE_PEPPER: 'c'.repeat(32),
      }),
    ).toThrow(/exemple de developpement/);
  });

  it("refuse la valeur d'exemple de developpement exacte de MFA_RECOVERY_CODE_PEPPER en staging", () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'staging',
        MFA_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        MFA_RECOVERY_CODE_PEPPER: 'dev_only_never_use_in_prod_recovery_code_pepper_32c',
      }),
    ).toThrow(/exemple de developpement/);
  });
});
