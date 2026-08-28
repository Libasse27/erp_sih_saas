import { createHmac } from 'node:crypto';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import type { RefreshTokenHasher } from '../../domain/ports/RefreshTokenHasher.js';
import { RefreshTokenHash } from '../../domain/value-objects/RefreshTokenHash.js';

/**
 * Implementation `RefreshTokenHasher` (ADR-0006 §4) : `HMAC-SHA-256(pepper, raw)`, enveloppe
 * `v1.<pepperId>.<hmac base64url>` — calque strict de `HmacRecoveryCodeHasher` (meme
 * raisonnement : secret aleatoire haute entropie, HMAC poivre plutot qu'un hachage lent).
 */
export class HmacRefreshTokenHasher implements RefreshTokenHasher {
  constructor(
    private readonly pepper: string,
    private readonly pepperId: string,
  ) {}

  hash(rawToken: string): RefreshTokenHash {
    const digest = createHmac('sha256', this.pepper).update(rawToken, 'utf8').digest('base64url');
    return assertValid(RefreshTokenHash.create(`v1.${this.pepperId}.${digest}`));
  }
}
