import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Notification } from '../../domain/Notification.js';
import { NotificationId } from '../../domain/value-objects/NotificationId.js';
import type { NotificationRepository } from '../../domain/ports/NotificationRepository.js';
import type { RecipientDirectory } from '../ports/RecipientDirectory.js';

/**
 * Consommateur Outbox de `SubscriptionStarted` (module `subscription`) cote Notifications — email
 * de bienvenue (hook designe des l'etape 4/13, voir docs/domain/events.md et ADR-0007 §1).
 *
 * N'extrait AUCUN champ du payload de l'evenement (`planId`/`trialEndsAt`) : le contenu de la
 * notification est un gabarit FERME (`NotificationTemplates.ts`, ADR-0007 §7), jamais assemble
 * depuis des donnees d'evenement — seul `envelope.tenantId` (colonne Postgres, jamais le payload)
 * et `envelope.id` (cle d'idempotence, = `DomainEvent.eventId`, voir OutboxWriter.ts) sont
 * utilises.
 *
 * IDEMPOTENT PAR CONSTRUCTION (seconde ligne de defense, derriere `withOutboxIdempotency`) :
 * `NotificationRepository.create()` est un `createMany({ skipDuplicates: true })` sur la
 * contrainte `(sourceEventId, channel, recipient)` — une redelivrance ne cree jamais une seconde ligne.
 */
export function createSendWelcomeEmailOnSubscriptionStartedHandler(deps: {
  notificationRepository: NotificationRepository;
  recipientDirectory: RecipientDirectory;
  unitOfWork: UnitOfWork;
  idGenerator: IdGenerator;
  clock: Clock;
}): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    if (envelope.tenantId === null) {
      throw new Error(
        `tenantId absent sur l'enveloppe de ${envelope.eventType} (message ${envelope.id}) — un evenement Subscription porte toujours un tenant.`,
      );
    }
    const tenantIdResult = TenantId.create(envelope.tenantId);
    if (tenantIdResult.isFailure()) {
      throw new Error(`tenantId invalide sur l'enveloppe de ${envelope.eventType} (message ${envelope.id}).`);
    }
    const tenantId = tenantIdResult.getValue();

    const recipients = await deps.recipientDirectory.findTenantAdminEmails(tenantId.toString());
    if (recipients.length === 0) {
      // Aucun ADMIN_ETABLISSEMENT resolvable pour ce tenant a cet instant — rien a notifier,
      // jamais une erreur de traitement (rien a reessayer).
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
          tenantId,
          channel: 'EMAIL',
          recipient: email,
          templateKind: 'SUBSCRIPTION_WELCOME',
          sourceEventId: envelope.id,
          now: deps.clock.now(),
        });
        if (notificationResult.isFailure()) {
          // Email deja valide en amont (Email VO d'Identity) — une valeur invalide ici trahirait
          // une corruption, pas un echec metier attendu.
          throw notificationResult.getError();
        }
        await deps.notificationRepository.create(notificationResult.getValue());
      }
    }, { tenantId });
  };
}
