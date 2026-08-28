import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import {
  FixedClock,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { InMemoryNotificationRepository, InMemoryRecipientDirectory } from '../../../../../test/notifications/builders/testKit.js';
import { createSendPlanChangeConfirmationOnPlanChangedHandler } from './SendPlanChangeConfirmationOnPlanChanged.js';

const TENANT_A = uuidAt(9201);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(11),
    eventType: 'subscription.subscription.plan-changed',
    eventVersion: 1,
    aggregateId: uuidAt(12),
    tenantId: TENANT_A,
    occurredAt: new Date('2026-08-28T00:00:00.000Z'),
    payload: { tenantId: TENANT_A, fromPlanId: uuidAt(13), toPlanId: uuidAt(14) },
    ...overrides,
  };
}

describe('SendPlanChangeConfirmationOnPlanChanged (ADR-0007 §1)', () => {
  function build() {
    const notificationRepository = new InMemoryNotificationRepository();
    const recipientDirectory = new InMemoryRecipientDirectory();
    const handler = createSendPlanChangeConfirmationOnPlanChangedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork: new InMemoryUnitOfWork(),
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock('2026-08-28T00:00:00.000Z'),
    });
    return { handler, notificationRepository, recipientDirectory };
  }

  it('cree une Notification EMAIL SUBSCRIPTION_PLAN_CHANGED pour chaque ADMIN_ETABLISSEMENT resolu', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seed(TENANT_A, ['admin@hopital.sn']);

    await handler(envelope());

    const created = notificationRepository.all();
    expect(created).toHaveLength(1);
    expect(created[0]?.templateKind).toBe('SUBSCRIPTION_PLAN_CHANGED');
    expect(created[0]?.channel).toBe('EMAIL');
  });

  it("n'ecrit rien si aucun destinataire n'est resolvable", async () => {
    const { handler, notificationRepository } = build();
    await handler(envelope());
    expect(notificationRepository.all()).toHaveLength(0);
  });

  it('leve si tenantId est absent de l_enveloppe', async () => {
    const { handler } = build();
    await expect(handler(envelope({ tenantId: null }))).rejects.toThrow();
  });

  it('redelivrance : idempotent, ne cree pas de seconde ligne', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seed(TENANT_A, ['admin@hopital.sn']);

    await handler(envelope());
    await handler(envelope());

    expect(notificationRepository.all()).toHaveLength(1);
  });
});
