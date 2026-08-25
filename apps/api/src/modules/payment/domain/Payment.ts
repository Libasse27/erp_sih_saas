import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { SaaSPaymentSucceeded } from './events/SaaSPaymentSucceeded.js';
import { PaymentId } from './value-objects/PaymentId.js';
import type { PaymentMethod } from './value-objects/PaymentMethod.js';
import type { PaymentPurpose } from './value-objects/PaymentPurpose.js';
import { isTerminalSuccessStatus, type PaymentStatus } from './value-objects/PaymentStatus.js';
import type { PlatformInvoiceId } from './value-objects/PlatformInvoiceId.js';

interface PaymentProps {
  readonly tenantId: TenantId;
  readonly platformInvoiceId: PlatformInvoiceId;
  readonly subscriptionId: string;
  readonly purpose: PaymentPurpose;
  readonly method: PaymentMethod;
  readonly amount: Money;
  status: PaymentStatus;
  readonly providerTransactionId: string;
  readonly initiatedAt: Date;
  confirmedAt: Date | null;
}

/**
 * UNE TENTATIVE de paiement pour une `PlatformInvoice` (O-25, 01-target-architecture.md §6.3).
 * Schema `platform`, HORS RLS (ADR-0001 §3.3), filtrage tenant purement applicatif.
 *
 * `providerTransactionId` : cle d'idempotence webhook imposee par O-25.5 ("idempotence par
 * identifiant de transaction fournisseur") — resolue SYNCHRONEMENT par le port `PaymentProvider`
 * au moment de `initiate()` (le prestataire sandbox, comme un prestataire reel, renvoie un
 * identifiant de transaction des l'amorçage du paiement, avant meme la confirmation).
 *
 * Statut : les 6 valeurs EXACTES d'O-25.5 (voir value-objects/PaymentStatus.ts pour la nuance
 * SUCCEEDED/RENEWED, signalee a l'architecte). Transitions autorisees :
 *   PENDING -> SUCCEEDED | RENEWED | FAILED | EXPIRED | CANCELLED
 *   FAILED  -> SUCCEEDED | RENEWED   (webhook tardif, O-25.6 "a tout moment")
 *   EXPIRED -> SUCCEEDED | RENEWED   (paiement confirme apres echeance, meme raison)
 *   SUCCEEDED/RENEWED -> RIEN (succes TERMINAL, jamais retrograde par un evenement ulterieur —
 *     l'argent est deja recu ; toute confirmation supplementaire pour le MEME
 *     providerTransactionId est un no-op idempotent, toute notification FAILED/EXPIRED tardive
 *     pour ce meme providerTransactionId est silencieusement ignoree)
 *   CANCELLED -> RIEN (terminal)
 */
export class Payment extends AggregateRoot<PaymentId> {
  private props: PaymentProps;

  private constructor(id: PaymentId, props: PaymentProps) {
    super(id);
    this.props = props;
  }

