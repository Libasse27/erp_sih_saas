import { Entity } from '../../../shared-kernel/domain/Entity.js';
import type { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlanChangeId } from './value-objects/PlanChangeId.js';
import type { PlanId } from './value-objects/PlanId.js';
import type { PlanPriceId } from './value-objects/PlanPriceId.js';
import type { SubscriptionId } from './value-objects/SubscriptionId.js';

interface PlanUpgradeRequestProps {
  readonly subscriptionId: SubscriptionId;
  readonly tenantId: TenantId;
  readonly fromPlanId: PlanId;
  readonly fromPlanPriceId: PlanPriceId;
  readonly toPlanId: PlanId;
  readonly toPlanPriceId: PlanPriceId;
  readonly proratedAmount: Money;
  readonly coveredPeriodStartsAt: Date;
  readonly coveredPeriodEndsAt: Date;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Demande d'upgrade EN ATTENTE DE PAIEMENT : l'etat intermediaire, jusqu'ici inexistant, entre
 * "le tenant demande a monter en gamme" et "le forfait est effectivement change". Toutes les
 * valeurs financieres y sont FIGEES au moment de la demande (montant proratise, tarifs source et
 * cible, periode couverte) — l'application ulterieure, declenchee par la confirmation du paiement
 * (`application/services/ApplyPlanUpgradeOnPaymentSucceeded.ts`), ne recalcule JAMAIS rien : le
 * tenant paie exactement ce qui lui a ete annonce, meme si le catalogue a change entre-temps.
 *
 * `id` = un `PlanChangeId` PRE-ATTRIBUE des la demande, et non genere a l'application. C'est cette
 * identite unique qui circule comme reference opaque (`sourceReference`) jusqu'a la facture
 * plateforme puis revient dans `SaaSPaymentSucceeded` — elle permet de rattacher un paiement
 * confirme a LA demande precise qu'il regle. Correler par `subscriptionId` seul ne suffirait pas :
 * la machine a etats de `Payment` autorise explicitement `FAILED -> SUCCEEDED` et
 * `EXPIRED -> SUCCEEDED` (webhooks tardifs, O-25.6), donc une confirmation tardive d'un upgrade
 * ABANDONNE et remplace appliquerait le NOUVEL upgrade avec le prorata de l'ANCIEN — corruption
 * financiere silencieuse.
 *
 * PAS de colonne/prop `status` : la PRESENCE de cette entite EST le fait "un upgrade est en
 * attente". Elle est supprimee a l'application ; l'historique definitif, lui, est `PlanChange`
 * (append-only), qui reprend ce meme identifiant. Un statut ici creerait deux sources de verite
 * pour un meme fait.
 *
 * `Entity` (pas `AggregateRoot`), meme regime que `PlanChange.ts` : vit dans la frontiere de
 * coherence de l'agregat `Subscription`, ecrite dans la MEME transaction que
 * `SubscriptionRepository.save()`, jamais seule — et n'emet donc aucun evenement de domaine
 * (`SubscriptionUpgradeRequested` est porte par l'agregat `Subscription`, qui decide). Immuable :
 * aucune methode de mutation, une demande ne se modifie pas, elle est remplacee ou supprimee.
 */
export class PlanUpgradeRequest extends Entity<PlanChangeId> {
  private readonly props: PlanUpgradeRequestProps;

  private constructor(id: PlanChangeId, props: PlanUpgradeRequestProps) {
    super(id);
    this.props = props;
  }

  static create(id: PlanChangeId, props: PlanUpgradeRequestProps): PlanUpgradeRequest {
    return new PlanUpgradeRequest(id, props);
  }

  /** Reconstruction depuis la persistance — strictement equivalente a `create` (entite immuable, sans evenement). */
  static reconstitute(id: PlanChangeId, props: PlanUpgradeRequestProps): PlanUpgradeRequest {
    return new PlanUpgradeRequest(id, props);
  }

  get subscriptionId(): SubscriptionId {
    return this.props.subscriptionId;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get fromPlanId(): PlanId {
    return this.props.fromPlanId;
  }

  get fromPlanPriceId(): PlanPriceId {
    return this.props.fromPlanPriceId;
  }

  get toPlanId(): PlanId {
    return this.props.toPlanId;
  }

  get toPlanPriceId(): PlanPriceId {
    return this.props.toPlanPriceId;
  }

  get proratedAmount(): Money {
    return this.props.proratedAmount;
  }

  get coveredPeriodStartsAt(): Date {
    return this.props.coveredPeriodStartsAt;
  }

  get coveredPeriodEndsAt(): Date {
    return this.props.coveredPeriodEndsAt;
  }

  get requestedAt(): Date {
    return this.props.requestedAt;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  /**
   * Vrai si le delai de paiement (TTL, voir `Subscription.UPGRADE_REQUEST_TTL_HOURS`) est ecoule.
   * Une demande expiree n'est PAS supprimee automatiquement : elle reste en base jusqu'a ce qu'une
   * nouvelle demande la remplace. Consequence VOULUE (decision produit) : un paiement confirme
   * APRES le TTL mais AVANT tout remplacement reste honore — l'argent est recu, l'intention du
   * tenant est honoree. Seul un REMPLACEMENT effectif rend un paiement tardif orphelin.
   */
  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }
}
