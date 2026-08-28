import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS } from '../../../src/modules/identity/domain/MfaTuning.js';
import { MfaEnrollment } from '../../../src/modules/identity/domain/MfaEnrollment.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { RecoveryCodeHash } from '../../../src/modules/identity/domain/value-objects/RecoveryCodeHash.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import { AesGcmSecretCipher } from '../../../src/modules/identity/infrastructure/security/AesGcmSecretCipher.js';
import { Rfc6238TotpService } from '../../../src/modules/identity/infrastructure/security/Rfc6238TotpService.js';
import type { AuditRecordInput, AuditTrail } from '../../../src/modules/identity/application/ports/AuditTrail.js';
import type { SessionAuditRecordInput, SessionAuditTrail } from '../../../src/modules/identity/application/ports/SessionAuditTrail.js';
import type { TenantAccessChecker } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import type { MfaPendingSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { createTestPrismaClient, createTestRedisClient, uniqueEmail } from './dbTestHelpers.js';

/** Calque de `AuditModuleBackedAuditTrail` (composition-root.ts) — voir mfaSessionGate.test.ts. */
class AuditModuleBackedAuditTrail implements AuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'MFA',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/** Calque de `AuditModuleBackedSessionAuditTrail` (composition-root.ts) — voir mfaSessionGate.test.ts. */
class AuditModuleBackedSessionAuditTrail implements SessionAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: SessionAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'SESSION',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

function sessionKey(sessionId: string): string {
  // Meme format de cle que RedisSessionStore.ts (prive, non exporte) — ecrit directement pour
  // eviter de dependre d'un SessionStore complet dans ce test d'integration cible.
  return `sih:session:${sessionId}`;
}

/**
 * Integration reelle (PostgreSQL + Redis) — correctif securite F-3 (revue independante) :
 * `PrismaMfaEnrollmentRepository.findByUserIdForUpdate` (verrou de ligne `FOR UPDATE`) doit
 * serialiser des evaluations de code CONCURRENTES sur le MEME compte, la ou l'ancien
 * verrouillage OPTIMISTE (colonne `version`) aurait laisse N-1 tentatives echouer sur conflit de
 * version AVANT d'ecrire leur compteur d'echecs ET leur `AuditEntry`.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
const MFA_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 13);
const MFA_SECRET_ENCRYPTION_KEY_ID = 'k1';
const MFA_TOTP_ISSUER = 'SIH-TEST';

describe('F-3 — verrou anti-bruteforce sous acces concurrent (PrismaMfaEnrollmentRepository.findByUserIdForUpdate)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;
  /** MEME cle/issuer que `identity.mfa` (ci-dessous) — genere un secret REELLEMENT chiffrable/dechiffrable par le `Rfc6238TotpService` interne au module, indispensable ici (test d'integration reel, pas de `FakeTotpService`). */
  let totpService: Rfc6238TotpService;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const audit = buildAuditModule({ prisma, clock, idGenerator });
    const tenantAccessChecker: TenantAccessChecker = { checkAccess: async () => 'ACCESSIBLE' };
    totpService = new Rfc6238TotpService(new AesGcmSecretCipher(MFA_SECRET_ENCRYPTION_KEY, MFA_SECRET_ENCRYPTION_KEY_ID), MFA_TOTP_ISSUER);
    identity = buildIdentityModule({
      prisma,
      redis,
      clock,
      idGenerator,
      tenantAccessChecker,
      auditTrail: new AuditModuleBackedAuditTrail(audit),
      sessionAuditTrail: new AuditModuleBackedSessionAuditTrail(audit),
      mfa: {
        secretEncryptionKey: MFA_SECRET_ENCRYPTION_KEY,
        secretEncryptionKeyId: MFA_SECRET_ENCRYPTION_KEY_ID,
        recoveryCodePepper: 'mfa-brute-force-concurrency-test-recovery-code-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: MFA_TOTP_ISSUER,
      },
      refreshToken: {
        hashPepper: 'mfa-brute-force-concurrency-test-refresh-token-pepper-32c',
        hashPepperId: 'p1',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  it(
    'N tentatives concurrentes avec un mauvais code : chacune incremente reellement le compteur ET produit sa propre AuditEntry (aucune perdue par conflit de version)',
    async () => {
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();

      const account = UserAccount.register({
        email: Email.create(uniqueEmail('mfa-brute-force')).getValue(),
        passwordHash: PasswordHash.fromHash('hash').getValue(),
        platformRole: 'NONE',
        clock,
        idGenerator,
      });
      await identity.repositories.userAccounts.save(account);

      // Secret REELLEMENT chiffre (AES-256-GCM, meme cle que le module) — indispensable ici : le
      // `Rfc6238TotpService` interne aux handlers testes va vraiment tenter de le DECHIFFRER a
      // chaque tentative (contrairement aux tests unitaires, qui utilisent `FakeTotpService` et
      // n'exercent jamais `AesGcmSecretCipher`).
      const provisioning = await totpService.generateSecret({ userAccountId: account.id.toString(), accountLabel: account.email.value });
      const enrollment = MfaEnrollment.start({
        userId: account.id,
        pendingSecret: provisioning.encryptedSecret,
        clock,
        idGenerator,
      });
      enrollment.confirmEnrollment({
        timeStep: 1,
        recoveryCodes: [RecoveryCodeHash.create('v1.p1.unused').getValue()],
        clock,
        idGenerator,
      });
      await identity.repositories.mfaEnrollments.save(enrollment);

      const ATTEMPT_COUNT = 8;
      expect(ATTEMPT_COUNT).toBeGreaterThan(MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS);

      // Une session MFA_PENDING PARTAGEE par toutes les tentatives concurrentes (meme scenario
      // qu'un attaquant reessayant un mauvais code sur le meme flux de connexion).
      const pending: MfaPendingSessionContext = {
        sessionId: `pending-brute-force-${account.id.toString()}`,
        kind: 'MFA_PENDING',
        userId: account.id.toString(),
        intent: { kind: 'PLATFORM' },
        reason: 'CHALLENGE_REQUIRED',
        auditRoleCodes: [],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
      await redis.set(sessionKey(pending.sessionId), JSON.stringify(pending), 'EX', 300);

      const attempt = () =>
        identity.handlers.verifyMfaChallenge.execute({
          pendingSessionId: pending.sessionId,
          factor: { kind: 'TOTP', code: 'mauvais-code' },
        });

      const results = await Promise.all(Array.from({ length: ATTEMPT_COUNT }, () => attempt()));

      // Aucune tentative n'a du lever d'exception technique (ex. MfaEnrollmentConcurrencyConflictError) :
      // le verrou de ligne les SERIALISE au lieu de les faire echouer en conflit de version.
      for (const result of results) {
        expect(result.isFailure()).toBe(true);
        expect(['INVALID_CODE', 'TOO_MANY_ATTEMPTS']).toContain(result.getError());
      }

      const auditRows = await prisma.auditEntry.findMany({
        where: { subjectUserId: account.id.toString(), eventType: { in: ['MFA_CHALLENGE_FAILED', 'MFA_CHALLENGE_BLOCKED'] } },
      });
      // Chaque tentative concurrente a produit EXACTEMENT une entree d'audit — aucune perdue.
      expect(auditRows).toHaveLength(ATTEMPT_COUNT);

      const failedRows = auditRows.filter((row) => row.eventType === 'MFA_CHALLENGE_FAILED');
      const blockedRows = auditRows.filter((row) => row.eventType === 'MFA_CHALLENGE_BLOCKED');
      // Exactement `MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS` tentatives ont reellement evalue le code
      // (et donc incremente le compteur) AVANT que le verrou ne se declenche ; les tentatives
      // restantes, une fois le verrou pose, sont bloquees EN AMONT de toute nouvelle evaluation.
      expect(failedRows).toHaveLength(MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS);
      expect(blockedRows).toHaveLength(ATTEMPT_COUNT - MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS);

      const finalEnrollment = await identity.repositories.mfaEnrollments.findByUserId(account.id);
      expect(finalEnrollment?.consecutiveFailedAttempts).toBe(MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS);
      expect(finalEnrollment?.lockedUntil).not.toBeNull();
      expect((finalEnrollment?.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());

      const lockedOutRows = await prisma.auditEntry.findMany({
        where: { subjectUserId: account.id.toString(), eventType: 'MFA_FACTOR_LOCKED_OUT' },
      });
      // F-5, verifie ici par effet de bord : le franchissement du seuil ecrit EXACTEMENT une
      // entree MFA_FACTOR_LOCKED_OUT, jamais une par tentative bloquee ensuite.
      expect(lockedOutRows).toHaveLength(1);
    },
    20_000,
  );
});
