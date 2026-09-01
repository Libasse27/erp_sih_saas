import { describe, expect, it } from 'vitest';
import {
  buildTestRefreshTokenIssuer,
  InMemorySessionAuditTrail,
  InMemorySessionStore,
  InMemoryUnitOfWork,
} from '../../../../../test/identity/builders/testKit.js';
import { CloseSessionHandler } from './CloseSession.js';

describe('CloseSessionHandler', () => {
  it('ferme une session existante', async () => {
    const store = new InMemorySessionStore();
    await store.create({
      sessionId: 's1',
      kind: 'PLATFORM',
      userId: 'u1',
      requiresMfa: true,
      mfaSatisfiedAt: null,
      issuedAt: new Date().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const sessionAuditTrail = new InMemorySessionAuditTrail();
    const handler = new CloseSessionHandler(store, buildTestRefreshTokenIssuer(), sessionAuditTrail, new InMemoryUnitOfWork());
    const result = await handler.execute({ sessionId: 's1' });

    expect(result.isSuccess()).toBe(true);
    expect(await store.get('s1')).toBeNull();
    expect(sessionAuditTrail.records).toHaveLength(1);
    expect(sessionAuditTrail.records[0]).toMatchObject({ eventType: 'SESSION_CLOSED', outcome: 'SUCCESS', tenantId: null, actorUserId: 'u1' });
  });

  it('est idempotent : fermer une session deja fermee ne produit pas d_erreur, ni de nouvelle entree d_audit', async () => {
    const store = new InMemorySessionStore();
    const sessionAuditTrail = new InMemorySessionAuditTrail();
    const handler = new CloseSessionHandler(store, buildTestRefreshTokenIssuer(), sessionAuditTrail, new InMemoryUnitOfWork());

    const result = await handler.execute({ sessionId: 'inconnue' });
    expect(result.isSuccess()).toBe(true);
    expect(sessionAuditTrail.records).toHaveLength(0);
  });
});
