import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { AuditRecordInput, AuditTrail } from '../../../src/modules/identity/application/ports/AuditTrail.js';
import type { SessionAuditRecordInput, SessionAuditTrail } from '../../../src/modules/identity/application/ports/SessionAuditTrail.js';
import type { TenantAccessChecker } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import type { MfaPendingSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { InMemoryMembershipAuditTrail } from '../builders/testKit.js';
import { createTestPrismaClient, createTestRedisClient } from './dbTestHelpers.js';

/**
 * Preuve d'integration reelle (Prisma + Redis) de ADR-0005 §4 : une session `MFA_PENDING`
 * resolue par `ServerContextResolver.resolve()` ne produit JAMAIS de `ServerContext` — ce qui,
 * structurellement, empeche tout `UnitOfWorkContext` (et donc toute transaction) de s'ouvrir : le
 * compilateur TypeScript refuse deja d'appeler `toUnitOfWorkContext()` sur un `Result.failure`
 * (sa signature exige un `ServerContext` deja resolu, jamais un code d'erreur). Ce test verifie
 * le comportement RUNTIME (`Result.failure('MFA_REQUIRED')`) et la deduplication de l'audit de
 * contournement dans la fenetre de la session.
 *
 * Aucun nettoyage des lignes `AuditEntry` creees ici : la table est structurellement
 * append-only (REVOKE DELETE + trigger, voir la migration correspondante) — meme un role
 * superuser ne peut pas les supprimer sans desactiver le trigger au prealable, ce qui est
 * precisement la garantie que ce fichier ET auditEntryImmutability.test.ts verifient.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
class AuditModuleBackedAuditTrail implements AuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'MFA',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      actorKind: input.tenantId === null ? 'USER_PLATFORM' : 'USER_TENANT',
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      targetType: 'USER_ACCOUNT',
      targetId: input.subjectUserId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

class AuditModuleBackedSessionAuditTrail implements SessionAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: SessionAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'SESSION',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      actorKind: input.actorKind,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      targetType: 'USER_ACCOUNT',
      targetId: input.subjectUserId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

function buildPendingSession(overrides: Partial<MfaPendingSessionContext> = {}): MfaPendingSessionContext {
  return {
    sessionId: randomUUID(),
    kind: 'MFA_PENDING',
    userId: randomUUID(),
    intent: { kind: 'PLATFORM' },
    reason: 'ENROLLMENT_REQUIRED',
    auditRoleCodes: [],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

describe('ADR-0005 §4 — le gate MFA_PENDING empeche structurellement toute transaction', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const audit = buildAuditModule({ prisma, clock, idGenerator });
    const tenantAccessChecker: TenantAccessChecker = { checkAccess: async () => 'ACCESSIBLE' };
    identity = buildIdentityModule({
      prisma,
      redis,
      clock,
      idGenerator,
      tenantAccessChecker,
      auditTrail: new AuditModuleBackedAuditTrail(audit),
      sessionAuditTrail: new AuditModuleBackedSessionAuditTrail(audit),
      membershipAuditTrail: new InMemoryMembershipAuditTrail(),
      mfa: {
        secretEncryptionKey: Buffer.alloc(32, 11),
        secretEncryptionKeyId: 'k1',
        recoveryCodePepper: 'mfa-session-gate-test-recovery-code-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: 'SIH-TEST',
      },
      refreshToken: {
        hashPepper: 'mfa-session-gate-test-refresh-token-pepper-32chars',
        hashPepperId: 'p1',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  it("Result.failure('MFA_REQUIRED') est renvoye pour une session MFA_PENDING, jamais un ServerContext", async () => {
    const pending = buildPendingSession();
    await redis.set(`sih:session:${pending.sessionId}`, JSON.stringify(pending), 'EX', 300);

    const result = await identity.serverContextResolver.resolve(pending.sessionId, 'corr-gate-1');

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MFA_REQUIRED');
    // Absence structurelle : sur un Result.failure, `getValue()`/`toUnitOfWorkContext()` ne sont
    // meme pas appelables avec un type coherent — aucun ServerContext n'existe a partir duquel
    // construire un UnitOfWorkContext, donc aucune transaction ne peut s'ouvrir.
  });

  it("deduplique l'audit MFA_BYPASS_ATTEMPTED : une seule ligne AuditEntry par session, meme apres plusieurs tentatives dans la fenetre", async () => {
    const pending = buildPendingSession();
    await redis.set(`sih:session:${pending.sessionId}`, JSON.stringify(pending), 'EX', 300);

    await identity.serverContextResolver.resolve(pending.sessionId, 'corr-gate-2');
    await identity.serverContextResolver.resolve(pending.sessionId, 'corr-gate-2');
    await identity.serverContextResolver.resolve(pending.sessionId, 'corr-gate-2');

    // Filtre par `subjectUserId` (unique a ce test), PAS `sessionId` : depuis le correctif
    // securite 2026-09-01 (ADR-0009 §3.1), la colonne `session_id` ne porte plus le `sessionId`
    // brut mais sa reference DERIVEE non reversible (`sessionRef`) — comparer a `pending.sessionId`
    // ne matcherait plus jamais aucune ligne.
    const rows = await prisma.auditEntry.findMany({ where: { subjectUserId: pending.userId, eventType: 'MFA_BYPASS_ATTEMPTED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('DENIED');
    expect(rows[0]?.subjectUserId).toBe(pending.userId);
  });
});
