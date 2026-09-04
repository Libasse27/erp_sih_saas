import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { Notification } from '../../domain/Notification.js';
import { NotificationId } from '../../domain/value-objects/NotificationId.js';
import type { NotificationRepository } from '../../domain/ports/NotificationRepository.js';
import type { RecipientDirectory } from '../ports/RecipientDirectory.js';

/** Forme attendue du payload de `identity.super-admin-break-glass.approved` (module `identity`) — voir le commentaire equivalent dans GrantOwnerMembershipOnSubscriptionStarted.ts. */
const SuperAdminBreakGlassApprovedPayloadSchema = z
  .object({
    approvedByUserId: z.string().min(1),
  })
  .passthrough();

/**
 * Consommateur Outbox de `identity.super-admin-break-glass.approved` (module `identity`) cote
 * Notifications — alerte de RESULTAT aux autres `SUPER_ADMIN` actifs quand une demande de
 * recuperation break-glass est approuvee et executee (ADR-0005 Amendement 1, O-04 residu 4).
 * Seul l'approbateur (C) est exclu (`RecipientDirectory.findActiveSuperAdminEmails`) : le
 * demandeur (B) ET le sujet (A) sont notifies — c'est pour eux une information NOUVELLE (l'issue
 * de la demande), jamais une notification de leur propre action.
 *
 * Platform-level (jamais tenant-scope), gabarit FERME — meme discipline que
 * `SendSuperAdminBreakGlassRequestedAlert.ts` (voir ce fichier pour le detail complet).
 */
export function createSendSuperAdminBreakGlassApprovedAlertHandler(deps: {
  notificationRepository: NotificationRepository;
  recipientDirectory: RecipientDirectory;
  unitOfWork: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SuperAdminBreakGlassApprovedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const { approvedByUserId } = parsed.data;

    const recipients = await deps.recipientDirectory.findActiveSuperAdminEmails(approvedByUserId);
    if (recipients.length === 0) {
      return;
    }

    await deps.unitOfWork.withTransaction(async () => {
      for (const email of recipients) {
        const idResult = NotificationId.create(deps.idGenerator.generate());
        if (idResult.isFailure()) {
          throw new Error('IdGenerator a produit un identifiant invalide pour Notification.');
        }
        const notificationResult = Notification.create({
          id: idResult.getValue(),
          tenantId: null,
          channel: 'EMAIL',
          recipient: email,
          templateKind: 'SUPER_ADMIN_BREAK_GLASS_APPROVED',
          sourceEventId: envelope.id,
          now: deps.clock.now(),
        });
        if (notificationResult.isFailure()) {
          throw notificationResult.getError();
        }
        await deps.notificationRepository.create(notificationResult.getValue());
      }
    });
  };
}
