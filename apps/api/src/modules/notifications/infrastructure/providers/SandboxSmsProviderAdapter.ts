import { randomUUID } from 'node:crypto';
import { NotificationDeliveryError } from '../../domain/NotificationDeliveryError.js';
import type { SmsProvider, SmsSendRequest, SmsSendResult } from '../../domain/ports/SmsProvider.js';
import type { SandboxSentRecord } from './SandboxEmailProviderAdapter.js';

const SANDBOX_SENT_HISTORY_LIMIT = 500;

/**
 * ACL + adaptateur SANDBOX (ADR-0007 §3, residu O-07.3 : "fournisseur SMS"). Aucun declencheur
 * reel n'invoque ce port a cette etape (ADR-0007 §2) — utilise par les tests mecaniques du canal
 * SMS uniquement. Meme forme que `SandboxEmailProviderAdapter.ts`, y compris l'introspection
 * bornee et depersonnalisee (revue de securite etape 9/13, F2).
 */
export class SandboxSmsProviderAdapter implements SmsProvider {
  private readonly sent: SandboxSentRecord[] = [];
  private readonly failureQueue: Array<{ retryable: boolean; message: string }> = [];

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const nextFailure = this.failureQueue.shift();
    if (nextFailure !== undefined) {
      throw new NotificationDeliveryError(nextFailure.message, nextFailure.retryable);
    }
    const providerMessageId = `sandbox-sms-${randomUUID()}`;
    this.sent.push({ idempotencyKey: request.idempotencyKey, providerMessageId });
    if (this.sent.length > SANDBOX_SENT_HISTORY_LIMIT) {
      this.sent.shift();
    }
    return { providerMessageId };
  }

  queueFailure(params: { retryable: boolean; message: string }): void {
    this.failureQueue.push(params);
  }

  sentMessages(): readonly SandboxSentRecord[] {
    return this.sent;
  }
}
