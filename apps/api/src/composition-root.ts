import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { Clock } from './shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from './shared-kernel/domain/ports/IdGenerator.js';
import { TenantId } from './shared-kernel/domain/value-objects/TenantId.js';
import { SystemClock } from './shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from './shared-kernel/infrastructure/UuidGenerator.js';
import { ConsoleStructuredLogger } from './shared-kernel/infrastructure/ConsoleStructuredLogger.js';
import { relayOutboxOnce } from './shared-kernel/infrastructure/persistence/OutboxRelay.js';
import { withOutboxIdempotency } from './shared-kernel/infrastructure/persistence/OutboxIdempotencyGuard.js';
import { startPeriodicJob, type PeriodicJobHandle } from './shared-kernel/infrastructure/persistence/PeriodicJobRunner.js';
import { createOutboxQueueConnection } from './shared-kernel/infrastructure/queue/OutboxQueueConnection.js';
import { createOutboxWorker } from './shared-kernel/infrastructure/queue/OutboxWorker.js';
import { OUTBOX_QUEUE_NAME, type OutboxJobData } from './shared-kernel/infrastructure/queue/OutboxJob.js';
import type { OutboxEventHandler } from './shared-kernel/application/OutboxEventHandler.js';
import { loadEnv, type Env } from './config/env.js';
import { buildIdentityModule, type IdentityModule } from './modules/identity/infrastructure/IdentityModule.js';
import type {
  TenantAccessChecker,
  TenantAccessStatus,
} from './modules/identity/application/ports/TenantAccessChecker.js';
import type { AuditRecordInput, AuditTrail } from './modules/identity/application/ports/AuditTrail.js';
import type { SessionAuditRecordInput, SessionAuditTrail } from './modules/identity/application/ports/SessionAuditTrail.js';
import { buildAuditModule, type AuditModule } from './modules/audit/infrastructure/AuditModule.js';
import { buildTenantModule, type TenantModule } from './modules/tenant/infrastructure/TenantModule.js';
import {
  buildSubscriptionModule,
  type SubscriptionModule,
} from './modules/subscription/infrastructure/SubscriptionModule.js';
import { buildPaymentModule, type PaymentModule } from './modules/payment/infrastructure/PaymentModule.js';
import { SandboxPaymentProviderAdapter } from './modules/payment/infrastructure/payment-provider/SandboxPaymentProviderAdapter.js';
import { startSubscriptionRenewalScheduler } from './modules/subscription/infrastructure/scheduler/SubscriptionRenewalScheduler.js';
import { startPaymentReconciliationScheduler } from './modules/payment/infrastructure/scheduler/PaymentReconciliationScheduler.js';
import { buildNotificationModule, type NotificationModule } from './modules/notifications/infrastructure/NotificationModule.js';
import type { RecipientDirectory } from './modules/notifications/application/ports/RecipientDirectory.js';
import { SandboxEmailProviderAdapter } from './modules/notifications/infrastructure/providers/SandboxEmailProviderAdapter.js';
import { SandboxSmsProviderAdapter } from './modules/notifications/infrastructure/providers/SandboxSmsProviderAdapter.js';
import { relayNotificationsOnce } from './modules/notifications/infrastructure/persistence/NotificationRelay.js';
import { createNotificationWorker } from './modules/notifications/infrastructure/queue/NotificationWorker.js';
import { NOTIFICATION_QUEUE_NAME, type NotificationJobData } from './modules/notifications/infrastructure/queue/NotificationJob.js';

