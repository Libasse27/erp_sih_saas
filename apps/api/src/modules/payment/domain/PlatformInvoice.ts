import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { PlatformInvoiceId } from './value-objects/PlatformInvoiceId.js';
import type { PlatformInvoicePurpose } from './value-objects/PlatformInvoicePurpose.js';
import type { PlatformInvoiceStatus } from './value-objects/PlatformInvoiceStatus.js';

/**
 * Reference minimale a un `Subscription`/`PlanPrice` (module `subscription`) : SEULEMENT
 * l'identifiant, jamais le type du domaine d'un autre module (regle dependency-cruiser
 * `no-cross-module-domain-import`) — voir `application/commands/IssuePlatformInvoice.ts` pour
 * comment ces identifiants sont recus (payload de l'evenement `SubscriptionRenewalDue`, jamais
 * un import direct).
 */
interface PlatformInvoiceProps {
  readonly tenantId: TenantId;
  readonly subscriptionId: string;
  readonly planPriceId: string;
  readonly purpose: PlatformInvoicePurpose;
  /**
   * Reference OPAQUE du fait metier a l'origine de cette facture, fournie par le module emetteur
   * via le payload de l'evenement consomme — `null` pour une facture de renouvellement (le
   * couple `(subscriptionId, periodStartsAt)` suffit deja a l'identifier). Ce module ne sait RIEN
   * de ce que cette chaine designe cote emetteur (a la passe 2 : un `PlanChangeId` du module
   * `subscription`) : il se contente de la conserver et de la restituer dans
   * `SaaSPaymentSucceeded`, ce qui permet a l'emetteur de retrouver SON fait metier sans
   * qu'aucun concept de son domaine ne fuie ici (regle `no-cross-module-domain-import`).
   */
  readonly sourceReference: string | null;
  readonly amount: Money;
  readonly periodStartsAt: Date;
  readonly periodEndsAt: Date;
  status: PlatformInvoiceStatus;
  readonly issuedAt: Date;
  paidAt: Date | null;
}

/**
 * Ce qui est du a la plateforme pour UNE periode de facturation d'UN abonnement (O-25,
 * 01-target-architecture.md §6.3 — agregat explicitement enumere, distinct de `Payment` : une
 * facture peut recevoir plusieurs TENTATIVES de paiement, voir domain/Payment.ts). Schema
 * `platform`, HORS RLS (ADR-0001 §3.3) — filtrage tenant purement applicatif dans le repository.
 *
 * Minimal V1 (O-25.1, remboursement hors V1) : ISSUED -> PAID, aucune autre transition. Aucun
 * evenement de domaine emis par cet agregat a cette etape — le declencheur des consommateurs
 * (module `subscription`) est `SaaSPaymentSucceeded`, emis par `Payment`, pas par cette classe ;
 * elle reste neanmoins un `AggregateRoot` (et non un simple `Entity` comme `PlanChange`) pour
 * rester fidele a sa designation explicite comme agregat dans 01-target-architecture.md §6.3, et
 * parce que son cycle de vie (ISSUED -> PAID) va au-dela de la simple creation.
 */
export class PlatformInvoice extends AggregateRoot<PlatformInvoiceId> {
  private props: PlatformInvoiceProps;

  private constructor(id: PlatformInvoiceId, props: PlatformInvoiceProps) {
    super(id);
    this.props = props;
  }

  static issue(params: {
    tenantId: TenantId;
    subscriptionId: string;
    planPriceId: string;
    purpose: PlatformInvoicePurpose;
    /** Optionnel : les factures de renouvellement n'en portent aucune (voir `sourceReference` dans les props). */
    sourceReference?: string | null;
    amount: Money;
    periodStartsAt: Date;
    periodEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): PlatformInvoice {
    const idResult = PlatformInvoiceId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour PlatformInvoice.');
    }
    return new PlatformInvoice(idResult.getValue(), {
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      planPriceId: params.planPriceId,
      purpose: params.purpose,
      sourceReference: params.sourceReference ?? null,
      amount: params.amount,
      periodStartsAt: params.periodStartsAt,
      periodEndsAt: params.periodEndsAt,
      status: 'ISSUED',
      issuedAt: params.clock.now(),
      paidAt: null,
    });
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: PlatformInvoiceId, props: PlatformInvoiceProps): PlatformInvoice {
    return new PlatformInvoice(id, props);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get subscriptionId(): string {
    return this.props.subscriptionId;
  }

  get planPriceId(): string {
    return this.props.planPriceId;
  }

  get purpose(): PlatformInvoicePurpose {
    return this.props.purpose;
  }

  get sourceReference(): string | null {
    return this.props.sourceReference;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get periodStartsAt(): Date {
    return this.props.periodStartsAt;
  }

  get periodEndsAt(): Date {
    return this.props.periodEndsAt;
  }

  get status(): PlatformInvoiceStatus {
    return this.props.status;
  }

  get issuedAt(): Date {
    return this.props.issuedAt;
  }

  get paidAt(): Date | null {
    return this.props.paidAt;
  }

  /**
   * Marque la facture payee. IDEMPOTENT PAR CONSTRUCTION (deja `PAID` -> ne fait rien) : appele
   * par un consommateur Outbox (at-least-once, D9) reagissant a `SaaSPaymentSucceeded` — une
   * re-livraison ne doit jamais produire d'effet observable supplementaire.
   */
  markPaid(paidAt: Date): void {
    if (this.props.status === 'PAID') {
      return;
    }
    this.props.status = 'PAID';
    this.props.paidAt = paidAt;
  }
}
