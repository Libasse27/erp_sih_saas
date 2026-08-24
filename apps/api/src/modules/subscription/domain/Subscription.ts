import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { addCalendarDays } from './services/CalendarDays.js';
import { SubscriptionPlanChanged } from './events/SubscriptionPlanChanged.js';
import { SubscriptionStarted } from './events/SubscriptionStarted.js';
import { SubscriptionId } from './value-objects/SubscriptionId.js';
import type { BillingPeriod } from './value-objects/BillingPeriod.js';
import type { PlanId } from './value-objects/PlanId.js';
import type { PlanPriceId } from './value-objects/PlanPriceId.js';
import type { SubscriptionStatus } from './value-objects/SubscriptionStatus.js';

/** Duree de l'essai gratuit — O-02.5, valeur close par la decision, pas une valeur par defaut inventee. */
export const TRIAL_DURATION_DAYS = 30;

interface SubscriptionProps {
  readonly tenantId: TenantId;
  planId: PlanId;
  currentPlanPriceId: PlanPriceId;
  readonly period: BillingPeriod;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: Date | null;
  readonly periodStartsAt: Date;
  readonly periodEndsAt: Date;
  readonly createdAt: Date;
}

/**
 * Agregat racine liant un tenant a un forfait, via le `PlanPrice` REELLEMENT applique
 * (`currentPlanPriceId`) — jamais une reference nue a `Plan` seul pour en deduire un prix
 * (O-02.6). Schema `platform`, `tenant_id` colonne simple SANS RLS (ADR-0001 §3.3) : la
 * protection de cette table est purement applicative (voir
 * `infrastructure/persistence/PrismaSubscriptionRepository.ts`, qui filtre explicitement par
 * `tenantId` sur CHAQUE methode — c'est la SEULE barriere reelle ici, plus critique encore que
 * la couche 3 habituelle puisqu'il n'y a pas de RLS en couche 4 pour cette table).
 *
 * Statut volontairement minimal (`TRIALING`/`ACTIVE`, voir `value-objects/SubscriptionStatus.ts`)
 * — meme choix que `HealthFacility.status` a l'etape 3 : aucun etat de grace/mode degrade (O-03)
 * n'est invente ici, ce sera la responsabilite d'une etape ulterieure qui composera avec ce
 * statut sans le remplacer.
 *
 * Invariant du catalogue (01-target-architecture.md §6.3) : "un Tenant a exactement un
 * Subscription actif a un instant donne" — impose ici par construction (un seul agregat par
 * tenant, `SubscriptionRepository.findByTenantId` renvoie au plus une ligne, contrainte UNIQUE
 * en base sur `tenant_id`, voir migration SQL) plutot que par une regle de commande a verifier a
 * chaque appel.
 */
export class Subscription extends AggregateRoot<SubscriptionId> {
  private props: SubscriptionProps;

  private constructor(id: SubscriptionId, props: SubscriptionProps) {
    super(id);
    this.props = props;
  }

  /**
   * Demarre un essai gratuit (O-02.5) : forfait STANDARD, `trialEndsAt` a J+30, sans moyen de
   * paiement requis. Le `planId`/`planPriceId` STANDARD sont resolus par l'appelant
   * (`StartTrialSubscription.ts`, via `PlanRepository`/`PlanPriceRepository`) — cet agregat ne
   * connait pas le catalogue, il se contente d'appliquer la regle O-02.5.
   *
   * Choix de conception non specifie par O-02 : la periode de facturation (`period`) portee par
   * un abonnement en essai est fixee a `MENSUEL`, la plus courte des deux periodicites du
   * catalogue — un essai n'a pas de moyen de paiement, donc pas de veritable cycle de
   * facturation choisi par le client ; `MENSUEL` sert uniquement de reference par defaut pour le
   * calcul de proratisation si un upgrade intervient pendant l'essai (le tenant choisira sa
   * periodicite reelle a la conversion en abonnement payant, hors perimetre de cette etape,
   * voir O-25). `periodEndsAt` de l'essai est aligne sur `trialEndsAt` (meme date) : il n'existe
   * pas de "periode de facturation" distincte tant qu'aucun paiement n'a eu lieu.
   */
  static startTrial(params: {
    tenantId: TenantId;
    standardPlanId: PlanId;
    standardPlanPriceId: PlanPriceId;
    clock: Clock;
    idGenerator: IdGenerator;
  }): Subscription {
    const idResult = SubscriptionId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour Subscription.');
    }
    const id = idResult.getValue();
    const now = params.clock.now();
    const trialEndsAt = addCalendarDays(now, TRIAL_DURATION_DAYS);

    const subscription = new Subscription(id, {
      tenantId: params.tenantId,
      planId: params.standardPlanId,
      currentPlanPriceId: params.standardPlanPriceId,
      period: 'MENSUEL',
      status: 'TRIALING',
      trialEndsAt,
      periodStartsAt: now,
      periodEndsAt: trialEndsAt,
      createdAt: now,
    });

    subscription.addDomainEvent(
      SubscriptionStarted.create({
        subscriptionId: id.toString(),
        tenantId: params.tenantId.toString(),
        planId: params.standardPlanId.toString(),
        trialEndsAt,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );

    return subscription;
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: SubscriptionId, props: SubscriptionProps): Subscription {
    return new Subscription(id, props);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get planId(): PlanId {
    return this.props.planId;
  }

  get currentPlanPriceId(): PlanPriceId {
    return this.props.currentPlanPriceId;
  }

  get period(): BillingPeriod {
    return this.props.period;
  }

  get status(): SubscriptionStatus {
    return this.props.status;
  }

  get trialEndsAt(): Date | null {
    return this.props.trialEndsAt;
  }

  get periodStartsAt(): Date {
    return this.props.periodStartsAt;
  }

  get periodEndsAt(): Date {
    return this.props.periodEndsAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * Applique un changement de forfait DEJA VALIDE comme upgrade et DEJA PRORATISE par
   * l'appelant (`UpgradeSubscriptionPlan.ts`, via `ProrationCalculator.ts`) : cette methode ne
   * refait aucun calcul, elle ne fait qu'appliquer la transition d'etat. `periodStartsAt` /
   * `periodEndsAt` restent INCHANGES (O-02.6 : "nouvelles capacites disponibles aussitot", le
   * cycle de facturation en cours n'est pas reinitialise par un upgrade).
   */
  changePlan(params: {
    newPlanId: PlanId;
    newPlanPriceId: PlanPriceId;
    clock: Clock;
    idGenerator: IdGenerator;
  }): void {
    const fromPlanId = this.props.planId;
    this.props.planId = params.newPlanId;
    this.props.currentPlanPriceId = params.newPlanPriceId;
    this.addDomainEvent(
      SubscriptionPlanChanged.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        fromPlanId: fromPlanId.toString(),
        toPlanId: params.newPlanId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }
}