/**
 * Adaptateur cross-module implementant le port `TenantAccessChecker` d'Identity en s'appuyant
 * sur le `HealthFacilityRepository` de Tenant. Vit ICI et nulle part ailleurs : c'est le seul
 * point du code autorise a connaitre les deux modules a la fois (01-target-architecture.md §5
 * — "un module n'importe jamais le domain/ d'un autre module ; les echanges passent par des
 * evenements ou des ports explicites"). Ni Identity ni Tenant n'importent l'un le domain/ de
 * l'autre : Identity ne connait que son propre port, Tenant ne connait meme pas l'existence
 * d'Identity. C'est ICI, et nulle part ailleurs, que le statut `FacilityStatus` du domain
 * Tenant (`ACTIVE`/`SUSPENDED`) est traduit vers le vocabulaire propre a Identity
 * (`TenantAccessStatus`) — la seule methode autorisee a lire `HealthFacility.isActive()`.
 */
class TenantModuleBackedAccessChecker implements TenantAccessChecker {
  constructor(private readonly tenant: TenantModule) {}

  async checkAccess(tenantId: TenantId): Promise<TenantAccessStatus> {
    const facility = await this.tenant.repositories.healthFacilities.findByTenantId(tenantId);
    if (facility === null) {
      return 'NOT_FOUND';
    }
    return facility.isActive() ? 'ACCESSIBLE' : 'SUSPENDED';
  }
}

/**
 * Adaptateur cross-module implementant le port `AuditTrail` d'Identity en s'appuyant sur le
 * module `audit` (ADR-0005 §5). Vit ICI et nulle part ailleurs — meme raisonnement que
 * `TenantModuleBackedAccessChecker` ci-dessus : c'est le seul point du code autorise a traduire
 * l'union primitive `MfaAuditEventType` (Identity) vers les VO du module `audit`
 * (`AuditCategory`/`AuditEventType`/`AuditOutcome`). La categorie est fixee a `'MFA'` : cet
 * adaptateur ne sert QUE le port MFA d'Identity a cette etape (un futur module qui ecrirait
 * d'autres categories d'audit aurait son propre adaptateur, jamais celui-ci etendu par un
 * `if` sur l'appelant).
 */
