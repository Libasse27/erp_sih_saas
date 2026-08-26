import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidRecoveryCodeHashError extends Error {
  constructor(value: string) {
    super(
      `Enveloppe de hash de code de recuperation invalide : "${value}" ne respecte pas le format ` +
        '"v1.<pepperId>.<hmac>" (ADR-0005 §3).',
    );
    this.name = 'InvalidRecoveryCodeHashError';
  }
}

interface RecoveryCodeHashProps {
  readonly value: string;
}

const ENVELOPE_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * VO OPAQUE de l'enveloppe HMAC-SHA-256 d'un code de recuperation (ADR-0005 §3). Refuse une
 * chaine vide (et plus generalement tout ce qui ne respecte pas le format `v1.<pepperId>.<hmac>`).
 * Ce VO ne calcule jamais le HMAC lui-meme (voir `RecoveryCodeHasher`, port infrastructure) — il
 * ne fait que valider et transporter l'enveloppe deja calculee.
 *
 * Le condensat n'est pas un secret en clair, mais reste traite avec la meme discipline anti-fuite
 * que `EncryptedTotpSecret` : aucune exposition via `toJSON()`.
 */
export class RecoveryCodeHash extends ValueObject<RecoveryCodeHashProps> {
  private constructor(props: RecoveryCodeHashProps) {
    super(props);
  }

  static create(value: string): Result<RecoveryCodeHash, InvalidRecoveryCodeHashError> {
    if (value.length === 0 || !ENVELOPE_PATTERN.test(value)) {
      return Result.failure(new InvalidRecoveryCodeHashError(value));
    }
    return Result.success(new RecoveryCodeHash({ value }));
  }

  get value(): string {
    return this.props.value;
  }

  toJSON(): string {
    return '[RecoveryCodeHash redacted]';
  }
}
