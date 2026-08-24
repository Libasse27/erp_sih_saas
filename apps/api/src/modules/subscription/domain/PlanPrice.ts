import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import { PlanPriceId } from './value-objects/PlanPriceId.js';
import type { PlanId } from './value-objects/PlanId.js';
import type { BillingPeriod } from './value-objects/BillingPeriod.js';

interface PlanPriceProps {
  readonly planId: PlanId;
  readonly amount: Money;
  readonly period: BillingPeriod;
  readonly effectiveFrom: Date;
  readonly createdAt: Date;
}

/**
 * Tarif historise d'un `Plan`, DISTINCT du `Plan` lui-meme (01-target-architecture.md §6.3 :
 * "modifier un tarif n'affecte jamais retroactivement un abonnement en cours"). Schema
 * `platform`, HORS RLS tenant (ADR-0001 §3.3).
 *
 * Append-only par construction : cette classe n'expose AUCUNE methode de mutation (pas de
 * `changeAmount`, pas de setter) — le seul moyen de faire evoluer un tarif est de creer une
 * NOUVELLE ligne `PlanPrice` avec un `effectiveFrom` plus recent (voir
 * `infrastructure/seed/seedSubscriptionCatalog.ts` pour le seed initial). Le repository
 * (`PlanPriceRepository.save`) ne doit lui-meme jamais exposer d'UPDATE sur une ligne existante —
 * c'est cette classe qui rend une mutation impossible a exprimer en premier lieu, pas seulement
 * une discipline d'appel.
 *
 * Contrainte actee O-02.6 : le prix applique a un `Subscription` ne se lit JAMAIS via
 * `subscription.plan.price` — c'est TOUJOURS une instance de `PlanPrice` resolue explicitement
 * (le plus recent dont `effectiveFrom <= maintenant`) dont la reference (`id`) est conservee.
 */
export class PlanPrice extends AggregateRoot<PlanPriceId> {
  private readonly props: PlanPriceProps;

  private constructor(id: PlanPriceId, props: PlanPriceProps) {
    super(id);
    this.props = props;
  }

  static create(params: {
    planId: PlanId;
    amount: Money;
    period: BillingPeriod;
    effectiveFrom: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): PlanPrice {
    const idResult = PlanPriceId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour PlanPrice.');
    }
    return new PlanPrice(idResult.getValue(), {
      planId: params.planId,
      amount: params.amount,
      period: params.period,
      effectiveFrom: params.effectiveFrom,
      createdAt: params.clock.now(),
    });
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: PlanPriceId, props: PlanPriceProps): PlanPrice {
    return new PlanPrice(id, props);
  }

  get planId(): PlanId {
    return this.props.planId;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get period(): BillingPeriod {
    return this.props.period;
  }

  get effectiveFrom(): Date {
    return this.props.effectiveFrom;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
