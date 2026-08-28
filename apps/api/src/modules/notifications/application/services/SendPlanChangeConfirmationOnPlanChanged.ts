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
 * Consommateur Outbox de `SubscriptionPlanChanged` (module `subscription`) cote Notifications —
 * confirmation de changement de forfait (hook designe des l'etape 4/13, voir
 * docs/domain/events.md et ADR-0007 §1). Meme raisonnement complet que
 * `SendWelcomeEmailOnSubscriptionStarted.ts` (aucun champ du payload — `fromPlanId`/`toPlanId` —
 * n'est extrait ni transmis, gabarit ferme, idempotence a deux niveaux) : voir ce fichier pour le
 * detail.
 */
export function createSendPlanChangeConfirmationOnPlanChangedHandler(deps: {
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
          templateKind: 'SUBSCRIPTION_PLAN_CHANGED',
          sourceEventId: envelope.id,
          now: deps.clock.now(),
        });
        if (notificationResult.isFailure()) {
          throw notificationResult.getError();
        }
        await deps.notificationRepository.create(notificationResult.getValue());
      }
    }, { tenantId });
  };
}
