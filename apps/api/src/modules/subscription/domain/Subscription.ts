import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlanUpgradeRequest } from './PlanUpgradeRequest.js';
import { addCalendarDays } from './services/CalendarDays.js';
import { SubscriptionDegradedModeEntered } from './events/SubscriptionDegradedModeEntered.js';
import { SubscriptionDegradedModeSustained } from './events/SubscriptionDegradedModeSustained.js';
import { SubscriptionGracePeriodStarted } from './events/SubscriptionGracePeriodStarted.js';
import { SubscriptionPlanChanged } from './events/SubscriptionPlanChanged.js';
import { SubscriptionReactivated } from './events/SubscriptionReactivated.js';
import { SubscriptionRenewalDue } from './events/SubscriptionRenewalDue.js';
import { SubscriptionRenewed } from './events/SubscriptionRenewed.js';
import { SubscriptionStarted } from './events/SubscriptionStarted.js';
import { SubscriptionUpgradeRequested } from './events/SubscriptionUpgradeRequested.js';
import { PlanChangeId } from './value-objects/PlanChangeId.js';
import { SubscriptionId } from './value-objects/SubscriptionId.js';
import type { BillingPeriod } from './value-objects/BillingPeriod.js';
import type { PlanId } from './value-objects/PlanId.js';
import type { PlanPriceId } from './value-objects/PlanPriceId.js';
import type { SubscriptionStatus } from './value-objects/SubscriptionStatus.js';

/** Duree de l'essai gratuit — O-02.5, valeur close par la decision, pas une valeur par defaut inventee. */
export const TRIAL_DURATION_DAYS = 30;

/** Duree de la periode de grace — O-03.2, valeur close par la decision. */
export const GRACE_PERIOD_DAYS = 7;

/** Duree du mode degrade AVANT maintien indefini (J+7 a J+37) — O-03.2, valeur close par la decision. */
export const DEGRADED_MODE_DAYS = 30;

/**
 * Delai laisse au tenant pour regler une demande d'upgrade proratise — valeur tranchee par le
 * product owner (24 heures), pas une valeur par defaut inventee. Passe ce delai, la demande est
 * consideree abandonnee et une NOUVELLE demande peut la remplacer (voir
 * `PlanUpgradeRequestRepository.replaceExpiredAndInsert`). Elle n'est PAS supprimee d'office :
 * un paiement confirme apres le TTL mais avant tout remplacement reste honore (voir
 * `PlanUpgradeRequest.isExpired`).
 */
export const UPGRADE_REQUEST_TTL_HOURS = 24;

const MS_PER_HOUR = 60 * 60 * 1000;

