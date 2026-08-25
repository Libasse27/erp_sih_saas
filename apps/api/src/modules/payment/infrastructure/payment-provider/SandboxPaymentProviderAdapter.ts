import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import type {
  InitiatePaymentRequest,
  InitiatePaymentResult,
  PaymentProvider,
  ProviderTransactionStatus,
  ProviderWebhookEvent,
  ProviderWebhookOutcome,
} from '../../domain/ports/PaymentProvider.js';

const SIGNATURE_HEADER_PREFIX = 'sha256=';

/** Seule devise geree par ce sandbox (Money est mono-XOF, §"exigences transverses") — un webhook qui pretend porter une autre devise est un payload illisible pour cette ACL, pas un desaccord metier reel. */
const SANDBOX_CURRENCY = 'XOF';

interface SandboxTransactionRecord {
  status: ProviderTransactionStatus;
  /**
   * Montant retenu a `initiatePayment()` — un prestataire reel memorise necessairement le montant
   * de la transaction qu'il a lui-meme initiee. `buildSignedWebhookPayload()` (outil de test)
   * recoit son propre `amount` explicite plutot que de relire ce champ : c'est le TEST qui simule
   * ce que le prestataire notifierait, y compris dans les scenarios adversariaux ou ce montant
   * doit volontairement DIFFERER de celui initie (voir ConfirmPayment.test.ts, cas
   * AMOUNT_MISMATCH). Ce champ reste neanmoins memorise ici par coherence avec le contrat du port
   * (un futur adaptateur reel n'aurait pas le choix).
   */
  amount: Money;
}

/**
 * ACL + adaptateur SANDBOX (O-25.3 : port `PaymentProvider` + "sandbox" explicitement exige par
 * les contraintes du port) — PAS un simple stub de test : simule un flux Mobile Money/carte
 * realiste (initiation -> webhook signe HMAC-SHA256 -> rapprochement periodique), utilisable en
 * V1 tant qu'aucun prestataire reel n'est retenu (residu O-25 : "fournisseur de paiement SaaS").
 *
 * Traduit un format de payload PROPRE A CE FAUX FOURNISSEUR (`{ transactionId, event,
 * occurredAt, amount, currency }`, choisi arbitrairement pour ce sandbox) vers le contrat neutre
 * `ProviderWebhookEvent` du domaine — AUCUN de ces noms de champs ne doit jamais apparaitre en
 * dehors de ce fichier (Anti-Corruption Layer, D10, 01-target-architecture.md §6.3 :
 * "aucun fournisseur code en dur dans le domaine"). `currency` n'introduit AUCUN concept
 * multi-devise reel (Money reste mono-XOF) : c'est un simple champ de payload valide contre
 * `SANDBOX_CURRENCY`, au meme titre qu'un autre champ potentiellement corrompu.
 *
 * Etat en memoire (`Map`) : limite ASSUMEE d'un sandbox local — ne survit pas a un redemarrage du
 * processus, contrairement a l'API d'un prestataire reel. Suffisant pour ce V1 et pour les tests
 * d'integration (meme processus, meme instance partagee via composition-root.ts).
 */
export class SandboxPaymentProviderAdapter implements PaymentProvider {
  private readonly transactions = new Map<string, SandboxTransactionRecord>();

  constructor(private readonly webhookSecret: string) {}

  async initiatePayment(request: InitiatePaymentRequest): Promise<InitiatePaymentResult> {
    // Le sandbox ne differencie pas encore son comportement par methode/tenant (aucun
    // prestataire reel choisi, O-25.3) — seul `request.amount` est retenu (voir
    // `SandboxTransactionRecord`), pour que le webhook simule ulterieurement porte le meme
    // montant que celui reellement initie, comme le ferait un prestataire reel.
    const providerTransactionId = `sandbox_${randomUUID()}`;
    this.transactions.set(providerTransactionId, { status: 'PENDING', amount: request.amount });
    return {
      providerTransactionId,
      redirectUrl: `https://sandbox.payment.invalid/checkout/${providerTransactionId}`,
    };
  }

