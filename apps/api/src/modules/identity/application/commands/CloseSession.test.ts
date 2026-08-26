import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../../../../../test/identity/builders/testKit.js';
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
    });

    const handler = new CloseSessionHandler(store);
    const result = await handler.execute({ sessionId: 's1' });

    expect(result.isSuccess()).toBe(true);
    expect(await store.get('s1')).toBeNull();
  });

  it('est idempotent : fermer une session deja fermee ne produit pas d_erreur', async () => {
    const store = new InMemorySessionStore();
    const handler = new CloseSessionHandler(store);

    const result = await handler.execute({ sessionId: 'inconnue' });
    expect(result.isSuccess()).toBe(true);
  });
});
