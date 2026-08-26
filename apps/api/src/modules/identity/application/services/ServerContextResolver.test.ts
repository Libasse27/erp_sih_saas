import { describe, expect, it } from 'vitest';
import {
  InMemoryAuditTrail,
  InMemoryMfaBypassAttemptGuard,
  InMemorySessionStore,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import type { MfaPendingSessionContext, PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { ServerContextResolver } from './ServerContextResolver.js';

const TENANT_A = uuidAt(9001);

function tenantSession(overrides: Partial<TenantSessionContext> = {}): TenantSessionContext {
  return {
    sessionId: 'session-tenant-1',
    kind: 'TENANT',
    userId: uuidAt(1),
    tenantId: TENANT_A,
    membershipId: uuidAt(2),
    roleCodes: ['MEDECIN'],
    permissionCodes: ['patient:read'],
    requiresMfa: false,
    mfaSatisfiedAt: null,
    issuedAt: '2026-08-24T10:00:00Z',
    ...overrides,
  };
}

function platformSession(overrides: Partial<PlatformSessionContext> = {}): PlatformSessionContext {
  return {
    sessionId: 'session-platform-1',
    kind: 'PLATFORM',
    userId: uuidAt(3),
    requiresMfa: true,
    mfaSatisfiedAt: '2026-08-24T10:00:00Z',
    issuedAt: '2026-08-24T10:00:00Z',
    ...overrides,
  };
}

function mfaPendingSession(overrides: Partial<MfaPendingSessionContext> = {}): MfaPendingSessionContext {
  return {
    sessionId: 'session-mfa-pending-1',
    kind: 'MFA_PENDING',
    userId: uuidAt(4),
    intent: { kind: 'TENANT', tenantId: TENANT_A },
    reason: 'CHALLENGE_REQUIRED',
    auditRoleCodes: ['ADMIN_ETABLISSEMENT'],
    issuedAt: '2026-08-24T10:00:00Z',
    expiresAt: '2026-08-24T10:05:00Z',
    ...overrides,
  };
}

function buildResolver(): { resolver: ServerContextResolver; sessions: InMemorySessionStore; auditTrail: InMemoryAuditTrail } {
  const sessions = new InMemorySessionStore();
  const auditTrail = new InMemoryAuditTrail();
  const resolver = new ServerContextResolver(sessions, new InMemoryMfaBypassAttemptGuard(), auditTrail);
  return { resolver, sessions, auditTrail };
}

describe('ServerContextResolver', () => {
  it("refuse une session absente/inconnue : aucun ServerContext ne peut donc etre construit ni transmis a un UnitOfWorkContext", async () => {
    const { resolver } = buildResolver();

    const result = await resolver.resolve('session-inconnue');

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('SESSION_NOT_FOUND');
    // Regle explicite de cette etape : contexte absent => aucun UnitOfWorkContext avec tenant.
    // Il n'existe ici tout simplement AUCUN ServerContext depuis lequel en construire un — c'est
    // le compilateur (Result en echec) qui empeche l'appelant d'appeler toUnitOfWorkContext().
  });

  it('resout une session TENANT valide en ServerContext TENANT, tenantId correctement type (TenantId)', async () => {
    const { resolver, sessions } = buildResolver();
    const session = tenantSession();
    await sessions.create(session);

    const result = await resolver.resolve(session.sessionId);

    expect(result.isSuccess()).toBe(true);
    const context = result.getValue();
    expect(context.kind).toBe('TENANT');
    if (context.kind === 'TENANT') {
      expect(context.tenantId.toString()).toBe(TENANT_A);
      expect(context.actorUserId).toBe(session.userId);
    }
  });

  it('resout une session PLATFORM valide en ServerContext PLATFORM, sans tenantId', async () => {
    const { resolver, sessions } = buildResolver();
    const session = platformSession();
    await sessions.create(session);

    const result = await resolver.resolve(session.sessionId);

    expect(result.isSuccess()).toBe(true);
    const context = result.getValue();
    expect(context.kind).toBe('PLATFORM');
  });

  it('toUnitOfWorkContext() propage correctement tenantId + actorUserId pour un contexte TENANT', async () => {
    const { resolver, sessions } = buildResolver();
    const session = tenantSession();
    await sessions.create(session);

    const context = (await resolver.resolve(session.sessionId)).getValue();
    const uowContext = resolver.toUnitOfWorkContext(context);

    expect(uowContext.tenantId?.toString()).toBe(TENANT_A);
    expect(uowContext.actorUserId).toBe(session.userId);
  });

  it('toUnitOfWorkContext() ne porte JAMAIS de tenantId pour un contexte PLATFORM', async () => {
    const { resolver, sessions } = buildResolver();
    const session = platformSession();
    await sessions.create(session);

    const context = (await resolver.resolve(session.sessionId)).getValue();
    const uowContext = resolver.toUnitOfWorkContext(context);

    expect(uowContext.tenantId).toBeUndefined();
    expect(uowContext.actorUserId).toBe(session.userId);
  });

  it('leve une exception (pas un Result.failure) si une session TENANT stockee porte un tenantId corrompu — corruption, pas un echec metier attendu', async () => {
    const { resolver, sessions } = buildResolver();
    const session = tenantSession({ tenantId: 'pas-un-uuid' });
    await sessions.create(session);

    await expect(resolver.resolve(session.sessionId)).rejects.toThrow();
  });

  describe('ADR-0005 §4 — une session MFA_PENDING ne produit JAMAIS de ServerContext', () => {
    it("renvoie Result.failure('MFA_REQUIRED'), jamais un ServerContext PLATFORM ou TENANT", async () => {
      const { resolver, sessions } = buildResolver();
      const session = mfaPendingSession();
      await sessions.create(session);

      const result = await resolver.resolve(session.sessionId);

      expect(result.isFailure()).toBe(true);
      expect(result.getError()).toBe('MFA_REQUIRED');
    });

    it('journalise une tentative de contournement (MFA_BYPASS_ATTEMPTED / DENIED)', async () => {
      const { resolver, sessions, auditTrail } = buildResolver();
      const session = mfaPendingSession();
      await sessions.create(session);

      await resolver.resolve(session.sessionId, 'corr-1');

      expect(auditTrail.records).toHaveLength(1);
      expect(auditTrail.records[0]).toMatchObject({
        eventType: 'MFA_BYPASS_ATTEMPTED',
        outcome: 'DENIED',
        subjectUserId: session.userId,
        actorUserId: session.userId,
        sessionId: session.sessionId,
        tenantId: TENANT_A,
        correlationId: 'corr-1',
      });
    });

    it("ne journalise qu'UNE SEULE FOIS par sessionId (deduplication, ADR-0005 §4)", async () => {
      const { resolver, sessions, auditTrail } = buildResolver();
      const session = mfaPendingSession();
      await sessions.create(session);

      await resolver.resolve(session.sessionId);
      await resolver.resolve(session.sessionId);
      await resolver.resolve(session.sessionId);

      expect(auditTrail.records).toHaveLength(1);
    });
  });
});