class AuditModuleBackedAuditTrail implements AuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'MFA',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Adaptateur cross-module implementant le port `SessionAuditTrail` d'Identity en s'appuyant sur
 * le module `audit` (ADR-0006 §8, etape 8/13). Port DEDIE, categorie fixee a `'SESSION'` — jamais
 * une extension de `AuditModuleBackedAuditTrail` ci-dessus (meme raisonnement qu'ADR-0005 §5,
 * alternative 7 explicitement ecartee : "un futur module qui ecrirait d'autres categories
 * d'audit aurait son propre adaptateur, jamais celui-ci etendu par un `if` sur l'appelant").
 */
class AuditModuleBackedSessionAuditTrail implements SessionAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: SessionAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'SESSION',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Adaptateur cross-module implementant le port `RecipientDirectory` de Notifications en
 * s'appuyant sur les repositories d'Identity (ADR-0007 §4, etape 9/13). Vit ICI et nulle part
 * ailleurs — meme raisonnement que `TenantModuleBackedAccessChecker` : c'est le seul point du
 * code autorise a connaitre Identity ET Notifications a la fois. Resout les emails des membres
 * ACTIFS portant le role systeme `ADMIN_ETABLISSEMENT` du tenant — audience structurellement
 * designee par O-04.1, jamais une politique de ciblage inventee.
 */
class IdentityModuleBackedRecipientDirectory implements RecipientDirectory {
  constructor(private readonly identity: IdentityModule) {}

  async findTenantAdminEmails(tenantId: string): Promise<readonly string[]> {
    const tenantIdResult = TenantId.create(tenantId);
    if (tenantIdResult.isFailure()) {
      throw new Error(`RecipientDirectory : tenantId invalide ("${tenantId}").`);
    }
    const tenantIdVo = tenantIdResult.getValue();

    const adminRole = await this.identity.repositories.roles.findSystemRoleByCode('ADMIN_ETABLISSEMENT');
    if (adminRole === null) {
      // Catalogue systeme non seede (environnement non provisionne) — rien a notifier, jamais
      // une exception qui ferait echouer indefiniment le consommateur Outbox appelant.
      return [];
    }

    const memberships = await this.identity.unitOfWork.withTransaction(
      () => this.identity.repositories.memberships.listActiveByTenantAndRole(tenantIdVo, adminRole.id),
      { tenantId: tenantIdVo },
    );

    const emails: string[] = [];
    for (const membership of memberships) {
      const account = await this.identity.repositories.userAccounts.findById(membership.userId);
      if (account !== null) {
        emails.push(account.email.value);
      }
    }
    return emails;
  }
}

/**
 * Point de cablage unique des dependances (D3, 01-target-architecture.md §5).
 * Aucun singleton global : chaque entree fait partie de ce conteneur explicite, injecte
 * dans les handlers via le composition root de chaque module au fur et a mesure de leur
 * ajout (Identity, Tenant, Plan/Subscription... — Phase 0, etapes 2+).
 */
export interface CompositionRoot {
  readonly env: Env;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  /** Logger JSON structure partage (voir ConsoleStructuredLogger.ts) — expose ici pour que `server.ts` puisse l'utiliser dans le middleware d'erreur Express global, sans construire un second logger. */
  readonly logger: ConsoleStructuredLogger;
  readonly tenant: TenantModule;
  readonly audit: AuditModule;
  readonly identity: IdentityModule;
  readonly subscription: SubscriptionModule;
  readonly payment: PaymentModule;
  readonly notifications: NotificationModule;
  /**
   * Demarre les 4 processus de fond de cette etape (D9 + O-25.6 + O-25.5 + ADR-0007) : relais
   * Outbox, scheduler de renouvellement d'abonnement, rapprochement de paiements, pipeline de
   * livraison des notifications (relais + worker dedies, ADR-0007 §6). Idempotent a l'appel
   * unique attendu (jamais appele depuis un handler HTTP) — voir server.ts.
   */
  startBackgroundJobs(): void;
  /** Arret propre des jobs de fond (attend la fin du cycle en cours) — a appeler AVANT `shutdown()` lors d'un SIGTERM (§8 exploitation). */
  stopBackgroundJobs(): Promise<void>;
  /** Ferme proprement les connexions (SIGTERM) — appele une seule fois, jamais depuis un handler. */
  shutdown(): Promise<void>;
}

export function buildCompositionRoot(source: NodeJS.ProcessEnv = process.env): CompositionRoot {
  const env = loadEnv(source);
  const clock = new SystemClock();
  const idGenerator = new UuidGenerator();
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  const logger = new ConsoleStructuredLogger();

  // Tenant et Audit cables avant Identity : Identity depend des ports `TenantAccessChecker`
  // (ResolveTenantContextHandler, Phase 0 etape 3) et `AuditTrail` (MFA, etape 7/13), dont les
  // implementations ci-dessous ont besoin des modules Tenant/Audit deja construits. L'inverse
  // n'est jamais vrai : ni Tenant ni Audit ne dependent de rien d'Identity.
  const tenant = buildTenantModule({ prisma, clock, idGenerator });
  const tenantAccessChecker = new TenantModuleBackedAccessChecker(tenant);
  const audit = buildAuditModule({ prisma, clock, idGenerator });
  const auditTrail = new AuditModuleBackedAuditTrail(audit);
  const sessionAuditTrail = new AuditModuleBackedSessionAuditTrail(audit);
  const identity = buildIdentityModule({
    prisma,
    redis,
    clock,
    idGenerator,
    tenantAccessChecker,
    auditTrail,
    sessionAuditTrail,
    mfa: {
      secretEncryptionKey: Buffer.from(env.MFA_SECRET_ENCRYPTION_KEY, 'base64'),
      secretEncryptionKeyId: env.MFA_SECRET_ENCRYPTION_KEY_ID,
      recoveryCodePepper: env.MFA_RECOVERY_CODE_PEPPER,
      recoveryCodePepperId: env.MFA_RECOVERY_CODE_PEPPER_ID,
      totpIssuer: env.MFA_TOTP_ISSUER,
    },
    refreshToken: {
      hashPepper: env.REFRESH_TOKEN_HASH_PEPPER,
      hashPepperId: env.REFRESH_TOKEN_HASH_PEPPER_ID,
    },
  });
  // Subscription (Phase 0, etape 4/13) ne depend d'aucun autre module a ce stade — voir le
  // residu documente dans SubscriptionModule.ts sur l'absence volontaire d'un port
  // TenantAccessChecker cote Subscription (hors perimetre de cette etape).
  const subscription = buildSubscriptionModule({ prisma, clock, idGenerator, applyPlanUpgradeLogger: logger });

  // Prestataire de paiement SANDBOX (O-25.3, residu : "fournisseur de paiement SaaS" non
  // choisi) — SEUL point du code qui construit cet adaptateur ; Payment ne connait que le port
  // `PaymentProvider`.
  const paymentProvider = new SandboxPaymentProviderAdapter(env.PAYMENT_PROVIDER_WEBHOOK_SECRET);
  const payment = buildPaymentModule({
    prisma,
    clock,
    idGenerator,
    paymentProvider,
    confirmPaymentLogger: logger,
    webhookControllerLogger: logger,
  });

  // Notifications (Phase 0, etape 9/13, ADR-0007). Fournisseurs SANDBOX pour Email ET SMS —
  // aucun fournisseur reel choisi pour NI L'UN NI L'AUTRE canal (ADR-0007 §3 : residu O-07.3
  // pour SMS ; Email traite symetriquement pour ne pas prendre implicitement une decision
  // d'infrastructure de production non demandee). SEUL point du code qui construit ces
  // adaptateurs ; Notifications ne connait que les ports `EmailProvider`/`SmsProvider`.
  const emailProvider = new SandboxEmailProviderAdapter();
  const smsProvider = new SandboxSmsProviderAdapter();
  const recipientDirectory = new IdentityModuleBackedRecipientDirectory(identity);
  const notifications = buildNotificationModule({ prisma, clock, idGenerator, recipientDirectory });

  // Registre `eventType -> handlers[]` du relais Outbox : SEUL point du code autorise a
  // connaitre les consommateurs de PLUSIEURS modules a la fois (01-target-architecture.md §5 —
  // meme raisonnement que `TenantModuleBackedAccessChecker` ci-dessus). TROIS consommateurs pour
  // `SaaSPaymentSucceeded` (module `payment` -> `payment` + `subscription`), un pour
  // `SubscriptionRenewalDue` et un pour `SubscriptionUpgradeRequested` (module `subscription` ->
  // `payment`) — voir le catalogue d'evenements O-25.6, l'ADR-0003 et docs/domain/events.md.
  //
  // Le routage reste un simple `eventType -> handlers[]` : les TROIS consommateurs de
  // `SaaSPaymentSucceeded` tournent sur CHAQUE message et se filtrent EUX-MEMES sur `purpose`
  // (`reactivate...` ignore les upgrades, `applyPlanUpgrade...` ne traite qu'eux). Aiguiller ici
  // sur le contenu du payload dupliquerait cette regle metier hors des modules qui la portent.
  //
  // CHAQUE handler est decore par `withOutboxIdempotency` (etape 6/13, D9 : "tout consommateur est
  // idempotent -> cle d'idempotence + registre des evenements traites") AVANT d'entrer dans cette
  // map : c'est ICI, et nulle part ailleurs, que cette garantie de premier niveau est appliquee
  // UNIFORMEMENT a tous les handlers, sans qu'aucun module n'ait a s'en soucier lui-meme (voir
  // OutboxIdempotencyGuard.ts). `handlerName` est une chaine STABLE choisie ici (pas le nom de la
  // fonction JS, qui serait anonyme pour tout handler produit par une factory `createXxx...`) —
  // convention `<module>.<service>`, a reprendre pour tout futur consommateur (Identity/Tenant
  // n'en ont aucun a ce jour, voir docs/domain/events.md).
  const outboxHandlers = new Map<string, readonly OutboxEventHandler[]>([
    [
      'payment.payment.saas-payment-succeeded',
      [
        withOutboxIdempotency(
          prisma,
          'payment.markPlatformInvoicePaidOnPaymentSucceeded',
          payment.outboxHandlers.markPlatformInvoicePaidOnPaymentSucceeded,
        ),
        withOutboxIdempotency(
          prisma,
          'subscription.reactivateSubscriptionOnPaymentSucceeded',
          subscription.outboxHandlers.reactivateSubscriptionOnPaymentSucceeded,
        ),
        withOutboxIdempotency(
          prisma,
          'subscription.applyPlanUpgradeOnPaymentSucceeded',
          subscription.outboxHandlers.applyPlanUpgradeOnPaymentSucceeded,
        ),
      ],
    ],
    [
      'subscription.subscription.renewal-due',
      [
        withOutboxIdempotency(
          prisma,
          'payment.issuePlatformInvoiceOnRenewalDue',
          payment.outboxHandlers.issuePlatformInvoiceOnRenewalDue,
        ),
      ],
    ],
    [
      'subscription.subscription.upgrade-requested',
      [
        withOutboxIdempotency(
          prisma,
          'payment.issuePlatformInvoiceOnUpgradeRequested',
          payment.outboxHandlers.issuePlatformInvoiceOnUpgradeRequested,
        ),
      ],
    ],
    // Notifications (etape 9/13, ADR-0007 §1) — deux hooks designes des l'etape 4/13 dans
    // docs/domain/events.md ("notification de bienvenue"/"notification de confirmation, etape
    // 9"), les SEULS caches ici (voir l'ADR pour la justification de ne pas aller au-dela :
    // rappels d'impayes/UserAccountCreated hors perimetre).
    [
      'subscription.subscription.started',
      [
        withOutboxIdempotency(
          prisma,
          'notifications.sendWelcomeEmailOnSubscriptionStarted',
          notifications.outboxHandlers.sendWelcomeEmailOnSubscriptionStarted,
        ),
      ],
    ],
    [
      'subscription.subscription.plan-changed',
      [
        withOutboxIdempotency(
          prisma,
          'notifications.sendPlanChangeConfirmationOnPlanChanged',
          notifications.outboxHandlers.sendPlanChangeConfirmationOnPlanChanged,
        ),
      ],
    ],
  ]);

  // Connexion Redis DEDIEE a BullMQ (voir OutboxQueueConnection.ts — `maxRetriesPerRequest: null`
  // exige par BullMQ, incompatible avec la connexion `redis` ci-dessus, partagee
  // sessions/cache). Queue (producteur, utilise par `relayOutboxOnce`) et Worker (consommateur,
  // `OutboxWorker.ts`) partagent la MEME connexion — pattern standard BullMQ.
  const outboxQueueConnection = createOutboxQueueConnection(env.REDIS_URL);
  const outboxQueue = new Queue<OutboxJobData>(OUTBOX_QUEUE_NAME, { connection: outboxQueueConnection });
  // UNE SEULE valeur, partagee par le relais (colonne `locked_by`) ET le worker (verification
  // d'integrite, voir OutboxWorker.ts) — jamais deux calculs independants de `outbox-${pid}` qui
  // pourraient diverger si ce fichier evoluait.
  const outboxWorkerId = `outbox-${process.pid}`;
  const outboxWorker = createOutboxWorker({
    prisma,
    handlers: outboxHandlers,
    connection: outboxQueueConnection,
    workerId: outboxWorkerId,
    logger,
  });

  // Pipeline de livraison des notifications (ADR-0007 §6) — file BullMQ DISTINCTE de
  // `outbox-relay` (deux politiques de retry deliberement differentes, jamais confondues),
  // connexion Redis DEDIEE elle aussi (memes contraintes BullMQ que la connexion Outbox
  // ci-dessus : `maxRetriesPerRequest: null`).
  const notificationQueueConnection = createOutboxQueueConnection(env.REDIS_URL);
  const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, { connection: notificationQueueConnection });
  const notificationWorkerId = `notification-${process.pid}`;
  const notificationWorker = createNotificationWorker({
    prisma,
    emailProvider,
    smsProvider,
    connection: notificationQueueConnection,
    workerId: notificationWorkerId,
    logger,
  });

  let outboxRelayJob: PeriodicJobHandle | undefined;
  let subscriptionRenewalJob: PeriodicJobHandle | undefined;
  let paymentReconciliationJob: PeriodicJobHandle | undefined;
  let notificationRelayJob: PeriodicJobHandle | undefined;

  return {
    env,
    clock,
    idGenerator,
    prisma,
    redis,
    logger,
    tenant,
    audit,
    identity,
    subscription,
    payment,
    notifications,
    startBackgroundJobs(): void {
      // `autorun: false` a la construction (voir OutboxWorker.ts) : demarre explicitement ici,
      // jamais avant — meme discipline que les jobs periodiques ci-dessous (rien ne tourne avant
      // cet appel unique, voir server.ts). `run()` ne resout qu'a la fermeture du worker
      // (`stopBackgroundJobs`) : jamais attendu ici, fire-and-forget avec log d'erreur explicite
      // pour ne jamais laisser un rejet non gere s'echapper.
      void outboxWorker.run().catch((error: unknown) => {
        logger.error(
          { event: 'outbox.worker.crashed', error: error instanceof Error ? error.message : String(error) },
          'Le worker BullMQ Outbox s_est arrete de maniere inattendue',
        );
      });
      outboxRelayJob = startPeriodicJob({
        name: 'outbox-relay',
        intervalMs: 5_000,
        run: async () => {
          await relayOutboxOnce({ prisma, queue: outboxQueue, workerId: outboxWorkerId, logger });
        },
        logger,
      });
      subscriptionRenewalJob = startSubscriptionRenewalScheduler({
        handler: subscription.services.processSubscriptionRenewals,
        logger,
      });
      paymentReconciliationJob = startPaymentReconciliationScheduler({
        handler: payment.services.reconcilePendingPayments,
        logger,
      });
      void notificationWorker.run().catch((error: unknown) => {
        logger.error(
          { event: 'notification.worker.crashed', error: error instanceof Error ? error.message : String(error) },
          'Le worker BullMQ de livraison des notifications s_est arrete de maniere inattendue',
        );
      });
      notificationRelayJob = startPeriodicJob({
        name: 'notification-relay',
        intervalMs: 5_000,
        run: async () => {
          await relayNotificationsOnce({ prisma, queue: notificationQueue, workerId: notificationWorkerId, logger });
        },
        logger,
      });
    },
    async stopBackgroundJobs(): Promise<void> {
      // Ordre : stopper la DECOUVERTE (plus aucun nouveau job enfile) avant de fermer le WORKER
      // (qui attend la fin des jobs deja en cours, §8 exploitation) — jamais l'inverse, qui
      // laisserait le worker fermer pendant qu'un cycle de decouverte tente encore d'enfiler.
      await Promise.all([
        outboxRelayJob?.stop(),
        subscriptionRenewalJob?.stop(),
        paymentReconciliationJob?.stop(),
        notificationRelayJob?.stop(),
      ]);
      await Promise.all([outboxWorker.close(), notificationWorker.close()]);
    },
    async shutdown(): Promise<void> {
      await Promise.all([outboxQueue.close(), notificationQueue.close()]);
      outboxQueueConnection.disconnect();
      notificationQueueConnection.disconnect();
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}
