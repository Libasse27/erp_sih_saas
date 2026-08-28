import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { TenantAccessChecker } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import type { AuditRecordInput, AuditTrail } from '../../../src/modules/identity/application/ports/AuditTrail.js';
import type { SessionAuditRecordInput, SessionAuditTrail } from '../../../src/modules/identity/application/ports/SessionAuditTrail.js';
import type { TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { createTestPrismaClient, createTestRedisClient, uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

/** Calque des adaptateurs de composition-root.ts (voir mfaSessionGate.test.ts pour le meme raisonnement). */
class AuditModuleBackedAuditTrail implements AuditTrail {
  constructor(private readonly audit: AuditModule) {}
  async record(input: AuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({ category: 'MFA', ...input });
  }
}
class AuditModuleBackedSessionAuditTrail implements SessionAuditTrail {
  constructor(private readonly audit: AuditModule) {}
  async record(input: SessionAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({ category: 'SESSION', ...input });
  }
}

/**
 * Preuve d'integration reelle (PostgreSQL + Redis) de l'etape 8/13 (ADR-0006) : rotation,
 * detection de reutilisation, expiration differenciee, changement de contexte tenant, contrainte
 * d'unicite et concurrence reelle sur `platform.RefreshToken`.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Refresh token rotation — integration Postgres + Redis reelle (O-06.5, ADR-0006)', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;
  let tenant: TenantModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    tenant = buildTenantModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator() });
    const tenantAccessChecker: TenantAccessChecker = {
      checkAccess: async (tenantId) => {
        const facility = await tenant.repositories.healthFacilities.findByTenantId(tenantId);
        if (facility === null) return 'NOT_FOUND';
        return facility.isActive() ? 'ACCESSIBLE' : 'SUSPENDED';
      },
    };
    const audit = buildAuditModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator() });
    identity = buildIdentityModule({
      prisma,
      redis,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
      tenantAccessChecker,
      auditTrail: new AuditModuleBackedAuditTrail(audit),
      sessionAuditTrail: new AuditModuleBackedSessionAuditTrail(audit),
      mfa: {
        secretEncryptionKey: Buffer.alloc(32, 17),
        secretEncryptionKeyId: 'k1',
        recoveryCodePepper: 'refresh-token-rotation-test-recovery-code-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: 'SIH-TEST',
      },
      refreshToken: {
        hashPepper: 'refresh-token-rotation-test-refresh-token-pepper-32c',
        hashPepperId: 'p1',
      },
    });

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(identity.repositories.roles);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

  async function createAccount(): Promise<{ userId: string; email: string; password: string }> {
    const email = uniqueEmail('refresh');
    const password = 'mot-de-passe-suffisant-1';
    const result = await identity.handlers.createUserAccount.execute({ email, plainPassword: password, platformRole: 'NONE' });
    if (result.isFailure()) throw new Error(`Echec creation compte: ${result.getError()}`);
    return { userId: result.getValue().userAccountId, email, password };
  }

  async function createFacilityTenantId(): Promise<string> {
    const result = await tenant.handlers.createHealthFacility.execute({ name: uniqueFacilityName('Etablissement Refresh') });
    if (result.isFailure()) throw new Error(`Echec creation etablissement: ${result.getError()}`);
    return result.getValue().tenantId;
  }

  /** Login complet (compte + membership MEDECIN, non soumis au MFA) -> session + refresh token reels. */
  async function login(): Promise<{ userId: string; tenantId: string; sessionId: string; refreshToken: string }> {
    const { userId } = await createAccount();
    const tenantId = await createFacilityTenantId();
    const grant = await identity.handlers.grantMembership.execute({ userId, tenantId, createdBy: userId, initialRoleCodes: ['MEDECIN'] });
    if (grant.isFailure()) throw new Error(`Echec grant: ${grant.getError()}`);

    const context = await identity.handlers.resolveTenantContext.execute({ userId, intent: { kind: 'TENANT', tenantId } });
    if (context.isFailure()) throw new Error(`Echec resolveTenantContext: ${context.getError()}`);
    const { session, refreshToken } = context.getValue();
    if (refreshToken === null) throw new Error('Aucun refresh token emis pour une session complete.');
    return { userId, tenantId, sessionId: session.sessionId, refreshToken };
  }

  it('platform.RefreshToken.token_hash est UNIQUE — une seconde ligne avec le meme hash est rejetee par la base', async () => {
    const sharedHash = `v1.p1.${randomUUID()}`;
    const base = {
      chainId: randomUUID(),
      userId: (await createAccount()).userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD' as const,
      tokenHash: sharedHash,
      status: 'ACTIVE' as const,
      sessionId: randomUUID(),
      previousTokenId: null,
      chainStartedAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 60_000),
      inactivityExpiresAt: new Date(Date.now() + 60_000),
      issuedAt: new Date(),
      revokedAt: null,
      revokedReason: null,
    };
    await prisma.refreshToken.create({ data: { id: randomUUID(), ...base } });

    await expect(prisma.refreshToken.create({ data: { id: randomUUID(), ...base } })).rejects.toThrow();
  });

  it('rotation reussie puis REJEU de l_ancien token : detecte comme reutilisation, revoque TOUTE la chaine (les deux generations)', async () => {
    const { refreshToken: token1, sessionId: sessionId1 } = await login();

    const first = await identity.handlers.refreshSession.execute({ refreshToken: token1 });
    expect(first.isSuccess()).toBe(true);
    const { session: session2, refreshToken: token2 } = first.getValue();
    expect(session2.sessionId).not.toBe(sessionId1);

    const replay = await identity.handlers.refreshSession.execute({ refreshToken: token1 });
    expect(replay.isFailure()).toBe(true);
    expect(replay.getError()).toBe('REUSE_DETECTED');

    const rows = await prisma.refreshToken.findMany({ where: { sessionId: { in: [sessionId1, session2.sessionId] } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('REVOKED');
      expect(row.revokedReason).toBe('REUSE_DETECTED');
    }

    // La session ISSUE de la rotation legitime (token2) doit elle aussi avoir ete fermee — pas
    // seulement celle du token perime presente au rejeu (voir le correctif de revokeChain).
    const contextAfterReplay = await identity.serverContextResolver.resolve(session2.sessionId);
    expect(contextAfterReplay.isFailure()).toBe(true);
    expect(contextAfterReplay.getError()).toBe('SESSION_NOT_FOUND');

    // Et le token2, pourtant jamais reutilise lui-meme, ne doit plus permettre de rotation : sa
    // ligne a ete revoquee par la reponse a la reutilisation detectee sur token1 (chaine entiere).
    const attemptWithToken2 = await identity.handlers.refreshSession.execute({ refreshToken: token2 });
    expect(attemptWithToken2.isFailure()).toBe(true);
    expect(attemptWithToken2.getError()).toBe('CHAIN_ALREADY_REVOKED');
  });

  it("revocation de chaine CONCURRENTE a une rotation legitime EN COURS sur une AUTRE generation : aucune session vivante ne doit survivre (regression, revue de securite independante)", async () => {
    // Reproduit le scenario exact de la revue : un rejeu (token1, deja consomme) declenche une
    // revocation de chaine PENDANT qu'une rotation legitime (token2, encore ACTIVE) est en vol.
    // Avant le correctif, `revokeChain` lisait les `sessionId` a fermer AVANT d'ecrire la
    // revocation (deux allers-retours Postgres separes) : si la rotation legitime committait
    // ENTRE ces deux etapes, sa nouvelle session (sessionId inconnu de la lecture anterieure)
    // n'etait JAMAIS fermee — une session pleinement authentifiee survivait a la revocation de sa
    // propre chaine jusqu'a expiration de sa TTL Redis.
    const { userId, refreshToken: token1 } = await login();
    const first = await identity.handlers.refreshSession.execute({ refreshToken: token1 });
    expect(first.isSuccess()).toBe(true);
    const { refreshToken: token2 } = first.getValue();

    const [replayResult, concurrentRotationResult] = await Promise.all([
      identity.handlers.refreshSession.execute({ refreshToken: token1 }), // rejeu -> REUSE_DETECTED
      identity.handlers.refreshSession.execute({ refreshToken: token2 }), // rotation legitime en vol
    ]);

    expect(replayResult.isFailure()).toBe(true);
    expect(replayResult.getError()).toBe('REUSE_DETECTED');
    // Selon l'entrelacement reel, la rotation legitime concurrente reussit (puis sa session est
    // fermee par la revocation de chaine qui la rattrape) ou echoue directement — les DEUX sont
    // des refus/etats surs ; ce qui ne l'est PAS, c'est qu'une session survive.
    const survivingSessionIds: string[] = [];
    if (concurrentRotationResult.isSuccess()) {
      survivingSessionIds.push(concurrentRotationResult.getValue().session.sessionId);
    }

    // Toutes les lignes de la chaine (toutes generations) doivent etre REVOKED, sans exception —
    // y compris une eventuelle generation creee par la rotation concurrente juste avant que la
    // revocation ne la rattrape (c'est precisement la fenetre que le correctif ferme).
    const allRowsForUser = await prisma.refreshToken.findMany({ where: { userId } });
    expect(allRowsForUser.length).toBeGreaterThanOrEqual(2);
    for (const row of allRowsForUser) {
      expect(row.status).toBe('REVOKED');
    }

    // Aucune session issue de cette chaine ne doit rester resolvable, meme celle de la rotation
    // "gagnante" de la course concurrente.
    for (const sessionId of survivingSessionIds) {
      const ctx = await identity.serverContextResolver.resolve(sessionId);
      expect(ctx.isFailure()).toBe(true);
    }
  });

  it('deux refresh CONCURRENTS avec le MEME token : un seul succes, l_autre un echec propre (pas de perte de la session gagnante)', async () => {
    const { refreshToken } = await login();

    const [resultA, resultB] = await Promise.all([
      identity.handlers.refreshSession.execute({ refreshToken }),
      identity.handlers.refreshSession.execute({ refreshToken }),
    ]);

    const successes = [resultA, resultB].filter((r) => r.isSuccess());
    const failures = [resultA, resultB].filter((r) => r.isFailure());
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Deux entrelacements reels sont possibles pour le perdant, et les DEUX sont un comportement
    // VOULU (pas une flakiness a masquer) :
    //   - course serree sur l'UPDATE conditionnel (les deux lectures de validation voient encore
    //     ACTIVE) : echec PROPRE et NON PUNITIF, la session gagnante reste pleinement vivante ;
    //   - entrelacement SEQUENTIEL (le perdant lit APRES que le gagnant a deja acheve rotation +
    //     ecriture) : le perdant voit une generation deja ROTATED, indiscernable cote serveur d'un
    //     rejeu reel (ADR-0006 §6) — la chaine ENTIERE est revoquee, y compris la session du
    //     "gagnant" de cette course precise. C'est la limite documentee et acceptee du modele de
    //     rotation OWASP standard : un client doit serialiser ses propres appels de renouvellement
    //     (mutex/onglet unique) plutot que compter sur le serveur pour arbitrer un double envoi du
    //     MEME jeton sans consequence.
    const loserError = failures[0]?.getError();
    expect(['CONCURRENT_REFRESH_CONFLICT', 'REUSE_DETECTED']).toContain(loserError);

    const winningSessionId = successes[0]?.getValue().session.sessionId as string;
    const winnerContext = await identity.serverContextResolver.resolve(winningSessionId);
    if (loserError === 'CONCURRENT_REFRESH_CONFLICT') {
      expect(winnerContext.isSuccess()).toBe(true);
    } else {
      // REUSE_DETECTED : la chaine entiere (y compris la session gagnante de cette rotation) a ete
      // revoquee par construction — c'est le resultat attendu, pas un echec du test.
      expect(winnerContext.isFailure()).toBe(true);
    }
  });

  it('plafond absolu depasse : refuse distinctement (ABSOLUTE_CEILING_EXCEEDED) et revoque la chaine', async () => {
    const { refreshToken, sessionId } = await login();

    await prisma.refreshToken.updateMany({
      where: { sessionId },
      data: { absoluteExpiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await identity.handlers.refreshSession.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('ABSOLUTE_CEILING_EXCEEDED');

    const row = await prisma.refreshToken.findFirst({ where: { sessionId } });
    expect(row?.status).toBe('REVOKED');
    expect(row?.revokedReason).toBe('ABSOLUTE_CEILING_EXCEEDED');
  });

  it("fenetre d_inactivite depassee (mais plafond absolu encore valide) : refuse distinctement (INACTIVITY_TIMEOUT_EXCEEDED), preuve de la difference avec le plafond absolu", async () => {
    const { refreshToken, sessionId } = await login();

    await prisma.refreshToken.updateMany({
      where: { sessionId },
      data: { inactivityExpiresAt: new Date(Date.now() - 1_000) }, // absoluteExpiresAt reste dans le futur
    });

    const result = await identity.handlers.refreshSession.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INACTIVITY_TIMEOUT_EXCEEDED');

    const row = await prisma.refreshToken.findFirst({ where: { sessionId } });
    expect(row?.status).toBe('REVOKED');
    expect(row?.revokedReason).toBe('INACTIVITY_TIMEOUT');
  });

  it("changement de contexte tenant : ferme l_ANCIENNE chaine (revoquee, jamais reutilisable) en ouvrant la nouvelle, sans etat partage", async () => {
    const { userId, sessionId: sessionA, refreshToken: refreshTokenA } = await login();
    const tenantB = await createFacilityTenantId();
    const grantB = await identity.handlers.grantMembership.execute({ userId, tenantId: tenantB, createdBy: userId, initialRoleCodes: ['MEDECIN'] });
    expect(grantB.isSuccess()).toBe(true);

    const switchResult = await identity.handlers.resolveTenantContext.execute({
      userId,
      intent: { kind: 'TENANT', tenantId: tenantB },
      previousSessionId: sessionA,
    });
    expect(switchResult.isSuccess()).toBe(true);
    const { session: sessionB, refreshToken: refreshTokenB } = switchResult.getValue();
    expect((sessionB as TenantSessionContext).tenantId).toBe(tenantB);
    expect(refreshTokenB).not.toBeNull();

    // L'ancienne chaine (tenant A) est deja revoquee (CONTEXT_SWITCHED, raison benigne) : refus
    // propre CHAIN_ALREADY_REVOKED, pas une qualification en reutilisation/attaque (ADR-0006 §6).
    const oldAttempt = await identity.handlers.refreshSession.execute({ refreshToken: refreshTokenA });
    expect(oldAttempt.isFailure()).toBe(true);
    expect(oldAttempt.getError()).toBe('CHAIN_ALREADY_REVOKED');

    // La NOUVELLE chaine (tenant B), elle, fonctionne normalement.
    const newAttempt = await identity.handlers.refreshSession.execute({ refreshToken: refreshTokenB as string });
    expect(newAttempt.isSuccess()).toBe(true);
    expect((newAttempt.getValue().session as TenantSessionContext).tenantId).toBe(tenantB);
  });

  it('la deconnexion explicite (CloseSession) revoque aussi la chaine de refresh associee (refus propre, pas une qualification en reutilisation)', async () => {
    const { sessionId, refreshToken } = await login();

    const closeResult = await identity.handlers.closeSession.execute({ sessionId });
    expect(closeResult.isSuccess()).toBe(true);

    const attempt = await identity.handlers.refreshSession.execute({ refreshToken });
    expect(attempt.isFailure()).toBe(true);
    expect(attempt.getError()).toBe('CHAIN_ALREADY_REVOKED');
  });
});
