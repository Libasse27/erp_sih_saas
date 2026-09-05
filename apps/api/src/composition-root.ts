import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
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
import type { MembershipAuditRecordInput, MembershipAuditTrail } from './modules/identity/application/ports/MembershipAuditTrail.js';
import { PrismaUserAccountRepository } from './modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { UserAccountId } from './modules/identity/domain/value-objects/UserAccountId.js';
import type { UserAccountRepository } from './modules/identity/domain/ports/UserAccountRepository.js';
import { ServerContextResolver } from './modules/identity/application/services/ServerContextResolver.js';
import { buildAuditModule, type AuditModule } from './modules/audit/infrastructure/AuditModule.js';
import type { AuditReadPrincipal } from './modules/audit/application/AuditReadPrincipal.js';
import { AuditEntryController, type AuditHttpLocals } from './modules/audit/presentation/http/AuditEntryController.js';
import { SessionController } from './modules/identity/presentation/http/SessionController.js';
import { MfaEnrollmentController } from './modules/identity/presentation/http/MfaEnrollmentController.js';
import { SuperAdminBreakGlassController } from './modules/identity/presentation/http/SuperAdminBreakGlassController.js';
import { RegistrationController } from './presentation/http/RegistrationController.js';
import { RedisRateLimiter } from './shared-kernel/infrastructure/RedisRateLimiter.js';
import { createRateLimitMiddleware } from './shared-kernel/infrastructure/RateLimitMiddleware.js';
import { createAuditEntriesRateLimitMiddleware } from './shared-kernel/infrastructure/AuditEntriesRateLimitMiddleware.js';
import { createSilentRateLimitGuard } from './shared-kernel/infrastructure/SilentRateLimitGuard.js';
import {
  LOGIN_RATE_LIMIT_MAX_REQUESTS,
  LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  MFA_ROUTES_RATE_LIMIT_MAX_REQUESTS,
  MFA_ROUTES_RATE_LIMIT_WINDOW_SECONDS,
  REGISTRATION_RATE_LIMIT_MAX_REQUESTS,
  REGISTRATION_RATE_LIMIT_WINDOW_SECONDS,
  AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS,
  AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS,
  PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS,
  PAYMENT_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
} from './shared-kernel/domain/RateLimitTuning.js';
import { AUDIT_TRAIL_QUERY_RATE_LIMIT_REASON } from './modules/audit/application/commands/RecordAuditAccess.js';
import { buildTenantModule, type TenantModule } from './modules/tenant/infrastructure/TenantModule.js';
import type { UserAccountExistenceChecker } from './modules/tenant/application/ports/UserAccountExistenceChecker.js';
import type { HealthFacilityRepository } from './modules/tenant/domain/ports/HealthFacilityRepository.js';
import type { ProvisioningAuditRecordInput, ProvisioningAuditTrail } from './modules/tenant/application/ports/ProvisioningAuditTrail.js';
import type { SubscriptionRepository } from './modules/subscription/domain/ports/SubscriptionRepository.js';
import type { SubscriptionAuditRecordInput, SubscriptionAuditTrail } from './modules/subscription/application/ports/SubscriptionAuditTrail.js';
import {
  buildSubscriptionModule,
  type SubscriptionModule,
} from './modules/subscription/infrastructure/SubscriptionModule.js';
import { buildPaymentModule, type PaymentModule } from './modules/payment/infrastructure/PaymentModule.js';
import type { BillingAuditRecordInput, BillingAuditTrail } from './modules/payment/application/ports/BillingAuditTrail.js';
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
 * sur le `HealthFacilityRepository` de Tenant ET, depuis ADR-0008 §3 (Phase 0, etape 10/13), sur
 * le `SubscriptionRepository` du module Subscription. Vit ICI et nulle part ailleurs : c'est le
 * seul point du code autorise a connaitre les TROIS modules a la fois
 * (01-target-architecture.md §5 — "un module n'importe jamais le domain/ d'un autre module ; les
 * echanges passent par des evenements ou des ports explicites"). Ni Identity, ni Tenant, ni
 * Subscription n'importent le domain/ d'un autre module entre eux : Identity ne connait que son
 * propre port, Tenant et Subscription ne connaissent meme pas l'existence d'Identity. C'est ICI,
 * et nulle part ailleurs, que le statut `FacilityStatus` (Tenant) ET l'existence d'un
 * `Subscription` (Subscription) sont traduits vers le vocabulaire propre a Identity
 * (`TenantAccessStatus`).
 *
 * Regle ADR-0008 §3 (ferme la faille documentee au §Contexte de cette ADR — un tenant dont
 * `HealthFacility` a reussi mais dont `StartTrialSubscription` a echoue/n'a pas encore ete
 * rejoue par l'Outbox etait auparavant deja `ACCESSIBLE`) :
 *
 *   ACCESSIBLE  ⟺  HealthFacility.isActive() ET Subscription existe pour ce tenant
 *
 * `HealthFacility` `SUSPENDED` reste PRIORITAIRE sur tout le reste (inchange). L'ABSENCE de
 * `Subscription` (provisioning interrompu avant `StartTrialSubscription`, ou pas encore rejoue
 * par l'Outbox) est traitee comme `NOT_FOUND` — jamais un troisieme statut invente : ADR-0008 §3
 * est explicite, `SubscriptionStatus` est un type ferme a QUATRE valeurs TOUTES fonctionnelles
 * (`TRIALING`/`ACTIVE`/`GRACE_PERIOD`/`DEGRADED`, aucun `CANCELLED`/`EXPIRED`) : il n'existe donc
 * AUCUNE branche "Subscription dans un etat non fonctionnel" a coder, seule son absence refuse
 * l'acces. `NOT_FOUND` est le mapping le plus coherent avec la regle "ne jamais reveler
 * l'existence" (meme raisonnement que l'absence de `HealthFacility` elle-meme) : un tenant
 * partiellement provisionne ne doit pas etre distingue, du point de vue du client, d'un tenant
 * qui n'existe pas.
 *
 * IMPORTANT (ADR-0008 §3, precision actee a la validation) : `ProvisioningCompleted` (dernier
 * evenement de la Saga, etape 10/13) N'EST JAMAIS consulte ici. Cette methode reste
 * STATELESS vis-a-vis de la Saga elle-meme — l'acces est TOUJOURS derive DYNAMIQUEMENT de l'etat
 * REEL de `HealthFacility`/`Subscription` a l'instant de l'appel, jamais d'un indicateur de
 * progression mis en cache ou stocke sur un agregat.
 */
export class TenantModuleBackedAccessChecker implements TenantAccessChecker {
  /**
   * EXPORTE (revue de securite de l'etape 10/13) UNIQUEMENT pour que cette regle — le SEUL
   * controle d'acces inter-tenant de la plateforme — soit couverte par un test qui exerce LA
   * CLASSE REELLE, et non une re-implementation manuelle de la meme regle dans chaque suite
   * d'integration (ce qu'etaient tous ses "tests" jusqu'ici : une regression sur ce fichier
   * serait passee inapercue, CI au vert). Voir
   * test/identity/unit/tenantModuleBackedAccessChecker.test.ts. Ne JAMAIS instancier cette classe
   * ailleurs que dans `buildCompositionRoot()` ci-dessous.
   *
   * Prend les DEUX REPOSITORIES dont elle a besoin, jamais les modules entiers (moindre
   * privilege : cet adaptateur n'a aucune raison d'atteindre les handlers ou l'UnitOfWork de
   * Tenant/Subscription).
   */
  constructor(
    private readonly healthFacilities: HealthFacilityRepository,
    private readonly subscriptions: SubscriptionRepository,
  ) {}

  async checkAccess(tenantId: TenantId): Promise<TenantAccessStatus> {
    const facility = await this.healthFacilities.findByTenantId(tenantId);
    if (facility === null) {
      return 'NOT_FOUND';
    }
    if (!facility.isActive()) {
      return 'SUSPENDED';
    }
    const subscription = await this.subscriptions.findByTenantId(tenantId);
    if (subscription === null) {
      return 'NOT_FOUND';
    }
    return 'ACCESSIBLE';
  }
}

/**
 * Adaptateur cross-module implementant le port `UserAccountExistenceChecker` de Tenant
 * (ADR-0008 §9, amendement 1, etape 10/13) — SENS INVERSE de `TenantModuleBackedAccessChecker`
 * ci-dessus : ici c'est Tenant qui a besoin de verifier une donnee d'Identity. Vit ICI et nulle
 * part ailleurs, meme raisonnement. Construit a partir d'un `PrismaUserAccountRepository` DEDIE
 * (pas celui expose par `IdentityModule`, construit plus loin) : deux instances qui enveloppent
 * le MEME `PrismaClient` sont strictement equivalentes (meme raisonnement que `PgUnitOfWork`,
 * voir le commentaire de tete de TenantModule.ts) — ce choix evite une dependance de
 * CONSTRUCTION d'Identity avant Tenant, alors que l'inverse (Identity apres Tenant/Subscription,
 * pour `TenantModuleBackedAccessChecker`) est deja le sens retenu plus bas.
 */
export class IdentityModuleBackedUserAccountExistenceChecker implements UserAccountExistenceChecker {
  /**
   * EXPORTE (revue de securite de l'etape 10/13) pour la meme raison que
   * `TenantModuleBackedAccessChecker` ci-dessus : c'est cette classe REELLE qui doit etre
   * couverte par un test, pas une copie manuelle. Typee sur le PORT `UserAccountRepository`
   * (jamais sur l'implementation Prisma concrete) — l'existence d'un compte est la seule chose
   * dont cet adaptateur a besoin.
   */
  constructor(private readonly userAccounts: UserAccountRepository) {}

  async exists(userId: string): Promise<boolean> {
    const idResult = UserAccountId.create(userId);
    if (idResult.isFailure()) {
      return false;
    }
    const account = await this.userAccounts.findById(idResult.getValue());
    return account !== null;
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
      // `AuditRecordInput` (port MFA, ADR-0005, INCHANGE par ADR-0009 §2 : "MFA existante,
      // inchangee") ne porte pas `actorKind` — ses 6 producteurs (StartMfaEnrollment,
      // ConfirmMfaEnrollment, VerifyMfaChallenge, ForceMfaReEnrollment,
      // RegenerateMfaRecoveryCodes, ServerContextResolver) restent hors perimetre de cette etape.
      // Derive ICI, seul point du code qui connait les deux modules : un contexte PLATEFORME n'a
      // structurellement pas de tenant (`tenantId === null`), exactement le meme discriminant que
      // `ServerContextResolver`/`SessionContextIssuer` utilisent pour distinguer PLATFORM/TENANT.
      actorKind: input.tenantId === null ? 'USER_PLATFORM' : 'USER_TENANT',
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      // MFA porte TOUJOURS sur le compte de l'acteur lui-meme (ADR-0009 §3 : `targetType` obligatoire).
      targetType: 'USER_ACCOUNT',
      targetId: input.subjectUserId,
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
      actorKind: input.actorKind,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      // SESSION porte TOUJOURS sur le compte de l'acteur lui-meme (connexion, ouverture/refus de
      // contexte, fermeture) — ADR-0009 §3 : `targetType` obligatoire.
      targetType: 'USER_ACCOUNT',
      targetId: input.subjectUserId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Adaptateur cross-module implementant le port `ProvisioningAuditTrail` de Tenant en s'appuyant
 * sur le module `audit` (ADR-0009 §2.2/§4). Vit ICI et nulle part ailleurs — meme raisonnement
 * qu'`AuditModuleBackedAuditTrail`. Categorie fixee a `'PROVISIONING'` : cet adaptateur ne sert
 * QUE le port de Tenant, jamais etendu par un `if` sur l'appelant.
 */
class AuditModuleBackedProvisioningAuditTrail implements ProvisioningAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: ProvisioningAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'PROVISIONING',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      actorKind: input.actorKind,
      actorUserId: input.actorUserId,
      actorRoleCodes: [],
      subjectUserId: input.subjectUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Adaptateur cross-module implementant le TROISIEME port sortant d'Identity vers le module
 * `audit`, categorie `MEMBERSHIP` (ADR-0009 §2.2/§4 : "jamais une extension d'AuditTrail
 * (categorie MFA)"). `targetType` fixe a `'MEMBERSHIP'` — seule valeur pertinente pour ce port.
 */
class AuditModuleBackedMembershipAuditTrail implements MembershipAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: MembershipAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'MEMBERSHIP',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      actorKind: input.actorKind,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      subjectUserId: input.subjectUserId,
      targetType: 'MEMBERSHIP',
      targetId: input.targetId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Adaptateur cross-module implementant le port `SubscriptionAuditTrail` de Subscription en
 * s'appuyant sur le module `audit` (ADR-0009 §2.2/§4). Categorie fixee a `'SUBSCRIPTION'`,
 * `targetType` fixe a `'SUBSCRIPTION'` — seule valeur pertinente pour ce port.
 */
class AuditModuleBackedSubscriptionAuditTrail implements SubscriptionAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: SubscriptionAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'SUBSCRIPTION',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      actorKind: input.actorKind,
      actorUserId: input.actorUserId,
      actorRoleCodes: [],
      subjectUserId: null,
      targetType: 'SUBSCRIPTION',
      targetId: input.targetId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Adaptateur cross-module implementant le port `BillingAuditTrail` de Payment en s'appuyant sur
 * le module `audit` (ADR-0009 §2.2/§4). Categorie fixee a `'BILLING'` — `targetType` reste porte
 * par l'appelant (`PAYMENT` ou `PLATFORM_INVOICE`, les deux agregats couverts par cette categorie,
 * §2 : "BILLING... couvre a la fois Payment... et PlatformInvoice").
 */
class AuditModuleBackedBillingAuditTrail implements BillingAuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: BillingAuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'BILLING',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      actorKind: input.actorKind,
      actorUserId: input.actorUserId,
      actorRoleCodes: [],
      subjectUserId: null,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Middleware HTTP UNIQUE de resolution de contexte authentifie (ADR-0009 §8.2) — construit ICI,
 * seul endroit du code autorise a connaitre `identity` ET `audit` a la fois. Lit le `sessionId`
 * depuis `Authorization: Bearer <sessionId>` (jamais un cookie, §8.3), appelle
 * `ServerContextResolver.resolve()` — LE point de passage obligatoire existant, jamais un second
 * chemin de resolution — et traduit :
 *   `SESSION_NOT_FOUND` -> 401 ; `MFA_REQUIRED` -> 403 `mfa_required` ; succes -> `AuditReadPrincipal`
 *   attache a `res.locals` (voir `AuditHttpLocals`), jamais l'agregat `ServerContext` lui-meme
 *   (le module `audit` ne connait que son propre type `AuditReadPrincipal`).
 * Une session `MFA_PENDING` ne produit donc JAMAIS de principal : `ServerContextResolver.resolve()`
 * retourne `MFA_REQUIRED` AVANT toute construction d'objet porteur de tenant/acteur, aucune
 * transaction ne s'ouvre (meme garantie que `mfaSessionGate.test.ts`).
 */
function buildRequireAuthenticatedContext(serverContextResolver: ServerContextResolver): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const authorizationHeader = req.header('authorization');
      const bearerPrefix = 'Bearer ';
      if (authorizationHeader === undefined || !authorizationHeader.startsWith(bearerPrefix)) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const sessionId = authorizationHeader.slice(bearerPrefix.length).trim();
      if (sessionId.length === 0) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }

      const correlationId = req.header('x-correlation-id') ?? null;
      const result = await serverContextResolver.resolve(sessionId, correlationId);
      if (result.isFailure()) {
        const error = result.getError();
        if (error === 'MFA_REQUIRED') {
          res.status(403).json({ error: 'mfa_required' });
          return;
        }
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }

      const context = result.getValue();
      const principal: AuditReadPrincipal =
        context.kind === 'PLATFORM'
          ? { kind: 'PLATFORM', actorUserId: context.actorUserId }
          : {
              kind: 'TENANT',
              actorUserId: context.actorUserId,
              tenantId: context.tenantId.toString(),
              roleCodes: context.session.roleCodes,
              permissionCodes: context.session.permissionCodes,
            };

      const locals: AuditHttpLocals = { auditPrincipal: principal, sessionId };
      Object.assign(res.locals, locals);
      next();
    })().catch(next);
  };
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

  async findActiveSuperAdminEmails(excludeUserId: string): Promise<readonly string[]> {
    const superAdmins = await this.identity.repositories.userAccounts.findAllSuperAdmins();
    return superAdmins.filter((account) => account.id.toString() !== excludeUserId).map((account) => account.email.value);
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
   * Presentation HTTP cross-module (ADR-0009 §8, etendue par ADR-0010 §1/§8) — SEUL point du
   * code qui expose a `server.ts` le middleware d'authentification, le controleur d'audit, ET
   * (depuis l'etape 12/13) les CINQ routes pre-authentification d'inscription/connexion/second
   * facteur ainsi que le limiteur de debit PARTAGE qui les protege toutes.
   */
  readonly presentation: {
    readonly requireAuthenticatedContext: RequestHandler;
    readonly auditEntryController: AuditEntryController;
    /** ADR-0010 §1/§2 — cross-module (identity + tenant), instancie UNIQUEMENT ici. */
    readonly registrationController: RegistrationController;
    /** ADR-0010 §1/§6/§7 bis C — mono-module (identity seul). */
    readonly sessionController: SessionController;
    /** ADR-0010 §1/§7 bis A/B — mono-module (identity seul). */
    readonly mfaEnrollmentController: MfaEnrollmentController;
    /** ADR-0005 Amendement 1 (O-04 residu 4), etape 12/13 — mono-module (identity seul), derriere `requireAuthenticatedContext`. */
    readonly superAdminBreakGlassController: SuperAdminBreakGlassController;
    /** ADR-0010 §8 — un middleware par famille de limite, valeurs dans shared-kernel/domain/RateLimitTuning.ts (non definitives). */
    readonly rateLimitRegistrations: RequestHandler;
    readonly rateLimitLogin: RequestHandler;
    readonly rateLimitMfa: RequestHandler;
    /**
     * ADR-0011 §2/§4 — DISTINCT des trois ci-dessus (`createAuditEntriesRateLimitMiddleware`,
     * jamais `createRateLimitMiddleware`) : cle par sujet authentifie, jamais par IP ; ecrit une
     * entree d'audit sur le premier rejet d'une fenetre. Monte APRES
     * `requireAuthenticatedContext` dans `server.ts`.
     */
    readonly rateLimitAuditEntries: RequestHandler;
  };
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

  // Limiteur de debit PARTAGE (ADR-0010 §8/§12 point 4, etendu ADR-0011) — port `RateLimiter`
  // (shared-kernel), implementation Redis REELLE (connexion `redis` deja partagee par les
  // sessions/le cache, jamais une connexion dediee supplementaire). Construit ICI, avant TOUT
  // module, car le webhook paiement (ADR-0011 §3/§5) en a besoin AVANT que le module `payment`
  // lui-meme soit construit plus bas — UN SEUL point de construction pour TOUTE la limitation de
  // debit du depot, jamais une seconde instance.
  const rateLimiter = new RedisRateLimiter(redis);

  // ADR-0011 §3/§5/§7, decision D4 — webhook paiement : compteur GLOBAL (jamais par IP ni par
  // tenant, le tenant n'etant connu qu'APRES verification HMAC, voir ConfirmPayment.ts), reponse
  // SILENCIEUSE (`200`, jamais `429` — invariant preexistant ferme et teste, commit `649a7b6`).
  // Factory SEPAREE de `createRateLimitMiddleware` (aucun drapeau `silent` ajoute a cette
  // derniere, alternative ecartee #6 d'ADR-0011). Construit ICI (composition-root.ts, seul point
  // de cablage), puis simplement TRANSMIS en dependance a `buildPaymentModule` ci-dessous —
  // `PaymentModule.ts` ne construit rien lui-meme, il ne fait qu'exposer ce qu'on lui donne.
  const rateLimitWebhook = createSilentRateLimitGuard({
    route: 'payment-webhook',
    limiter: rateLimiter,
    maxRequests: PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: PAYMENT_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
    onRejected: (reason) => {
      // Log structure, JAMAIS une `AuditEntry` (ADR-0011 §5.3 : aucun acteur imputable, aucun
      // sujet, aucun tenant connu a ce stade). Convention DEJA en place dans le module `payment`
      // (ConfirmPayment.ts : `invalid_signature`, `invalid_payload`, ...) — reprise ICI plutot que
      // dans `SilentRateLimitGuard.ts`, qui n'importe jamais le vocabulaire du module `payment`.
      //
      // ADR-0011 Amendement 1, BLOQUANT-1 : le motif transmis par le guard distingue un vrai
      // depassement de seuil (`'threshold_exceeded'`) d'une panne du limiteur lui-meme
      // (`'limiter_unavailable'`) — traduit ICI en deux motifs de LOG distincts, jamais confondus :
      // journaliser une panne du limiteur sous `rate_limited` mentirait sur la cause reelle.
      const logReason = reason === 'limiter_unavailable' ? 'rate_limiter_unavailable' : 'rate_limited';
      logger.warn(
        { event: 'payment.webhook.rejected', reason: logReason },
        'Webhook paiement ignore (limitation de debit)',
      );
    },
  });

  // `userAccountsForExistenceCheck` : instance DEDIEE de `PrismaUserAccountRepository` (ADR-0008
  // §9, amendement 1, etape 10/13), construite AVANT le module Tenant lui-meme — Tenant a
  // desormais besoin de verifier l'existence d'un `UserAccount` (`ownerUserId`) des la creation
  // d'un `HealthFacility`, sans attendre la construction complete du module Identity (qui, elle,
  // depend en retour de Tenant/Subscription via `TenantAccessChecker`, voir plus bas — d'ou
  // l'instance DEDIEE plutot qu'un partage de `identity.repositories.userAccounts`, qui creerait
  // une dependance circulaire de CONSTRUCTION entre les deux modules).
  const userAccountsForExistenceCheck = new PrismaUserAccountRepository(prisma);
  const userAccountExistenceChecker = new IdentityModuleBackedUserAccountExistenceChecker(
    userAccountsForExistenceCheck,
  );

  // Audit cable EN PREMIER (ADR-0009) : Tenant/Subscription/Identity/Payment ont TOUS desormais
  // besoin d'un adaptateur `*AuditTrail` backe par ce module (ProvisioningAuditTrail,
  // SubscriptionAuditTrail, AuditTrail/SessionAuditTrail/MembershipAuditTrail,
  // BillingAuditTrail) — `audit` lui-meme ne depend d'AUCUN autre module (seulement
  // prisma/clock/idGenerator), sa construction peut donc etre avancee sans creer de dependance
  // circulaire, contrairement a Tenant/Subscription/Identity qui dependent EN RETOUR les uns des
  // autres (voir plus bas).
  const audit = buildAuditModule({ prisma, clock, idGenerator });
  const provisioningAuditTrail = new AuditModuleBackedProvisioningAuditTrail(audit);
  const subscriptionAuditTrail = new AuditModuleBackedSubscriptionAuditTrail(audit);
  const membershipAuditTrail = new AuditModuleBackedMembershipAuditTrail(audit);
  const billingAuditTrail = new AuditModuleBackedBillingAuditTrail(audit);

  // Tenant, Subscription et Audit cables avant Identity : Identity depend des ports
  // `TenantAccessChecker` (ResolveTenantContextHandler, Phase 0 etape 3 ; compose Tenant ET
  // Subscription depuis ADR-0008 §3, etape 10/13) et `AuditTrail` (MFA, etape 7/13), dont les
  // implementations ci-dessous ont besoin des modules Tenant/Subscription/Audit deja construits.
  // L'inverse n'est jamais vrai au niveau des MODULES eux-memes : ni Tenant, ni Subscription, ni
  // Audit ne dependent du MODULE Identity — Subscription en particulier "ne depend d'aucun autre
  // module" (voir le residu documente dans SubscriptionModule.ts sur l'absence volontaire d'un
  // port `TenantAccessChecker` cote Subscription), sa construction est simplement AVANCEE ici pour
  // etre disponible au moment ou `TenantModuleBackedAccessChecker` en a besoin. Tenant, lui, recoit
  // desormais `userAccountExistenceChecker` (port cross-module, pas le module Identity lui-meme).
  const tenant = buildTenantModule({ prisma, clock, idGenerator, userAccountExistenceChecker, provisioningAuditTrail });
  const subscription = buildSubscriptionModule({
    prisma,
    clock,
    idGenerator,
    applyPlanUpgradeLogger: logger,
    subscriptionAuditTrail,
  });
  const tenantAccessChecker = new TenantModuleBackedAccessChecker(
    tenant.repositories.healthFacilities,
    subscription.repositories.subscriptions,
  );
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
    membershipAuditTrail,
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
    billingAuditTrail,
    rateLimitWebhook,
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
    // Notifications (etape 9/13, ADR-0007 §1) — hook "notification de bienvenue" designe des
    // l'etape 4/13 dans docs/domain/events.md, le SEUL hook de NOTIFICATION cable ici (voir l'ADR
    // pour la justification de ne pas aller au-dela : rappels d'impayes/UserAccountCreated hors
    // perimetre). Ce canal porte aussi, depuis le resequencement F3, le deuxieme maillon de la
    // Saga de provisioning (identity.grantOwnerMembershipOnSubscriptionStarted, voir le
    // commentaire de tete de la section "Saga de provisioning" plus bas pour le detail complet).
    [
      'subscription.subscription.started',
      [
        withOutboxIdempotency(
          prisma,
          'notifications.sendWelcomeEmailOnSubscriptionStarted',
          notifications.outboxHandlers.sendWelcomeEmailOnSubscriptionStarted,
        ),
        withOutboxIdempotency(
          prisma,
          'identity.grantOwnerMembershipOnSubscriptionStarted',
          identity.outboxHandlers.grantOwnerMembershipOnSubscriptionStarted,
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
    // Saga de provisioning (ADR-0008 §1/§4/§9/§10/§11, amendement 1, Phase 0 etape 10/13) —
    // chorographie COMPLETE et STRICTEMENT SEQUENTIELLE (RESEQUENCEE — correctif F3 de la revue
    // de securite independante de cette etape, Moyen), CINQ maillons, chacun le consommateur
    // Outbox UNIQUE de l'evenement emis par le maillon precedent :
    //   1. HealthFacilityCreated (module tenant) -> subscription.startTrialSubscriptionOnHealthFacilityCreated
    //      (module subscription) : demarre l'essai gratuit STANDARD, relit desormais `ownerUserId`
    //      depuis le payload et le propage a SubscriptionStarted (voir §9 de l'ADR).
    //   2. SubscriptionStarted (module subscription) -> DEUX consommateurs sur le MEME eventType
    //      (meme pattern que SaaSPaymentSucceeded plus haut, aucune dependance causale entre eux) :
    //        - notifications.sendWelcomeEmailOnSubscriptionStarted (etape 9/13, inchange) ;
    //        - identity.grantOwnerMembershipOnSubscriptionStarted (RESEQUENCE ICI, ex-
    //          `grantOwnerMembershipOnHealthFacilityCreated`, retire du canal
    //          `tenant.health-facility.created` ci-dessous) : accorde ADMIN_ETABLISSEMENT a
    //          `ownerUserId`, lu depuis le payload de SubscriptionStarted — NE PEUT PLUS s'executer
    //          avant que l'abonnement d'essai n'ait ete effectivement demarre (ferme le defaut
    //          constate par la revue : `MembershipGranted`/`ProvisioningCompleted` pouvaient
    //          auparavant preceder `SubscriptionStarted` si cette derniere etape prenait du retard).
    //   3. MembershipGranted (module identity) -> tenant.seedFacilityConfigurationOnMembershipGranted
    //      (ADR-0008 §10) : seme la configuration technique minimale du tenant.
    //   4. FacilityConfigurationSeeded (module tenant, EMIS ET CONSOMME par le MEME module) ->
    //      tenant.completeProvisioningOnFacilityConfigurationSeeded (ADR-0008 §11) : emet
    //      ProvisioningCompleted, signal de cloture minimal — JAMAIS consulte par
    //      TenantModuleBackedAccessChecker (voir son commentaire de tete, inchange).
    [
      'tenant.health-facility.created',
      [
        withOutboxIdempotency(
          prisma,
          'subscription.startTrialSubscriptionOnHealthFacilityCreated',
          subscription.outboxHandlers.startTrialSubscriptionOnHealthFacilityCreated,
        ),
      ],
    ],
    [
      'identity.membership.granted',
      [
        withOutboxIdempotency(
          prisma,
          'tenant.seedFacilityConfigurationOnMembershipGranted',
          tenant.outboxHandlers.seedFacilityConfigurationOnMembershipGranted,
        ),
      ],
    ],
    [
      'tenant.facility-configuration-seeded',
      [
        withOutboxIdempotency(
          prisma,
          'tenant.completeProvisioningOnFacilityConfigurationSeeded',
          tenant.outboxHandlers.completeProvisioningOnFacilityConfigurationSeeded,
        ),
      ],
    ],
    // Break-glass SUPER_ADMIN (ADR-0005 Amendement 1, O-04 residu 4, etape 12/13) — alerte
    // IMMEDIATE des autres SUPER_ADMIN actifs a l'ouverture ET a l'approbation d'une demande
    // (deux evenements distincts, un seul consommateur Notifications chacun ; voir
    // SendSuperAdminBreakGlassRequestedAlert.ts/SendSuperAdminBreakGlassApprovedAlert.ts).
    [
      'identity.super-admin-break-glass.requested',
      [
        withOutboxIdempotency(
          prisma,
          'notifications.sendSuperAdminBreakGlassRequestedAlert',
          notifications.outboxHandlers.sendSuperAdminBreakGlassRequestedAlert,
        ),
      ],
    ],
    [
      'identity.super-admin-break-glass.approved',
      [
        withOutboxIdempotency(
          prisma,
          'notifications.sendSuperAdminBreakGlassApprovedAlert',
          notifications.outboxHandlers.sendSuperAdminBreakGlassApprovedAlert,
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

  // Presentation HTTP du module `audit` (ADR-0009 §8) — SEUL endpoint HTTP authentifie du depot
  // a cette etape. `requireAuthenticatedContext` construit ICI (seul point du code autorise a
  // connaitre `identity` ET `audit`) — voir `buildRequireAuthenticatedContext` plus haut.
  const requireAuthenticatedContext = buildRequireAuthenticatedContext(identity.serverContextResolver);
  const auditEntryController = new AuditEntryController(audit.queries.listAuditEntries, audit.commands.recordAuditAccess);

  // ADR-0010 §1/§2/§6/§7 bis — cinq routes pre-authentification. `RegistrationController` recoit
  // les DEUX handlers (identity + tenant), jamais les modules entiers (moindre privilege, meme
  // discipline que `TenantModuleBackedAccessChecker`) ; vit hors de `modules/` (§1 : seul point
  // du code, avec ce fichier, autorise a connaitre `identity` ET `tenant` pour cette route).
  const registrationController = new RegistrationController(
    identity.handlers.createUserAccount,
    tenant.handlers.createHealthFacility,
    logger,
  );
  // `SessionController`/`MfaEnrollmentController` sont mono-module (identity SEUL) — vivent dans
  // modules/identity/presentation/http/, instancies ici comme tout le reste (composition-root.ts
  // reste le seul point de cablage, meme pour un controleur mono-module, ADR-0010 §1).
  const sessionController = new SessionController(
    identity.handlers.authenticateUser,
    identity.handlers.resolveTenantContext,
    identity.handlers.verifyMfaChallenge,
    logger,
  );
  const mfaEnrollmentController = new MfaEnrollmentController(
    identity.handlers.startMfaEnrollment,
    identity.handlers.confirmMfaEnrollment,
  );
  const superAdminBreakGlassController = new SuperAdminBreakGlassController(
    identity.handlers.requestSuperAdminBreakGlass,
    identity.handlers.approveSuperAdminBreakGlass,
  );

  // Limiteur de debit PARTAGE (ADR-0010 §8/§12 point 4) — port `RateLimiter` (shared-kernel),
  // implementation Redis REELLE construite plus haut (`rateLimiter`, avant meme le module
  // `payment`, ADR-0011). UN SEUL point de cablage : trois appels de la MEME factory, un par
  // famille de limite (routes/valeurs dans shared-kernel/domain/RateLimitTuning.ts, explicitement
  // non definitives). Aucun litteral numerique ici — uniquement des constantes nommees importees
  // du fichier de reglage dedie.
  const rateLimitRegistrations = createRateLimitMiddleware({
    route: 'registrations',
    limiter: rateLimiter,
    maxRequests: REGISTRATION_RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: REGISTRATION_RATE_LIMIT_WINDOW_SECONDS,
  });
  const rateLimitLogin = createRateLimitMiddleware({
    route: 'auth-sessions',
    limiter: rateLimiter,
    maxRequests: LOGIN_RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  });
  // UN SEUL middleware, PARTAGE par les TROIS routes MFA (ADR-0010 §8 : "un middleware de
  // limitation partage, applique aux cinq routes de cette ADR, jamais une politique par route") —
  // meme instance montee trois fois dans server.ts, jamais trois middlewares distincts.
  const rateLimitMfa = createRateLimitMiddleware({
    route: 'mfa',
    limiter: rateLimiter,
    maxRequests: MFA_ROUTES_RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: MFA_ROUTES_RATE_LIMIT_WINDOW_SECONDS,
  });

  // ADR-0011 §2/§4 — `GET /api/v1/audit-entries` : limiteur DEDIE (`createAuditEntriesRateLimitMiddleware`,
  // DISTINCT de `createRateLimitMiddleware` ci-dessus), cle EXCLUSIVEMENT sur le sujet authentifie
  // (`res.locals.auditPrincipal.actorUserId`, depose par `requireAuthenticatedContext` — jamais
  // `req.ip`). Sur le PREMIER franchissement du seuil dans la fenetre, ecrit une entree d'audit
  // `AUDIT_TRAIL_QUERY_DENIED`/`DENIED`/`reason: AUDIT_TRAIL_QUERY_RATE_LIMIT_REASON` via
  // `RecordAuditAccessHandler` (module `audit`, deja construit ci-dessus) AVANT le `429` — jamais
  // une entree par requete rejetee (borne d'amplification, ADR-0009 §2.1). La factory partagee
  // (shared-kernel) ne connait, elle, ni `audit` ni `identity` : elle recoit deux fonctions
  // simples (lecture du sujet depuis `res.locals`, ecriture sur premier rejet uniquement).
  const rateLimitAuditEntries = createAuditEntriesRateLimitMiddleware<AuditReadPrincipal>({
    limiter: rateLimiter,
    maxRequests: AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS,
    getSubject: (res) => {
      const locals = res.locals as Partial<AuditHttpLocals>;
      return locals.auditPrincipal ?? null;
    },
    onFirstRejectionInWindow: async (req, res, principal) => {
      const locals = res.locals as Partial<AuditHttpLocals>;
      await audit.commands.recordAuditAccess.execute({
        principal,
        outcome: 'DENIED',
        sessionId: locals.sessionId ?? null,
        correlationId: req.header('x-correlation-id') ?? null,
        reason: AUDIT_TRAIL_QUERY_RATE_LIMIT_REASON,
      });
    },
  });

  let outboxRelayJob: PeriodicJobHandle | undefined;
  let subscriptionRenewalJob: PeriodicJobHandle | undefined;
  let paymentReconciliationJob: PeriodicJobHandle | undefined;
  let notificationRelayJob: PeriodicJobHandle | undefined;
  let refreshTokenPurgeJob: PeriodicJobHandle | undefined;

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
    presentation: {
      requireAuthenticatedContext,
      auditEntryController,
      registrationController,
      sessionController,
      mfaEnrollmentController,
      superAdminBreakGlassController,
      rateLimitRegistrations,
      rateLimitLogin,
      rateLimitMfa,
      rateLimitAuditEntries,
    },
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
      // AC-2 (ADR-0006 Amendement 1) : NETTOYAGE uniquement (RefreshTokenRepository.purgeDead) —
      // frequence basse (1h), aucune urgence de securite ici, la fenetre de retention de 7 jours
      // (meme ordre de grandeur que INDEX_KEY_HYGIENE_TTL_SECONDS, RedisSessionStore.ts) laisse le
      // temps d'investiguer une reutilisation tardive avant suppression definitive. Un seul DELETE
      // atomique (`resolvePrismaClient` retombe sur le client de base hors transaction, voir
      // PrismaTransactionContext.ts) : aucun `UnitOfWork` necessaire, table hors RLS (ADR-0006 §4).
      refreshTokenPurgeJob = startPeriodicJob({
        name: 'refresh-token-purge',
        intervalMs: 60 * 60 * 1000,
        run: async () => {
          await identity.repositories.refreshTokens.purgeDead(new Date(), 7 * 24 * 60 * 60);
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
        refreshTokenPurgeJob?.stop(),
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
