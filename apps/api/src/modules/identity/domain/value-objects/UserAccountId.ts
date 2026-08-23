import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidUserAccountIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de compte utilisateur invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidUserAccountIdError';
  }
}

interface UserAccountIdProps {
  readonly value: string;
}

/**
 * Identifiant d'un `UserAccount` (identite globale, niveau plateforme — voir UserAccount.ts).
 * VO plutot qu'une string nue, meme regle que `TenantId` : rendre un oubli de filtrage ou
 * une confusion d'identifiant detectable a la compilation.
 */
export class UserAccountId extends ValueObject<UserAccountIdProps> {
  private constructor(props: UserAccountIdProps) {
    super(props);
  }

  static create(value: string): Result<UserAccountId, InvalidUserAccountIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidUserAccountIdError(value));
    }
    return Result.success(new UserAccountId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
