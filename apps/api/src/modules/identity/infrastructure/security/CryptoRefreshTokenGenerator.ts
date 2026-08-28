import { randomBytes } from 'node:crypto';
import type { RefreshTokenGenerator } from '../../domain/ports/RefreshTokenGenerator.js';

const SECRET_BYTES = 32; // 256 bits — meme famille d'entropie que les codes de recuperation (ADR-0006 §4).

/** Implementation `RefreshTokenGenerator` (ADR-0006 §4) : `crypto.randomBytes(32)`, encodage base64url. */
export class CryptoRefreshTokenGenerator implements RefreshTokenGenerator {
  generate(): string {
    return randomBytes(SECRET_BYTES).toString('base64url');
  }
}
