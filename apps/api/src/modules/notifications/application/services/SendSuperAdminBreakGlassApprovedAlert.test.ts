import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { FixedClock, InMemoryUnitOfWork, SequentialIdGenerator, uuidAt } from '../../../../../test/identity/builders/testKit.js';
import { InMemoryNotificationRepository, InMemoryRecipientDirectory } from '../../../../../test/notifications/builders/testKit.js';
import { createSendSuperAdminBreakGlassApprovedAlertHandler } from './SendSuperAdminBreakGlassApprovedAlert.js';

const B_REQUESTER = uuidAt(101);
const A_SUBJECT = uuidAt(102);
const C_APPROVER = uuidAt(103);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(1),
    eventType: 'identity.super-admin-break-glass.approved',
    eventVersion: 1,
    aggregateId: uuidAt(2),
    tenantId: null,
    occurredAt: new Date('2026-09-03T10:00:00.000Z'),
    payload: { requestedByUserId: B_REQUESTER, approvedByUserId: C_APPROVER, subjectUserAccountId: A_SUBJECT },
    ...overrides,
  };
}

describe('SendSuperAdminBreakGlassApprovedAlert (ADR-0005 Amendement 1, O-04 residu 4)', () => {
  function build() {
    const notificationRepository = new InMemoryNotificationRepository();
    const recipientDirectory = new InMemoryRecipientDirectory();
    const handler = createSendSuperAdminBreakGlassApprovedAlertHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork: new InMemoryUnitOfWork(),
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock('2026-09-03T10:00:00.000Z'),
    });
    return { handler, notificationRepository, recipientDirectory };
  }

  it("alerte TOUS les SUPER_ADMIN actifs SAUF l'approbateur (C) — le demandeur (B) ET le sujet (A) SONT notifies (issue nouvelle pour eux)", async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(B_REQUESTER, 'b-requester@sih.test');
    recipientDirectory.seedSuperAdmin(A_SUBJECT, 'a-subject@sih.test');
    recipientDirectory.seedSuperAdmin(C_APPROVER, 'c-approver@sih.test');

    await handler(envelope());

    const created = notificationRepository.all();
    expect(new Set(created.map((n) => n.recipient))).toEqual(new Set(['b-requester@sih.test', 'a-subject@sih.test']));
    for (const notification of created) {
      expect(notification.channel).toBe('EMAIL');
      expect(notification.templateKind).toBe('SUPER_ADMIN_BREAK_GLASS_APPROVED');
      expect(notification.tenantId).toBeNull();
    }
  });

  it("n'ecrit rien si aucun autre SUPER_ADMIN n'est actif", async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(C_APPROVER, 'c-approver@sih.test');

    await expect(handler(envelope())).resolves.toBeUndefined();
    expect(notificationRepository.all()).toHaveLength(0);
  });

  it('leve si le payload est invalide (approvedByUserId absent)', async () => {
    const { handler } = build();
    await expect(handler(envelope({ payload: { requestedByUserId: B_REQUESTER, subjectUserAccountId: A_SUBJECT } }))).rejects.toThrow();
  });

  it('redelivrance (meme evenement) : idempotent par construction — ne cree pas de seconde ligne', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(B_REQUESTER, 'b-requester@sih.test');

    await handler(envelope());
    await handler(envelope());

    expect(notificationRepository.all()).toHaveLength(1);
  });
});
