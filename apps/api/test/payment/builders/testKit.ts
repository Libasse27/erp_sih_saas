import type { Clock } from '../../../src/shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../src/shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork, UnitOfWorkContext } from '../../../src/shared-kernel/application/UnitOfWork.js';
import type { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Money } from '../../../src/shared-kernel/domain/value-objects/Money.js';
import { Result } from '../../../src/shared-kernel/domain/Result.js';
import type { Payment } from '../../../src/modules/payment/domain/Payment.js';
import type { PaymentRepository } from '../../../src/modules/payment/domain/ports/PaymentRepository.js';
import type { PaymentId } from '../../../src/modules/payment/domain/value-objects/PaymentId.js';
import type { PlatformInvoice } from '../../../src/modules/payment/domain/PlatformInvoice.js';
import type { PlatformInvoiceRepository } from '../../../src/modules/payment/domain/ports/PlatformInvoiceRepository.js';
import type { PlatformInvoiceId } from '../../../src/modules/payment/domain/value-objects/PlatformInvoiceId.js';
import type { BillingAuditRecordInput, BillingAuditTrail } from '../../../src/modules/payment/application/ports/BillingAuditTrail.js';
import type {
  InitiatePaymentRequest,
  InitiatePaymentResult,
  PaymentProvider,
  ProviderTransactionStatus,
  ProviderWebhookEvent,
  ProviderWebhookOutcome,
} from '../../../src/modules/payment/domain/ports/PaymentProvider.js';

// Duplique volontairement les primitives generiques de test/subscription/builders/testKit.ts —
// meme raisonnement documente la-bas (§9.2 : "aucune base partagee entre fichiers", y compris
// pour les doublures de ports partages du shared-kernel).

export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  now(): Date {
    return this.current;
  }

  advanceTo(iso: string): void {
    this.current = new Date(iso);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  generate(): string {
    this.counter += 1;
    const hex = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }
}

