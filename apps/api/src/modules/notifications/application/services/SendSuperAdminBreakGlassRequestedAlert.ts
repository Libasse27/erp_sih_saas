import { z } from 'zod';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { Notification } from '../../domain/Notification.js';
import { NotificationId } from '../../domain/value-objects/NotificationId.js';
import type { NotificationRepository } from '../../domain/ports/NotificationRepository.js';
import type { RecipientDirectory } from '../ports/RecipientDirectory.js';

/** Forme attendue du payload de `identity.super-admin-break-glass.requested` (module `identity`) — voir le commentaire equivalent dans GrantOwnerMembershipOnSubscriptionStarted.ts sur la raison d'un schema de frontiere ici : ce module ne partage AUCUN type statique avec `identity`. */
const SuperAdminBreakGlassRequestedPayloadSchema = z
  .object({
    requestedByUserId: z.string().min(1),
  })
  .passthrough();

/**
 * Consommateur Outbox de `identity.super-admin-break-glass.requested` (module `identity`) cote
 * Notifications — alerte IMMEDIATE des autres `SUPER_ADMIN` actifs a l'ouverture d'une demande de
 * recuperation break-glass (ADR-0005 Amendement 1, O-04 residu 4). Le demandeur (B) lui-meme n'est
 * jamais notifie de sa propre action (`RecipientDirectory.findActiveSuperAdminEmails`, meme
 * discipline que `findTenantAdminEmails`) — le sujet (A), lui, EST notifie : recevoir cette alerte
 * sur son propre compte est un signal anti-abus voulu, jamais une omission.
 *
 * Platform-level (jamais tenant-scope) : `tenantId: null`, `unitOfWork.withTransaction` appele
 * SANS contexte `{ tenantId }` — meme regime que les ecritures Identity hors RLS
 * (`RefreshToken`/`MfaEnrollment`).
 *
 * N'extrait AUCUN champ sensible du payload (motif, sujet) — gabarit FERME
 * (`NotificationTemplates.ts`, ADR-0007 §7) : seul `requestedByUserId` est lu, uniquement pour
 * exclure son destinataire, jamais pour composer un contenu.
 *
 * IDEMPOTENT PAR CONSTRUCTION (seconde ligne de defense, derriere `withOutboxIdempotency`) : voir
 * `SendWelcomeEmailOnSubscriptionStarted.ts` pour le detail (meme `createMany({ skipDuplicates:
 * true })` sur `(sourceEventId, channel, recipient)`).
 */
export function createSendSuperAdminBreakGlassRequestedAlertHandler(deps: {
  notificationRepository: NotificationRepository;
  recipientDirectory: RecipientDirectory;
  unitOfWork: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const parsed = SuperAdminBreakGlassRequestedPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      throw new Error(
        `Payload invalide pour ${envelope.eventType} (outbox message ${envelope.id}) : ${parsed.error.message}`,
      );
    }
    const { requestedByUserId } = parsed.data;

    const recipients = await deps.recipientDirectory.findActiveSuperAdminEmails(requestedByUserId);
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
          templateKind: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED',
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
