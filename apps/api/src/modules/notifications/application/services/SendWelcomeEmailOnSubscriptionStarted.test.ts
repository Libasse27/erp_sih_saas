import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import {
  FixedClock,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { InMemoryNotificationRepository, InMemoryRecipientDirectory } from '../../../../../test/notifications/builders/testKit.js';
import { createSendWelcomeEmailOnSubscriptionStartedHandler } from './SendWelcomeEmailOnSubscriptionStarted.js';

const TENANT_A = uuidAt(9101);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(1),
    eventType: 'subscription.subscription.started',
    eventVersion: 1,
    aggregateId: uuidAt(2),
    tenantId: TENANT_A,
    occurredAt: new Date('2026-08-28T00:00:00.000Z'),
    payload: { tenantId: TENANT_A, planId: uuidAt(3), trialEndsAt: null },
    ...overrides,
  };
}

describe('SendWelcomeEmailOnSubscriptionStarted (ADR-0007 §1)', () => {
  function build() {
    const notificationRepository = new InMemoryNotificationRepository();
    const recipientDirectory = new InMemoryRecipientDirectory();
    const handler = createSendWelcomeEmailOnSubscriptionStartedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork: new InMemoryUnitOfWork(),
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock('2026-08-28T00:00:00.000Z'),
    });
    return { handler, notificationRepository, recipientDirectory };
  }

  it('cree une Notification EMAIL PENDING pour chaque ADMIN_ETABLISSEMENT resolu du tenant', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seed(TENANT_A, ['admin1@hopital.sn', 'admin2@hopital.sn']);

    await handler(envelope());

    const created = notificationRepository.all();
    expect(created).toHaveLength(2);
    expect(new Set(created.map((n) => n.recipient))).toEqual(new Set(['admin1@hopital.sn', 'admin2@hopital.sn']));
    for (const notification of created) {
      expect(notification.channel).toBe('EMAIL');
      expect(notification.templateKind).toBe('SUBSCRIPTION_WELCOME');
      expect(notification.status).toBe('PENDING');
      expect(notification.sourceEventId).toBe(envelope().id);
    }
  });

  it("n'ecrit rien si aucun ADMIN_ETABLISSEMENT n'est resolvable — jamais une erreur (rien a reessayer)", async () => {
    const { handler, notificationRepository } = build();
    await expect(handler(envelope())).resolves.toBeUndefined();
    expect(notificationRepository.all()).toHaveLength(0);
  });

  it('leve si tenantId est absent de l_enveloppe (anomalie — un evenement Subscription porte toujours un tenant)', async () => {
    const { handler } = build();
    await expect(handler(envelope({ tenantId: null }))).rejects.toThrow();
  });

  it("n'extrait AUCUN champ du payload (planId/trialEndsAt) — contenu ferme par gabarit, ADR-0007 §7", async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seed(TENANT_A, ['admin@hopital.sn']);

    // Payload volontairement DIFFERENT/corrompu — ne doit avoir aucune influence sur le resultat.
    await handler(envelope({ payload: { anything: 'unexpected-shape' } }));

    expect(notificationRepository.all()).toHaveLength(1);
  });

  it('redelivrance (meme evenement) : idempotent par construction — ne cree pas de seconde ligne (defense de 2e niveau, unicite sourceEventId+channel)', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seed(TENANT_A, ['admin@hopital.sn']);

    await handler(envelope());
    await handler(envelope());

    expect(notificationRepository.all()).toHaveLength(1);
  });
});
