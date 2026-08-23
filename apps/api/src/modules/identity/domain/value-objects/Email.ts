import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidEmailError extends Error {
  constructor(value: string) {
    super(`Adresse email invalide : "${value}".`);
    this.name = 'InvalidEmailError';
  }
}

interface EmailProps {
  readonly value: string;
}

// Volontairement simple (RFC 5322 complete non necessaire ici) : la verification forte se
// fait par l'envoi effectif d'un email, pas par un regex exhaustif.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Adresse email d'un `UserAccount`. Normalisee en minuscules pour que l'unicite (niveau
 * plateforme, cle de recherche au login) ne depende jamais de la casse saisie par l'utilisateur.
 */
export class Email extends ValueObject<EmailProps> {
  private constructor(props: EmailProps) {
    super(props);
  }

  static create(value: string): Result<Email, InvalidEmailError> {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
      return Result.failure(new InvalidEmailError(value));
    }
    return Result.success(new Email({ value: normalized }));
  }

  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.props.value;
  }
}
