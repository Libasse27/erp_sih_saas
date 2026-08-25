import { Entity } from '../../../shared-kernel/domain/Entity.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlanChangeId } from './value-objects/PlanChangeId.js';
import type { PlanChangeType } from './value-objects/PlanChangeType.js';
import type { PlanId } from './value-objects/PlanId.js';
import type { PlanPriceId } from './value-objects/PlanPriceId.js';
import type { SubscriptionId } from './value-objects/SubscriptionId.js';

interface PlanChangeProps {
  readonly subscriptionId: SubscriptionId;
  readonly tenantId: TenantId;
  readonly changeType: PlanChangeType;
  readonly fromPlanId: PlanId;
  readonly fromPlanPriceId: PlanPriceId;
  readonly toPlanId: PlanId;
  readonly toPlanPriceId: PlanPriceId;
  readonly proratedAmount: Money;
  /** Date de la DEMANDE, desormais distincte de `occurredAt` : entre les deux, le tenant a du payer. */
  readonly requestedAt: Date;
  /** Facture plateforme qui a paye ce changement — `null` pour les lignes anterieures a la passe 2, ou aucun paiement n'etait exige. */
  readonly platformInvoiceId: string | null;
  /** Date d'APPLICATION effective du changement de forfait (paiement deja confirme a cet instant). */
  readonly occurredAt: Date;
}

/**
 * Ligne d'historique APPEND-ONLY d'un changement de forfait (O-02.6 : "Chaque changement est
 * historise, independant et idempotent"). Choix de modelisation explicite pour cette etape : une
 * TABLE DEDIEE (`SubscriptionPlanChange`, voir `domain/ports/PlanChangeRepository.ts` et le
 * schema Prisma), PAS uniquement l'evenement de domaine `SubscriptionPlanChanged` — un evenement
 * relay par l'Outbox est une notification transitoire (at-least-once, pas garantie d'etre
 * relue), alors que cette ligne est le REGISTRE FINANCIER lui-meme : c'est elle, et seulement
 * elle, qui porte le montant proratise et la reference au `PlanPrice` reellement applique
 * (contrainte O-02.6 : "sa reference est conservee sur la transaction historisee, jamais
 * recalculee apres coup"). Les deux coexistent et ont des roles distincts : l'evenement notifie
 * les autres modules (facturation SaaS a l'etape 5, notification a l'etape 9), cette ligne est
 * la source de verite interrogeable.
 *
 * Immuable par construction, memes garanties qu'`PlanPrice` : AUCUNE methode de mutation
 * n'existe sur cette classe — un "changement du changement historise" n'a pas de sens.
 * `Entity` (pas `AggregateRoot`) : pas de cycle de vie propre au-dela de sa creation, n'emet
 * aucun evenement de domaine (celui-ci est porte par `Subscription.applyPlanUpgrade`, l'agregat
 * qui decide du changement).
 *
 * DEPUIS LA PASSE 2, cette ligne n'est ecrite QU'A L'APPLICATION EFFECTIVE d'un upgrade, une fois
 * le paiement confirme (`application/services/ApplyPlanUpgradeOnPaymentSucceeded.ts`) — plus au
 * moment de la demande. Elle porte donc DEUX instants distincts (`requestedAt` / `occurredAt`) et
 * la facture qui l'a payee (`platformInvoiceId`). Son `id` n'est plus genere ici : il est
 * PRE-ATTRIBUE des la demande (voir PlanUpgradeRequest.ts) et transmis par l'appelant — ce qui
 * rend l'ecriture idempotente par cle primaire face a une re-livraison Outbox (voir
 * `domain/ports/PlanChangeRepository.ts`).
 */
export class PlanChange extends Entity<PlanChangeId> {
  private readonly props: PlanChangeProps;

  private constructor(id: PlanChangeId, props: PlanChangeProps) {
    super(id);
    this.props = props;
  }

  static create(params: {
    /** PRE-ATTRIBUE a la demande d'upgrade, jamais genere ici (voir commentaire de tete). */
    id: PlanChangeId;
    subscriptionId: SubscriptionId;
    tenantId: TenantId;
    changeType: PlanChangeType;
    fromPlanId: PlanId;
    fromPlanPriceId: PlanPriceId;
    toPlanId: PlanId;
    toPlanPriceId: PlanPriceId;
    proratedAmount: Money;
    requestedAt: Date;
    platformInvoiceId: string | null;
    clock: Clock;
  }): PlanChange {
    return new PlanChange(params.id, {
      subscriptionId: params.subscriptionId,
      tenantId: params.tenantId,
      changeType: params.changeType,
      fromPlanId: params.fromPlanId,
      fromPlanPriceId: params.fromPlanPriceId,
      toPlanId: params.toPlanId,
      toPlanPriceId: params.toPlanPriceId,
      proratedAmount: params.proratedAmount,
      requestedAt: params.requestedAt,
      platformInvoiceId: params.platformInvoiceId,
      occurredAt: params.clock.now(),
    });
  }

  /** Reconstruction depuis la persistance. */
  static reconstitute(id: PlanChangeId, props: PlanChangeProps): PlanChange {
    return new PlanChange(id, props);
  }

  get subscriptionId(): SubscriptionId {
    return this.props.subscriptionId;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get changeType(): PlanChangeType {
    return this.props.changeType;
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

  get requestedAt(): Date {
    return this.props.requestedAt;
  }

  get platformInvoiceId(): string | null {
    return this.props.platformInvoiceId;
  }

  get occurredAt(): Date {
    return this.props.occurredAt;
  }
}
