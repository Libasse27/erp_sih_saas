import { randomUUID } from 'node:crypto';
import { NotificationDeliveryError } from '../../domain/NotificationDeliveryError.js';
import type { EmailProvider, EmailSendRequest, EmailSendResult } from '../../domain/ports/EmailProvider.js';

/** Introspection SANDBOX d'un envoi — DELIBEREMENT SANS `recipient`/`subject`/`body` (revue de securite etape 9/13, F2) : un adaptateur SANDBOX cablable en environnement reel ne doit jamais accumuler de PII non bornee en memoire de processus. `idempotencyKey` (= `Notification.id`) suffit a toute assertion de test. */
export interface SandboxSentRecord {
  readonly idempotencyKey: string;
  readonly providerMessageId: string;
}

const SANDBOX_SENT_HISTORY_LIMIT = 500;

/**
 * ACL + adaptateur SANDBOX (ADR-0007 §3) — AUCUN fournisseur Email reel choisi (voir l'ADR pour
 * la justification : traiter Email symetriquement a SMS plutot que de choisir implicitement un
 * relais SMTP de production). Etat en memoire : meme limite ASSUMEE que
 * `SandboxPaymentProviderAdapter` (ne survit pas a un redemarrage, suffisant pour V1/tests) —
 * mais BORNE (`SANDBOX_SENT_HISTORY_LIMIT`) et DEPERSONNALISE (voir `SandboxSentRecord`).
 */
export class SandboxEmailProviderAdapter implements EmailProvider {
  private readonly sent: SandboxSentRecord[] = [];
  private readonly failureQueue: Array<{ retryable: boolean; message: string }> = [];

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    const nextFailure = this.failureQueue.shift();
    if (nextFailure !== undefined) {
      throw new NotificationDeliveryError(nextFailure.message, nextFailure.retryable);
    }
    const providerMessageId = `sandbox-email-${randomUUID()}`;
    this.sent.push({ idempotencyKey: request.idempotencyKey, providerMessageId });
    if (this.sent.length > SANDBOX_SENT_HISTORY_LIMIT) {
      this.sent.shift();
    }
    return { providerMessageId };
  }

  /** Outil SANDBOX (PAS une methode du port) : simule le PROCHAIN envoi comme un echec — transitoire ou definitif. File FIFO, une entree consommee par envoi. */
  queueFailure(params: { retryable: boolean; message: string }): void {
    this.failureQueue.push(params);
  }

  /** Outil SANDBOX : introspection des envois reussis, pour les tests — jamais le destinataire ni le contenu, voir `SandboxSentRecord`. */
  sentMessages(): readonly SandboxSentRecord[] {
    return this.sent;
  }
}