export function uuidAt(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export class InMemoryUnitOfWork implements UnitOfWork {
  public lastContext: UnitOfWorkContext | undefined;

  async withTransaction<T>(work: () => Promise<T>, context?: UnitOfWorkContext): Promise<T> {
    this.lastContext = context;
    return work();
  }
}

export class InMemoryPlatformInvoiceRepository implements PlatformInvoiceRepository {
  private readonly byId = new Map<string, PlatformInvoice>();

  async findById(id: PlatformInvoiceId, tenantId: TenantId): Promise<PlatformInvoice | null> {
    const invoice = this.byId.get(id.toString());
    if (invoice === undefined || !invoice.tenantId.equals(tenantId)) {
      return null;
    }
    return invoice;
  }

  async findBySourceReference(sourceReference: string, tenantId: TenantId): Promise<PlatformInvoice | null> {
    for (const invoice of this.byId.values()) {
      if (invoice.sourceReference === sourceReference && invoice.tenantId.equals(tenantId)) {
        return invoice;
      }
    }
    return null;
  }

  /**
   * Reproduit le contrat reel (voir PrismaPlatformInvoiceRepository.issue()) : idempotent sur les
   * DEUX contraintes UNIQUE de la table — `sourceReference` (verifiee EN PREMIER, comme la
   * discrimination par `error.meta.target` cote Prisma) puis
   * `(subscriptionId, purpose, periodStartsAt)`. `purpose` fait bien partie de la seconde cle : une
   * facture d'UPGRADE et une facture de RENOUVELLEMENT peuvent coexister sur la meme periode.
   */
  async issue(invoice: PlatformInvoice): Promise<PlatformInvoice> {
    for (const existing of this.byId.values()) {
      if (invoice.sourceReference !== null && existing.sourceReference === invoice.sourceReference) {
        return existing;
      }
      if (
        existing.subscriptionId === invoice.subscriptionId &&
        existing.purpose === invoice.purpose &&
        existing.periodStartsAt.getTime() === invoice.periodStartsAt.getTime()
      ) {
        return existing;
      }
    }
    invoice.pullDomainEvents();
    this.byId.set(invoice.id.toString(), invoice);
    return invoice;
  }

  async save(invoice: PlatformInvoice, tenantId: TenantId): Promise<void> {
    if (!invoice.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'une PlatformInvoice hors du tenant du contexte courant.");
    }
    invoice.pullDomainEvents();
    this.byId.set(invoice.id.toString(), invoice);
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly byId = new Map<string, Payment>();

  async findById(id: PaymentId, tenantId: TenantId): Promise<Payment | null> {
    const payment = this.byId.get(id.toString());
    if (payment === undefined || !payment.tenantId.equals(tenantId)) {
      return null;
    }
    return payment;
  }

  async findByProviderTransactionId(providerTransactionId: string): Promise<Payment | null> {
    for (const payment of this.byId.values()) {
      if (payment.providerTransactionId === providerTransactionId) {
        return payment;
      }
    }
    return null;
  }

  async save(payment: Payment, tenantId: TenantId): Promise<void> {
    if (!payment.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un Payment hors du tenant du contexte courant.");
    }
    payment.pullDomainEvents();
    this.byId.set(payment.id.toString(), payment);
  }

  async listPendingInitiatedBefore(olderThan: Date): Promise<readonly Payment[]> {
    return [...this.byId.values()].filter(
      (payment) => payment.status === 'PENDING' && payment.initiatedAt.getTime() <= olderThan.getTime(),
    );
  }
}

interface FakeTransactionRecord {
  status: ProviderTransactionStatus;
}

/**
 * Fausse implementation DETERMINISTE du port `PaymentProvider`, pour les tests de handler
 * d'application (pas de vraie signature HMAC : ce n'est pas le sujet teste ici, voir
 * SandboxPaymentProviderAdapter.test.ts pour la couverture de la signature reelle). Signature
 * "valide" = header egal EXACTEMENT a `VALID_SIGNATURE_HEADER`.
 */
export const VALID_SIGNATURE_HEADER = 'valid-signature';

export class InMemoryPaymentProvider implements PaymentProvider {
  private readonly transactions = new Map<string, FakeTransactionRecord>();
  private counter = 0;

  async initiatePayment(request: InitiatePaymentRequest): Promise<InitiatePaymentResult> {
    void request;
    this.counter += 1;
    const providerTransactionId = `fake_tx_${this.counter}`;
    this.transactions.set(providerTransactionId, { status: 'PENDING' });
    return { providerTransactionId, redirectUrl: null };
  }

  verifyWebhookSignature(params: { rawBody: string; signatureHeader: string | undefined }): boolean {
    return params.signatureHeader === VALID_SIGNATURE_HEADER;
  }

  parseWebhookPayload(rawBody: string): ProviderWebhookEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const { providerTransactionId, outcome, occurredAt, amount } = record;
    if (typeof providerTransactionId !== 'string' || typeof occurredAt !== 'string') {
      return null;
    }
    if (outcome !== 'SUCCEEDED' && outcome !== 'FAILED') {
      return null;
    }
    if (typeof amount !== 'number') {
      return null;
    }
    const amountResult = Money.fromXOF(amount);
    if (amountResult.isFailure()) {
      return null;
    }
    return {
      providerTransactionId,
      outcome: outcome as ProviderWebhookOutcome,
      occurredAt: new Date(occurredAt),
      amount: amountResult.getValue(),
    };
  }

  async reconcileTransaction(providerTransactionId: string): Promise<ProviderTransactionStatus> {
    const record = this.transactions.get(providerTransactionId);
    return record === undefined ? 'NOT_FOUND' : record.status;
  }

  /** Outil de test : construit un corps de webhook VALIDE (signature acceptee par ce fake). */
  buildWebhook(params: {
    providerTransactionId: string;
    outcome: ProviderWebhookOutcome;
    occurredAt: Date;
    amount: Money;
  }): {
    rawBody: string;
    signatureHeader: string;
  } {
    return {
      rawBody: JSON.stringify({
        providerTransactionId: params.providerTransactionId,
        outcome: params.outcome,
        occurredAt: params.occurredAt.toISOString(),
        amount: params.amount.amount,
      }),
      signatureHeader: VALID_SIGNATURE_HEADER,
    };
  }

  /** Outil de test : fixe l'issue "connue du prestataire" pour le rapprochement, sans passer par un webhook. */
  simulateProviderOutcome(providerTransactionId: string, status: ProviderTransactionStatus): void {
    this.transactions.set(providerTransactionId, { status });
  }
}

/** Fake du port `BillingAuditTrail` (ADR-0009 §2.2/§4) — accumule les entrees enregistrees, sans I/O. */
export class InMemoryBillingAuditTrail implements BillingAuditTrail {
  public readonly records: BillingAuditRecordInput[] = [];

  async record(input: BillingAuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

export function mustSucceed<T, E>(result: Result<T, E>): T {
  if (result.isFailure()) {
    throw new Error(`Resultat attendu en succes, obtenu en echec : ${JSON.stringify(result.getError())}`);
  }
  return result.getValue();
}

export function mustFail<T, E>(result: Result<T, E>): E {
  if (result.isSuccess()) {
    throw new Error('Resultat attendu en echec, obtenu en succes.');
  }
  return result.getError();
}
