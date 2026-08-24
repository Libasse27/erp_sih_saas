import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, uuidAt } from '../../../../../test/identity/builders/testKit.js';
import type { PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
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
    issuedAt: '2026-08-24T10:00:00Z',
    ...overrides,
  };
}

describe('ServerContextResolver', () => {
  it("refuse une session absente/inconnue : aucun ServerContext ne peut donc etre construit ni transmis a un UnitOfWorkContext", async () => {
    const sessions = new InMemorySessionStore();
    const resolver = new ServerContextResolver(sessions);

    const result = await resolver.resolve('session-inconnue');

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('SESSION_NOT_FOUND');
    // Regle explicite de cette etape : contexte absent => aucun UnitOfWorkContext avec tenant.
    // Il n'existe ici tout simplement AUCUN ServerContext depuis lequel en construire un — c'est
    // le compilateur (Result en echec) qui empeche l'appelant d'appeler toUnitOfWorkContext().
  });

  it('resout une session TENANT valide en ServerContext TENANT, tenantId correctement type (TenantId)', async () => {
    const sessions = new InMemorySessionStore();
    const session = tenantSession();
    await sessions.create(session);
    const resolver = new ServerContextResolver(sessions);

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
    const sessions = new InMemorySessionStore();
    const session = platformSession();
    await sessions.create(session);
    const resolver = new ServerContextResolver(sessions);

    const result = await resolver.resolve(session.sessionId);

    expect(result.isSuccess()).toBe(true);
    const context = result.getValue();
    expect(context.kind).toBe('PLATFORM');
  });

  it('toUnitOfWorkContext() propage correctement tenantId + actorUserId pour un contexte TENANT', async () => {
    const sessions = new InMemorySessionStore();
    const session = tenantSession();
    await sessions.create(session);
    const resolver = new ServerContextResolver(sessions);

    const context = (await resolver.resolve(session.sessionId)).getValue();
    const uowContext = resolver.toUnitOfWorkContext(context);

    expect(uowContext.tenantId?.toString()).toBe(TENANT_A);
    expect(uowContext.actorUserId).toBe(session.userId);
  });

  it('toUnitOfWorkContext() ne porte JAMAIS de tenantId pour un contexte PLATFORM', async () => {
    const sessions = new InMemorySessionStore();
    const session = platformSession();
    await sessions.create(session);
    const resolver = new ServerContextResolver(sessions);

    const context = (await resolver.resolve(session.sessionId)).getValue();
    const uowContext = resolver.toUnitOfWorkContext(context);

    expect(uowContext.tenantId).toBeUndefined();
    expect(uowContext.actorUserId).toBe(session.userId);
  });

  it('leve une exception (pas un Result.failure) si une session TENANT stockee porte un tenantId corrompu — corruption, pas un echec metier attendu', async () => {
    const sessions = new InMemorySessionStore();
    const session = tenantSession({ tenantId: 'pas-un-uuid' });
    await sessions.create(session);
    const resolver = new ServerContextResolver(sessions);

    await expect(resolver.resolve(session.sessionId)).rejects.toThrow();
  });
});