interface SubscriptionProps {
  readonly tenantId: TenantId;
  planId: PlanId;
  currentPlanPriceId: PlanPriceId;
  readonly period: BillingPeriod;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  periodStartsAt: Date;
  periodEndsAt: Date;
  readonly createdAt: Date;
  gracePeriodStartedAt: Date | null;
  degradedModeEnteredAt: Date | null;
  degradedModeSustainedNotifiedAt: Date | null;
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
 * Statut (`TRIALING`/`ACTIVE`/`GRACE_PERIOD`/`DEGRADED`, voir
 * `value-objects/SubscriptionStatus.ts`) — les deux derniers ajoutes a l'etape 5 (integration
 * O-25/O-03) : voir `startGracePeriod`/`enterDegradedMode`/`sustainDegradedMode`/`reactivate`/
 * `renew` ci-dessous pour les transitions, toutes pilotees par `ProcessSubscriptionRenewals.ts`
 * (scheduler) ou par la confirmation d'un paiement (module `payment`), jamais par un controleur.
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
   *
   * `ownerUserId` (ADR-0008 §9, resequencement F3 de la revue de securite de l'etape 10/13) :
   * simple donnee de CORRELATION propagee telle quelle jusqu'a `SubscriptionStarted.ownerUserId`
   * (voir events/SubscriptionStarted.ts) — jamais interpretee ni validee ici (cet agregat ne
   * connait pas `UserAccount`, module `identity`), resolue par l'appelant
   * (`StartTrialSubscription.ts`, qui la relit lui-meme depuis `HealthFacilityCreated.ownerUserId`
   * via son consommateur Outbox). REQUIS ICI, sans valeur par defaut : un abonnement de
   * provisioning ne peut pas exister sans l'identite du proprietaire initial destine a recevoir
   * `ADMIN_ETABLISSEMENT` — le contrat doit etre fort a la SOURCE (echec de compilation pour tout
   * appelant qui l'omettrait), pas seulement protege plus loin par la validation Zod du
   * consommateur Outbox (qui reste une seconde ligne de defense, jamais la premiere).
   */
  static startTrial(params: {
    tenantId: TenantId;
    standardPlanId: PlanId;
    standardPlanPriceId: PlanPriceId;
    ownerUserId: string;
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
      gracePeriodStartedAt: null,
      degradedModeEnteredAt: null,
      degradedModeSustainedNotifiedAt: null,
    });

    subscription.addDomainEvent(
      SubscriptionStarted.create({
        subscriptionId: id.toString(),
        tenantId: params.tenantId.toString(),
        planId: params.standardPlanId.toString(),
        trialEndsAt,
        ownerUserId: params.ownerUserId,
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

  get gracePeriodStartedAt(): Date | null {
    return this.props.gracePeriodStartedAt;
  }

  get degradedModeEnteredAt(): Date | null {
    return this.props.degradedModeEnteredAt;
  }

  get degradedModeSustainedNotifiedAt(): Date | null {
    return this.props.degradedModeSustainedNotifiedAt;
  }

  /**
   * Vrai si l'echeance de facturation est atteinte ET qu'aucune periode de grace n'a encore
   * demarre (statuts eligibles : `TRIALING`/`ACTIVE` uniquement — un abonnement deja en
   * `GRACE_PERIOD`/`DEGRADED` ne "redevient" jamais due par ce chemin, seul un paiement confirme
   * le fait sortir de cet etat). Utilise par le scheduler (`ProcessSubscriptionRenewals.ts`,
   * O-25.6) pour decider d'emettre `SubscriptionRenewalDue` + de demarrer la grace.
   */
  isRenewalDue(now: Date): boolean {
    return (
      (this.props.status === 'TRIALING' || this.props.status === 'ACTIVE') &&
      this.props.periodEndsAt.getTime() <= now.getTime()
    );
  }

  /** Vrai si la periode de grace (7 jours, O-03.2) est ecoulee sans regularisation. */
  isGracePeriodExpired(now: Date): boolean {
    return (
      this.props.status === 'GRACE_PERIOD' &&
      this.props.gracePeriodStartedAt !== null &&
      addCalendarDays(this.props.gracePeriodStartedAt, GRACE_PERIOD_DAYS).getTime() <= now.getTime()
    );
  }

  /** Vrai si le mode degrade dure depuis 30 jours (J+37 total, O-03.3) et n'a jamais encore ete signale comme "maintenu" (idempotence : une seule emission de `SubscriptionDegradedModeSustained`). */
  isDegradedModeSustainDue(now: Date): boolean {
    return (
      this.props.status === 'DEGRADED' &&
      this.props.degradedModeSustainedNotifiedAt === null &&
      this.props.degradedModeEnteredAt !== null &&
      addCalendarDays(this.props.degradedModeEnteredAt, DEGRADED_MODE_DAYS).getTime() <= now.getTime()
    );
  }

  /**
   * Signale l'echeance de facturation atteinte (O-25.6, scheduler) — N'ALTERE PAS le statut par
   * lui-meme (voir `startGracePeriod`, appele juste apres par l'appelant dans le meme cycle) :
   * distingue le FAIT "echeance atteinte, montant a facturer" (utile au module `payment`, qui
   * emet la facture a partir de cet evenement) de la CONSEQUENCE "entree en grace" (propre a cet
   * agregat). Le montant est resolu par l'appelant (`ProcessSubscriptionRenewals.ts`, via
   * `PlanPriceRepository` — jamais `plan.price`, O-02.6) : cet agregat ne fait aucune I/O.
   */
  markRenewalDue(params: {
    amountXof: number;
    newPeriodStartsAt: Date;
    newPeriodEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): void {
    this.addDomainEvent(
      SubscriptionRenewalDue.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        planPriceId: this.props.currentPlanPriceId.toString(),
        amountXof: params.amountXof,
        newPeriodStartsAt: params.newPeriodStartsAt,
        newPeriodEndsAt: params.newPeriodEndsAt,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /**
   * Entree en periode de grace (O-03.2) : echeance depassee, aucun paiement confirme pour la
   * nouvelle periode. Precondition verifiee par l'appelant via `isRenewalDue()` — un appel hors
   * de ce contexte est une erreur de programmation (bug), pas un echec metier attendu, donc leve
   * une exception plutot qu'un `Result` (§2 du system prompt).
   */
  startGracePeriod(params: { now: Date; clock: Clock; idGenerator: IdGenerator }): void {
    if (this.props.status !== 'TRIALING' && this.props.status !== 'ACTIVE') {
      throw new Error(`Transition invalide : startGracePeriod() appele depuis le statut ${this.props.status}.`);
    }
    this.props.status = 'GRACE_PERIOD';
    this.props.gracePeriodStartedAt = params.now;
    this.addDomainEvent(
      SubscriptionGracePeriodStarted.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        gracePeriodStartedAt: params.now,
        graceEndsAt: addCalendarDays(params.now, GRACE_PERIOD_DAYS),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /** Passage en mode degrade (O-03.2) : grace expiree sans regularisation. Precondition verifiee par l'appelant via `isGracePeriodExpired()`. */
  enterDegradedMode(params: { now: Date; clock: Clock; idGenerator: IdGenerator }): void {
    if (this.props.status !== 'GRACE_PERIOD') {
      throw new Error(`Transition invalide : enterDegradedMode() appele depuis le statut ${this.props.status}.`);
    }
    this.props.status = 'DEGRADED';
    this.props.degradedModeEnteredAt = params.now;
    this.addDomainEvent(
      SubscriptionDegradedModeEntered.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        degradedModeEnteredAt: params.now,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /**
   * Signale le maintien indefini du mode degrade a J+37 (O-03.3). IDEMPOTENT PAR CONSTRUCTION :
   * si deja signale (`degradedModeSustainedNotifiedAt` renseigne), ne fait rien et n'emet aucun
   * evenement — necessaire car le scheduler tourne a chaque cycle et reverifierait
   * indefiniment cette condition sans cette garde (le statut `DEGRADED` lui-meme, contrairement a
   * `GRACE_PERIOD`, ne change plus jamais automatiquement par la suite : "maintien indefini").
   */
  sustainDegradedMode(params: { clock: Clock; idGenerator: IdGenerator }): void {
    if (this.props.status !== 'DEGRADED') {
      throw new Error(`Transition invalide : sustainDegradedMode() appele depuis le statut ${this.props.status}.`);
    }
    if (this.props.degradedModeSustainedNotifiedAt !== null) {
      return;
    }
    this.props.degradedModeSustainedNotifiedAt = params.clock.now();
    this.addDomainEvent(
      SubscriptionDegradedModeSustained.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /**
   * Renouvellement a l'echeance SANS jamais etre passe par la grace (paiement confirme avant ou
   * au moment de `periodEndsAt`) — reste `ACTIVE`, emet `SubscriptionRenewed` (distinct de
   * `SubscriptionReactivated`, reserve a la sortie de grace/degrade). Convertit aussi un essai
   * (`TRIALING`) en abonnement payant, `trialEndsAt` efface : c'est le meme mecanisme qui traite
   * la "premiere echeance due" d'un essai que le renouvellement d'un abonnement payant (voir
   * ProcessSubscriptionRenewals.ts — aucun etat "conversion" distinct invente).
   *
   * IDEMPOTENT du point de vue de l'appelant, meme garde que `reactivate()` : si deja `ACTIVE`
   * avec une periode couvrant deja `newPeriodEndsAt`, ne fait rien (re-livraison at-least-once
   * du meme evenement `SaaSPaymentSucceeded`).
   */
  renew(params: { newPeriodStartsAt: Date; newPeriodEndsAt: Date; clock: Clock; idGenerator: IdGenerator }): void {
    if (this.props.status === 'ACTIVE' && this.props.periodEndsAt.getTime() >= params.newPeriodEndsAt.getTime()) {
      return;
    }
    if (this.props.status !== 'ACTIVE' && this.props.status !== 'TRIALING') {
      throw new Error(`Transition invalide : renew() appele depuis le statut ${this.props.status}.`);
    }
    this.props.status = 'ACTIVE';
    this.props.trialEndsAt = null;
    this.props.periodStartsAt = params.newPeriodStartsAt;
    this.props.periodEndsAt = params.newPeriodEndsAt;
    this.addDomainEvent(
      SubscriptionRenewed.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        newPeriodStartsAt: params.newPeriodStartsAt,
        newPeriodEndsAt: params.newPeriodEndsAt,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /**
   * Sortie de `GRACE_PERIOD`/`DEGRADED` suite a un paiement confirme, A TOUT MOMENT (O-25.6).
   * IDEMPOTENT du point de vue de l'appelant : si l'abonnement est deja `ACTIVE` avec une
   * periode couvrant deja `newPeriodEndsAt`, ne fait rien (evite une double reactivation en cas
   * de re-livraison at-least-once du meme evenement `SaaSPaymentSucceeded` par l'Outbox).
   */
  reactivate(params: { newPeriodStartsAt: Date; newPeriodEndsAt: Date; clock: Clock; idGenerator: IdGenerator }): void {
    if (this.props.status === 'ACTIVE' && this.props.periodEndsAt.getTime() >= params.newPeriodEndsAt.getTime()) {
      return;
    }
    if (this.props.status !== 'GRACE_PERIOD' && this.props.status !== 'DEGRADED') {
      throw new Error(`Transition invalide : reactivate() appele depuis le statut ${this.props.status}.`);
    }
    this.props.status = 'ACTIVE';
    this.props.trialEndsAt = null;
    this.props.periodStartsAt = params.newPeriodStartsAt;
    this.props.periodEndsAt = params.newPeriodEndsAt;
    this.props.gracePeriodStartedAt = null;
    this.props.degradedModeEnteredAt = null;
    this.props.degradedModeSustainedNotifiedAt = null;
    this.addDomainEvent(
      SubscriptionReactivated.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        newPeriodStartsAt: params.newPeriodStartsAt,
        newPeriodEndsAt: params.newPeriodEndsAt,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /**
   * DEMANDE un upgrade proratise — NE CHANGE PAS le forfait (`planId`/`currentPlanPriceId` restent
   * intacts). Produit une `PlanUpgradeRequest` figeant toutes les valeurs financieres, et emet
   * `SubscriptionUpgradeRequested` pour que le module `payment` emette la facture correspondante.
   * Le forfait ne changera qu'a la confirmation du paiement, via `applyPlanUpgrade()` — c'est CE
   * decoupage, et lui seul, qui rend impossible "monter en gamme sans payer".
   *
   * L'evenement est emis sur CET agregat (et non sur `PlanUpgradeRequest`, qui n'est pas un
   * `AggregateRoot`) : c'est `Subscription` qui decide, la demande n'est que le fait resultant.
   *
   * PRECONDITION `status === 'ACTIVE'`, verifiee ici par une EXCEPTION et non par un `Result` :
   * l'appelant (`UpgradeSubscriptionPlanHandler`) a DEJA verifie ce statut en amont et renvoie
   * `SUBSCRIPTION_NOT_UPGRADABLE` sans jamais atteindre cette methode — un appel depuis un autre
   * statut est donc un bug de programmation, pas un echec metier attendu (meme discipline que
   * `startGracePeriod`/`enterDegradedMode`). Rappel de la decision produit sur ce refus :
   *   - `TRIALING` : la base de calcul du prorata serait un prix jamais reellement paye ;
   *   - `GRACE_PERIOD`/`DEGRADED` : les "jours restants" n'ont pas de sens sur une periode deja
   *     impayee, et vendre une montee en gamme a un compte en defaut est incoherent.
   *
   * La periode COUVERTE par le prorata va de `now` a `periodEndsAt` — decision de conception non
   * explicitee par le brief : c'est exactement l'assiette du calcul de `ProrationCalculator`
   * ("jours restants sur la periode en cours"), la facture d'upgrade doit donc porter cette meme
   * fenetre, et non le cycle de facturation complet, qui laisserait croire que l'upgrade couvre
   * des jours deja factures au tarif precedent.
   */
  requestUpgrade(params: {
    planChangeId: string;
    toPlanId: PlanId;
    toPlanPriceId: PlanPriceId;
    proratedAmount: Money;
    now: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): PlanUpgradeRequest {
    if (this.props.status !== 'ACTIVE') {
      throw new Error(`Transition invalide : requestUpgrade() appele depuis le statut ${this.props.status}.`);
    }

    const planChangeIdResult = PlanChangeId.create(params.planChangeId);
    if (planChangeIdResult.isFailure()) {
      throw new Error('planChangeId invalide fourni a requestUpgrade() (bug applicatif).');
    }

    // Addition directe en millisecondes : un TTL de 24h est une DUREE exacte, pas un decalage
    // "au jour calendaire pres" comme la grace ou l'essai — aucune abstraction supplementaire a
    // cote de CalendarDays.ts ne se justifie pour une seule addition.
    const expiresAt = new Date(params.now.getTime() + UPGRADE_REQUEST_TTL_HOURS * MS_PER_HOUR);

    const request = PlanUpgradeRequest.create(planChangeIdResult.getValue(), {
      subscriptionId: this.id,
      tenantId: this.props.tenantId,
      fromPlanId: this.props.planId,
      fromPlanPriceId: this.props.currentPlanPriceId,
      toPlanId: params.toPlanId,
      toPlanPriceId: params.toPlanPriceId,
      proratedAmount: params.proratedAmount,
      coveredPeriodStartsAt: params.now,
      coveredPeriodEndsAt: this.props.periodEndsAt,
      requestedAt: params.now,
      expiresAt,
    });

    this.addDomainEvent(
      SubscriptionUpgradeRequested.create({
        subscriptionId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        planChangeId: params.planChangeId,
        fromPlanId: this.props.planId.toString(),
        fromPlanPriceId: this.props.currentPlanPriceId.toString(),
        toPlanId: params.toPlanId.toString(),
        toPlanPriceId: params.toPlanPriceId.toString(),
        proratedAmountXof: params.proratedAmount.amount,
        coveredPeriodStartsAt: params.now,
        coveredPeriodEndsAt: this.props.periodEndsAt,
        expiresAt,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );

    return request;
  }

  /**
   * Applique un changement de forfait DEJA VALIDE comme upgrade, DEJA PRORATISE **et DEJA PAYE** :
   * cette methode ne refait aucun calcul, elle ne fait qu'appliquer la transition d'etat.
   * `periodStartsAt` / `periodEndsAt` restent INCHANGES (O-02.6 : "nouvelles capacites disponibles
   * aussitot", le cycle de facturation en cours n'est pas reinitialise par un upgrade).
   *
   * N'EST APPELEE QUE DEPUIS `application/services/ApplyPlanUpgradeOnPaymentSucceeded.ts` (le
   * consommateur Outbox de `SaaSPaymentSucceeded`), JAMAIS depuis `UpgradeSubscriptionPlanHandler`
   * — c'est la meme discipline "impossible par construction" que `ConfirmPaymentHandler` pour
   * l'activation webhook-only : il n'existe aucun chemin de code par lequel une demande d'upgrade
   * puisse appliquer elle-meme le changement.
   *
   * IDEMPOTENTE, meme garde que `renew()`/`reactivate()` : si l'abonnement est DEJA sur le forfait
   * ET le tarif cibles, ne fait rien et n'emet AUCUN evenement — indispensable face a une
   * re-livraison at-least-once du meme `SaaSPaymentSucceeded` par l'Outbox, qui produirait sinon un
   * second `SubscriptionPlanChanged` pour un changement unique.
   */
  applyPlanUpgrade(params: {
    newPlanId: PlanId;
    newPlanPriceId: PlanPriceId;
    clock: Clock;
    idGenerator: IdGenerator;
  }): void {
    if (
      this.props.planId.equals(params.newPlanId) &&
      this.props.currentPlanPriceId.equals(params.newPlanPriceId)
    ) {
      return;
    }

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
