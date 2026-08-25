import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { ConfirmPaymentHandler, type ConfirmPaymentLogger } from '../application/commands/ConfirmPayment.js';
import { InitiatePaymentHandler } from '../application/commands/InitiatePayment.js';
import { createIssuePlatformInvoiceOnRenewalDueHandler } from '../application/services/IssuePlatformInvoiceOnRenewalDue.js';
import { createMarkPlatformInvoicePaidOnPaymentSucceededHandler } from '../application/services/MarkPlatformInvoicePaidOnPaymentSucceeded.js';
import { ReconcilePendingPaymentsHandler } from '../application/services/ReconcilePendingPayments.js';
import type { PaymentProvider } from '../domain/ports/PaymentProvider.js';
import type { PaymentRepository } from '../domain/ports/PaymentRepository.js';
import type { PlatformInvoiceRepository } from '../domain/ports/PlatformInvoiceRepository.js';
import { PrismaPaymentRepository } from './persistence/PrismaPaymentRepository.js';
import { PrismaPlatformInvoiceRepository } from './persistence/PrismaPlatformInvoiceRepository.js';
import { PaymentWebhookController, type PaymentWebhookControllerLogger } from '../presentation/http/PaymentWebhookController.js';

export interface PaymentModule {
  readonly repositories: {
    readonly payments: PaymentRepository;
    readonly platformInvoices: PlatformInvoiceRepository;
  };
  readonly unitOfWork: UnitOfWork;
  readonly handlers: {
    readonly initiatePayment: InitiatePaymentHandler;
    readonly confirmPayment: ConfirmPaymentHandler;
  };
  readonly services: {
    readonly reconcilePendingPayments: ReconcilePendingPaymentsHandler;
  };
  /**
   * Consommateurs Outbox exposes par CE module (jamais cables ici eux-memes — voir
   * composition-root.ts, seul endroit autorise a connaitre plusieurs modules pour construire le
   * registre `eventType -> handlers[]` du relais).
   */
  readonly outboxHandlers: {
    readonly issuePlatformInvoiceOnRenewalDue: ReturnType<typeof createIssuePlatformInvoiceOnRenewalDueHandler>;
    readonly markPlatformInvoicePaidOnPaymentSucceeded: ReturnType<typeof createMarkPlatformInvoicePaidOnPaymentSucceededHandler>;
  };
  readonly presentation: {
    readonly webhookController: PaymentWebhookController;
  };
}

/**
 * Cablage du module Payment (Phase 0, etape 5/13). Instancie son propre `PgUnitOfWork` — meme
 * raisonnement que SubscriptionModule.ts/TenantModule.ts : adaptateur sans etat propre au-dela du
 * `PrismaClient` partage.
 */
export function buildPaymentModule(deps: {
  prisma: PrismaClient;
  clock: Clock;
  idGenerator: IdGenerator;
  paymentProvider: PaymentProvider;
  confirmPaymentLogger?: ConfirmPaymentLogger;
  webhookControllerLogger?: PaymentWebhookControllerLogger;
}): PaymentModule {
  const payments = new PrismaPaymentRepository(deps.prisma);
  const platformInvoices = new PrismaPlatformInvoiceRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);

  const initiatePayment = new InitiatePaymentHandler(
    platformInvoices,
    payments,
    deps.paymentProvider,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );
  const confirmPayment = new ConfirmPaymentHandler(
    payments,
    platformInvoices,
    deps.paymentProvider,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
    deps.confirmPaymentLogger,
  );
  const reconcilePendingPayments = new ReconcilePendingPaymentsHandler(
    payments,
    platformInvoices,
    deps.paymentProvider,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );

  const issuePlatformInvoiceOnRenewalDue = createIssuePlatformInvoiceOnRenewalDueHandler({
    platformInvoiceRepository: platformInvoices,
    unitOfWork,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });
  const markPlatformInvoicePaidOnPaymentSucceeded = createMarkPlatformInvoicePaidOnPaymentSucceededHandler({
    platformInvoiceRepository: platformInvoices,
    unitOfWork,
    clock: deps.clock,
  });

  return {
    repositories: { payments, platformInvoices },
    unitOfWork,
    handlers: { initiatePayment, confirmPayment },
    services: { reconcilePendingPayments },
    outboxHandlers: { issuePlatformInvoiceOnRenewalDue, markPlatformInvoicePaidOnPaymentSucceeded },
    presentation: {
      webhookController: new PaymentWebhookController(confirmPayment, deps.webhookControllerLogger),
    },
  };
}
