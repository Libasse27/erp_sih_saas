import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidRefreshTokenHashError extends Error {
  constructor(value: string) {
    super(
      `Enveloppe de hash de refresh token invalide : "${value}" ne respecte pas le format ` +
        '"v1.<pepperId>.<hmac>" (ADR-0006 §4).',
    );
    this.name = 'InvalidRefreshTokenHashError';
  }
}

interface RefreshTokenHashProps {
  readonly value: string;
}

const ENVELOPE_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * VO OPAQUE de l'enveloppe HMAC-SHA-256 d'un refresh token (ADR-0006 §4) — calque strict de
 * `RecoveryCodeHash` (meme raisonnement : secret aleatoire haute entropie, HMAC poivre plutot
 * qu'un hachage lent). Ne calcule jamais le HMAC lui-meme (voir `RefreshTokenHasher`, port
 * infrastructure) — valide et transporte uniquement l'enveloppe deja calculee.
 */
export class RefreshTokenHash extends ValueObject<RefreshTokenHashProps> {
  private constructor(props: RefreshTokenHashProps) {
    super(props);
  }

  static create(value: string): Result<RefreshTokenHash, InvalidRefreshTokenHashError> {
    if (value.length === 0 || !ENVELOPE_PATTERN.test(value)) {
      return Result.failure(new InvalidRefreshTokenHashError(value));
    }
    return Result.success(new RefreshTokenHash({ value }));
  }

  get value(): string {
    return this.props.value;
  }

  toJSON(): string {
    return '[RefreshTokenHash redacted]';
  }
}