  verifyWebhookSignature(params: { rawBody: string; signatureHeader: string | undefined }): boolean {
    if (params.signatureHeader === undefined || params.signatureHeader.length === 0) {
      return false;
    }
    if (!params.signatureHeader.startsWith(SIGNATURE_HEADER_PREFIX)) {
      return false;
    }
    const providedHex = params.signatureHeader.slice(SIGNATURE_HEADER_PREFIX.length);
    const expectedHex = this.sign(params.rawBody);

    let providedBuffer: Buffer;
    let expectedBuffer: Buffer;
    try {
      providedBuffer = Buffer.from(providedHex, 'hex');
      expectedBuffer = Buffer.from(expectedHex, 'hex');
    } catch {
      return false;
    }
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
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
    const transactionId = record.transactionId;
    const eventName = record.event;
    const occurredAtRaw = record.occurredAt;
    const amountRaw = record.amount;
    const currencyRaw = record.currency;
    if (typeof transactionId !== 'string' || typeof eventName !== 'string' || typeof occurredAtRaw !== 'string') {
      return null;
    }
    const outcome: ProviderWebhookOutcome | null =
      eventName === 'payment.succeeded' ? 'SUCCEEDED' : eventName === 'payment.failed' ? 'FAILED' : null;
    if (outcome === null) {
      return null;
    }
    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.getTime())) {
      return null;
    }
    // `currency` doit etre EXACTEMENT 'XOF' (Money est mono-devise, voir SANDBOX_CURRENCY
    // ci-dessus) — toute autre valeur rend ce payload illisible pour cette ACL, au meme titre
    // qu'un champ absent ou mal type (pas un nouveau code d'erreur : voie INVALID_PAYLOAD
    // existante de ConfirmPayment.ts).
    if (typeof amountRaw !== 'number' || currencyRaw !== SANDBOX_CURRENCY) {
      return null;
    }
    const amountResult = Money.fromXOF(amountRaw);
    if (amountResult.isFailure()) {
      return null;
    }
    const amount = amountResult.getValue();

    // Simule le fait que le PRESTATAIRE connait deja cette issue (c'est lui qui a genere ce
    // webhook) : suffisant pour qu'un rapprochement ulterieur sur le meme providerTransactionId
    // retrouve la meme verite, sans etat externe reel.
    const existing = this.transactions.get(transactionId);
    if (existing !== undefined) {
      existing.status = outcome;
    }

    return { providerTransactionId: transactionId, outcome, occurredAt, amount };
  }

  async reconcileTransaction(providerTransactionId: string): Promise<ProviderTransactionStatus> {
    const record = this.transactions.get(providerTransactionId);
    return record === undefined ? 'NOT_FOUND' : record.status;
  }

  /**
   * Outil SANDBOX (PAS une methode du port `PaymentProvider`) : construit un webhook SIGNE comme
   * le ferait le prestataire reel. Utilise par les tests d'integration adversariaux (simuler une
   * confirmation entrante) et reutilisable comme outil de developpement local. N'est jamais
   * importe en dehors de infrastructure/ (les tests l'importent directement depuis ce fichier,
   * pas via le port `PaymentProvider`).
   */
  buildSignedWebhookPayload(params: {
    providerTransactionId: string;
    outcome: ProviderWebhookOutcome;
    occurredAt: Date;
    amount: Money;
  }): { rawBody: string; signatureHeader: string } {
    const rawBody = JSON.stringify({
      transactionId: params.providerTransactionId,
      event: params.outcome === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed',
      occurredAt: params.occurredAt.toISOString(),
      amount: params.amount.amount,
      currency: params.amount.currency,
    });
    return { rawBody, signatureHeader: `${SIGNATURE_HEADER_PREFIX}${this.sign(rawBody)}` };
  }

  /**
   * Outil SANDBOX : fixe directement l'issue connue du prestataire pour un `providerTransactionId`
   * SANS emettre de webhook — simule un rapprochement qui rattrape une confirmation dont le
   * webhook a ete perdu (voir test adversarial "absence totale de webhook"). Ne prend PAS de
   * montant en parametre : `reconcileTransaction()` renvoie un `ProviderTransactionStatus` qui ne
   * porte de toute facon aucun montant (voir residu documente dans ConfirmPayment.ts) — le champ
   * `amount` de l'enregistrement existant, s'il y en a un, est preserve tel quel ; a defaut (aucun
   * `initiatePayment()` prealable pour ce `providerTransactionId`), `Money.zero()` est une valeur
   * de remplissage sans consequence, jamais lue par un appelant reel.
   */
  simulateProviderOutcome(providerTransactionId: string, status: ProviderTransactionStatus): void {
    const existing = this.transactions.get(providerTransactionId);
    this.transactions.set(providerTransactionId, { status, amount: existing?.amount ?? Money.zero() });
  }

  private sign(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }
}