  /**
   * Cree une tentative de paiement DEJA INITIEE aupres du prestataire (le `providerTransactionId`
   * est fourni par l'appelant, resolu via `PaymentProvider.initiatePayment()` — cet agregat ne
   * fait aucune I/O, voir application/commands/InitiatePayment.ts).
   */
  static initiate(params: {
    tenantId: TenantId;
    platformInvoiceId: PlatformInvoiceId;
    subscriptionId: string;
    purpose: PaymentPurpose;
    method: PaymentMethod;
    amount: Money;
    providerTransactionId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): Payment {
    const idResult = PaymentId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour Payment.');
    }
    return new Payment(idResult.getValue(), {
      tenantId: params.tenantId,
      platformInvoiceId: params.platformInvoiceId,
      subscriptionId: params.subscriptionId,
      purpose: params.purpose,
      method: params.method,
      amount: params.amount,
      status: 'PENDING',
      providerTransactionId: params.providerTransactionId,
      initiatedAt: params.clock.now(),
      confirmedAt: null,
    });
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: PaymentId, props: PaymentProps): Payment {
    return new Payment(id, props);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get platformInvoiceId(): PlatformInvoiceId {
    return this.props.platformInvoiceId;
  }

  get subscriptionId(): string {
    return this.props.subscriptionId;
  }

  get purpose(): PaymentPurpose {
    return this.props.purpose;
  }

  get method(): PaymentMethod {
    return this.props.method;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get status(): PaymentStatus {
    return this.props.status;
  }

  get providerTransactionId(): string {
    return this.props.providerTransactionId;
  }

  get initiatedAt(): Date {
    return this.props.initiatedAt;
  }

  get confirmedAt(): Date | null {
    return this.props.confirmedAt;
  }

  /**
   * Confirmation de succes (webhook signe valide OU rapprochement periodique — O-25.5/O-25.6, "a
   * tout moment"). IDEMPOTENT : si deja en succes terminal (`SUCCEEDED`/`RENEWED`), ne fait rien
   * et n'emet aucun evenement (webhook recu 2 fois / notification dupliquee). Accepte depuis
   * `PENDING`, `FAILED` (webhook recu dans le mauvais ordre) ou `EXPIRED` (paiement confirme
   * apres echeance) — jamais depuis `CANCELLED` (erreur de programmation : un `Payment` annule
   * ne doit jamais etre soumis a une confirmation, cette voie n'est atteignable que si le
   * `providerTransactionId` a ete mal resolu en amont).
   *
   * Choisit `RENEWED` plutot que `SUCCEEDED` si `purpose === 'RENEWAL'` (voir PaymentStatus.ts).
   */
  confirmSucceeded(params: {
    providerTransactionId: string;
    confirmedAt: Date;
    newPeriodStartsAt: Date;
    newPeriodEndsAt: Date;
    clock: Clock;
    idGenerator: IdGenerator;
  }): void {
    if (params.providerTransactionId !== this.props.providerTransactionId) {
      throw new Error(
        'confirmSucceeded() appele avec un providerTransactionId different de celui de ce Payment (bug applicatif).',
      );
    }
    if (isTerminalSuccessStatus(this.props.status)) {
      return;
    }
    if (this.props.status === 'CANCELLED') {
      throw new Error('Transition invalide : confirmSucceeded() sur un Payment CANCELLED.');
    }

    this.props.status = this.props.purpose === 'RENEWAL' ? 'RENEWED' : 'SUCCEEDED';
    this.props.confirmedAt = params.confirmedAt;

    this.addDomainEvent(
      SaaSPaymentSucceeded.create({
        paymentId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        platformInvoiceId: this.props.platformInvoiceId.toString(),
        subscriptionId: this.props.subscriptionId,
        providerTransactionId: this.props.providerTransactionId,
        newPeriodStartsAt: params.newPeriodStartsAt,
        newPeriodEndsAt: params.newPeriodEndsAt,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
  }

  /**
   * Confirmation d'echec. STICKY dans l'autre sens : ne retrograde JAMAIS un succes terminal
   * deja confirme (webhook FAILED tardif apres un SUCCEEDED anterieur pour le meme
   * providerTransactionId — argent deja recu, ignorer silencieusement). Idempotent sur `FAILED`
   * lui-meme et no-op sur `CANCELLED`. N'emet aucun evenement (rien ne consomme un echec de
   * paiement a cette etape — le declenchement de la grace reste piloté par le scheduler, jamais
   * par ce webhook, O-25.6).
   */
  confirmFailed(params: { providerTransactionId: string }): void {
    if (params.providerTransactionId !== this.props.providerTransactionId) {
      throw new Error(
        'confirmFailed() appele avec un providerTransactionId different de celui de ce Payment (bug applicatif).',
      );
    }
    if (isTerminalSuccessStatus(this.props.status) || this.props.status === 'CANCELLED') {
      return;
    }
    this.props.status = 'FAILED';
  }

  /**
   * Marque une tentative `PENDING` expiree (rapprochement periodique, jamais un webhook) —
   * jamais depuis un succes terminal ni `CANCELLED` (memes garanties que `confirmFailed`), et
   * idempotent sur `EXPIRED`/`FAILED` (ne fait rien, pas de re-degradation d'un `FAILED` deja
   * constate vers `EXPIRED`).
   */
  markExpired(): void {
    if (this.props.status !== 'PENDING') {
      return;
    }
    this.props.status = 'EXPIRED';
  }
}
