import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidEncryptedTotpSecretError extends Error {
  constructor(value: string) {
    super(
      `Enveloppe de secret TOTP invalide : "${value}" ne respecte pas le format ` +
        '"v1.<keyId>.<iv>.<tag>.<ciphertext>" (ADR-0005 §2).',
    );
    this.name = 'InvalidEncryptedTotpSecretError';
  }
}

interface EncryptedTotpSecretProps {
  readonly value: string;
}

const ENVELOPE_PATTERN =
  /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * VO OPAQUE de l'enveloppe chiffree du secret TOTP (ADR-0005 §2). Ce VO ne fait QUE valider le
 * FORMAT d'une chaine deja chiffree — il ne chiffre ni ne dechiffre jamais rien lui-meme (regle
 * CI `domain-no-framework` : ni `node:crypto` ni aucune bibliotheque de cryptographie n'est
 * importee ici, l'AES-256-GCM vit exclusivement dans `infrastructure/security/`).
 *
 * Le secret TOTP EN CLAIR ne franchit JAMAIS la frontiere de l'infrastructure : ce VO ne
 * l'expose dans AUCUNE methode `toString()`/`toJSON()` — `toJSON()` est explicitement redige
 * pour ne jamais deverser l'enveloppe dans un `JSON.stringify()` accidentel (log, evenement de
 * domaine serialise vers l'Outbox...). Seul `.value` (acces EXPLICITE, jamais implicite) permet a
 * l'infrastructure de lire l'enveloppe pour la persister ou la dechiffrer.
 */
export class EncryptedTotpSecret extends ValueObject<EncryptedTotpSecretProps> {
  private constructor(props: EncryptedTotpSecretProps) {
    super(props);
  }

  static create(value: string): Result<EncryptedTotpSecret, InvalidEncryptedTotpSecretError> {
    if (!ENVELOPE_PATTERN.test(value)) {
      return Result.failure(new InvalidEncryptedTotpSecretError(value));
    }
    return Result.success(new EncryptedTotpSecret({ value }));
  }

  /** Acces EXPLICITE reserve a l'infrastructure (persistance, dechiffrement) — jamais appele depuis un log applicatif. */
  get value(): string {
    return this.props.value;
  }

  /** Redaction deliberee : ne jamais deverser l'enveloppe dans un JSON.stringify() accidentel. */
  toJSON(): string {
    return '[EncryptedTotpSecret redacted]';
  }
}
