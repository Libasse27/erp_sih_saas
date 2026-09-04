import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { FixedClock, InMemoryUnitOfWork, SequentialIdGenerator, uuidAt } from '../../../../../test/identity/builders/testKit.js';
import { InMemoryNotificationRepository, InMemoryRecipientDirectory } from '../../../../../test/notifications/builders/testKit.js';
import { createSendSuperAdminBreakGlassRequestedAlertHandler } from './SendSuperAdminBreakGlassRequestedAlert.js';

const B_REQUESTER = uuidAt(101);
const A_SUBJECT = uuidAt(102);
const D_OTHER_SUPER_ADMIN = uuidAt(103);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(1),
    eventType: 'identity.super-admin-break-glass.requested',
    eventVersion: 1,
    aggregateId: uuidAt(2),
    tenantId: null,
    occurredAt: new Date('2026-09-03T10:00:00.000Z'),
    payload: { requestedByUserId: B_REQUESTER, subjectUserAccountId: A_SUBJECT },
    ...overrides,
  };
}

describe('SendSuperAdminBreakGlassRequestedAlert (ADR-0005 Amendement 1, O-04 residu 4)', () => {
  function build() {
    const notificationRepository = new InMemoryNotificationRepository();
    const recipientDirectory = new InMemoryRecipientDirectory();
    const handler = createSendSuperAdminBreakGlassRequestedAlertHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork: new InMemoryUnitOfWork(),
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock('2026-09-03T10:00:00.000Z'),
    });
    return { handler, notificationRepository, recipientDirectory };
  }

  it('alerte TOUS les SUPER_ADMIN actifs SAUF le demandeur (B) — le sujet (A) EST notifie (signal anti-abus voulu)', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(B_REQUESTER, 'b-requester@sih.test');
    recipientDirectory.seedSuperAdmin(A_SUBJECT, 'a-subject@sih.test');
    recipientDirectory.seedSuperAdmin(D_OTHER_SUPER_ADMIN, 'd-other@sih.test');

    await handler(envelope());

    const created = notificationRepository.all();
    expect(new Set(created.map((n) => n.recipient))).toEqual(new Set(['a-subject@sih.test', 'd-other@sih.test']));
    for (const notification of created) {
      expect(notification.channel).toBe('EMAIL');
      expect(notification.templateKind).toBe('SUPER_ADMIN_BREAK_GLASS_REQUESTED');
      expect(notification.tenantId).toBeNull();
      expect(notification.status).toBe('PENDING');
    }
  });

  it("n'ecrit rien si aucun autre SUPER_ADMIN n'est actif — jamais une erreur (rien a reessayer)", async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(B_REQUESTER, 'b-requester@sih.test');

    await expect(handler(envelope())).resolves.toBeUndefined();
    expect(notificationRepository.all()).toHaveLength(0);
  });

  it('leve si le payload est invalide (requestedByUserId absent) — anomalie, jamais une identite devinee', async () => {
    const { handler } = build();
    await expect(handler(envelope({ payload: { subjectUserAccountId: A_SUBJECT } }))).rejects.toThrow();
  });

  it("n'extrait AUCUN champ sensible (motif, sujet) — contenu ferme par gabarit, ADR-0007 §7", async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(D_OTHER_SUPER_ADMIN, 'd-other@sih.test');

    await handler(envelope({ payload: { requestedByUserId: B_REQUESTER, subjectUserAccountId: A_SUBJECT, reason: 'ne doit jamais fuiter' } }));

    const created = notificationRepository.all();
    expect(created).toHaveLength(1);
  });

  it('redelivrance (meme evenement) : idempotent par construction — ne cree pas de seconde ligne', async () => {
    const { handler, notificationRepository, recipientDirectory } = build();
    recipientDirectory.seedSuperAdmin(D_OTHER_SUPER_ADMIN, 'd-other@sih.test');

    await handler(envelope());
    await handler(envelope());

    expect(notificationRepository.all()).toHaveLength(1);
  });
});
