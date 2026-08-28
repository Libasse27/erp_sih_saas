import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { createSendWelcomeEmailOnSubscriptionStartedHandler } from '../application/services/SendWelcomeEmailOnSubscriptionStarted.js';
import { createSendPlanChangeConfirmationOnPlanChangedHandler } from '../application/services/SendPlanChangeConfirmationOnPlanChanged.js';
import type { RecipientDirectory } from '../application/ports/RecipientDirectory.js';
import type { NotificationRepository } from '../domain/ports/NotificationRepository.js';
import { PrismaNotificationRepository } from './persistence/PrismaNotificationRepository.js';

export interface NotificationModule {
  readonly repositories: {
    readonly notifications: NotificationRepository;
  };
  /**
   * Consommateurs Outbox exposes par CE module (jamais cables ici eux-memes — voir
   * composition-root.ts, seul endroit autorise a connaitre plusieurs modules pour construire le
   * registre `eventType -> handlers[]` du relais). Meme regime que `PaymentModule.outboxHandlers`.
   */
  readonly outboxHandlers: {
    readonly sendWelcomeEmailOnSubscriptionStarted: ReturnType<typeof createSendWelcomeEmailOnSubscriptionStartedHandler>;
    readonly sendPlanChangeConfirmationOnPlanChanged: ReturnType<typeof createSendPlanChangeConfirmationOnPlanChangedHandler>;
  };
}

/**
 * Cablage du module Notifications (Phase 0, etape 9/13, ADR-0007). Le pipeline de LIVRAISON
 * (relais + worker BullMQ, EmailProvider/SmsProvider) n'est PAS construit ici — il vit directement
 * dans `composition-root.ts`, exactement comme `outboxWorker`/`outboxQueue` pour l'Outbox
 * generique (ce module n'expose que ses consommateurs Outbox et son repository).
 */
export function buildNotificationModule(deps: {
  prisma: PrismaClient;
  clock: Clock;
  idGenerator: IdGenerator;
  recipientDirectory: RecipientDirectory;
}): NotificationModule {
  const notifications = new PrismaNotificationRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);

  const sendWelcomeEmailOnSubscriptionStarted = createSendWelcomeEmailOnSubscriptionStartedHandler({
    notificationRepository: notifications,
    recipientDirectory: deps.recipientDirectory,
    unitOfWork,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  });
  const sendPlanChangeConfirmationOnPlanChanged = createSendPlanChangeConfirmationOnPlanChangedHandler({
    notificationRepository: notifications,
    recipientDirectory: deps.recipientDirectory,
    unitOfWork,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  });

  return {
    repositories: { notifications },
    outboxHandlers: { sendWelcomeEmailOnSubscriptionStarted, sendPlanChangeConfirmationOnPlanChanged },
  };
}
