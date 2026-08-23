import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidPasswordHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPasswordHashError';
  }
}

interface PasswordHashProps {
  readonly value: string;
}

/**
 * Hachage d'un mot de passe. Le domaine ne voit et ne manipule **jamais** un mot de passe en
 * clair : le hachage (Argon2id, cout memoire eleve — regle 7.1) est produit par le port
 * `PasswordHasher` en infrastructure/, injecte comme `Clock`/`IdGenerator`. Ce VO se contente
 * de porter la valeur hachee et d'empecher qu'une chaine vide ou triviale y soit stockee par
 * erreur de programmation.
 */
export class PasswordHash extends ValueObject<PasswordHashProps> {
  private constructor(props: PasswordHashProps) {
    super(props);
  }

  static fromHash(value: string): Result<PasswordHash, InvalidPasswordHashError> {
    if (value.trim().length === 0) {
      return Result.failure(new InvalidPasswordHashError('Le hachage de mot de passe est vide.'));
    }
    return Result.success(new PasswordHash({ value }));
  }

  get value(): string {
    return this.props.value;
  }
}
