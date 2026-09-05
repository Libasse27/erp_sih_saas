import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { ConfirmPaymentHandler, type ConfirmPaymentLogger } from '../application/commands/ConfirmPayment.js';
import { InitiatePaymentHandler } from '../application/commands/InitiatePayment.js';
import { GetPlatformInvoiceBySourceReferenceHandler } from '../application/queries/GetPlatformInvoiceBySourceReference.js';
import { createIssuePlatformInvoiceOnRenewalDueHandler } from '../application/services/IssuePlatformInvoiceOnRenewalDue.js';
import { createIssuePlatformInvoiceOnUpgradeRequestedHandler } from '../application/services/IssuePlatformInvoiceOnUpgradeRequested.js';
import { createMarkPlatformInvoicePaidOnPaymentSucceededHandler } from '../application/services/MarkPlatformInvoicePaidOnPaymentSucceeded.js';
import { ReconcilePendingPaymentsHandler } from '../application/services/ReconcilePendingPayments.js';
import type { PaymentProvider } from '../domain/ports/PaymentProvider.js';
import type { PaymentRepository } from '../domain/ports/PaymentRepository.js';
import type { PlatformInvoiceRepository } from '../domain/ports/PlatformInvoiceRepository.js';
import type { BillingAuditTrail } from '../application/ports/BillingAuditTrail.js';
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
  /** Lectures exposees par ce module — separees des `handlers` (commandes, mutantes) pour que la frontiere lecture/ecriture reste lisible depuis le composition-root. */
  readonly queries: {
    readonly getPlatformInvoiceBySourceReference: GetPlatformInvoiceBySourceReferenceHandler;
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
    readonly issuePlatformInvoiceOnUpgradeRequested: ReturnType<typeof createIssuePlatformInvoiceOnUpgradeRequestedHandler>;
    readonly markPlatformInvoicePaidOnPaymentSucceeded: ReturnType<typeof createMarkPlatformInvoicePaidOnPaymentSucceededHandler>;
  };
  readonly presentation: {
    readonly webhookController: PaymentWebhookController;
    /**
     * ADR-0011 §3/§5/§7 — guard `createSilentRateLimitGuard` (shared-kernel), CONSTRUIT
     * exclusivement dans `composition-root.ts` (jamais ici : cette factory partagee ne connait ni
     * `payment` ni `audit`) et simplement RECU en dependance, comme `webhookControllerLogger`
     * ci-dessous. Monte en PREMIER middleware de la route dans `server.ts`, AVANT
     * `express.raw()`.
     */
    readonly rateLimitWebhook: RequestHandler;
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
  /** Port sortant vers le module `audit`, categorie `BILLING` (ADR-0009 §2.2/§4) — l'adaptateur reel est cable par composition-root.ts. */
  billingAuditTrail: BillingAuditTrail;
  /** ADR-0011 §3/§5/§7 — deja CONSTRUIT par `composition-root.ts` (`createSilentRateLimitGuard`), simplement transmis a la presentation de ce module. */
  rateLimitWebhook: RequestHandler;
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
    deps.billingAuditTrail,
  );
  const confirmPayment = new ConfirmPaymentHandler(
    payments,
    platformInvoices,
    deps.paymentProvider,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
    deps.billingAuditTrail,
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
    billingAuditTrail: deps.billingAuditTrail,
    unitOfWork,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });
  const issuePlatformInvoiceOnUpgradeRequested = createIssuePlatformInvoiceOnUpgradeRequestedHandler({
    platformInvoiceRepository: platformInvoices,
    billingAuditTrail: deps.billingAuditTrail,
    unitOfWork,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });
  const markPlatformInvoicePaidOnPaymentSucceeded = createMarkPlatformInvoicePaidOnPaymentSucceededHandler({
    platformInvoiceRepository: platformInvoices,
    billingAuditTrail: deps.billingAuditTrail,
    unitOfWork,
    clock: deps.clock,
  });

  return {
    repositories: { payments, platformInvoices },
    unitOfWork,
    handlers: { initiatePayment, confirmPayment },
    queries: {
      getPlatformInvoiceBySourceReference: new GetPlatformInvoiceBySourceReferenceHandler(platformInvoices),
    },
    services: { reconcilePendingPayments },
    outboxHandlers: {
      issuePlatformInvoiceOnRenewalDue,
      issuePlatformInvoiceOnUpgradeRequested,
      markPlatformInvoicePaidOnPaymentSucceeded,
    },
    presentation: {
      webhookController: new PaymentWebhookController(confirmPayment, deps.webhookControllerLogger),
      rateLimitWebhook: deps.rateLimitWebhook,
    },
  };
}
