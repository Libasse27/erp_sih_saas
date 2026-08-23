import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidRoleIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de role invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidRoleIdError';
  }
}

interface RoleIdProps {
  readonly value: string;
}

/** Identifiant d'un `Role` (systeme ou personnalise par etablissement). */
export class RoleId extends ValueObject<RoleIdProps> {
  private constructor(props: RoleIdProps) {
    super(props);
  }

  static create(value: string): Result<RoleId, InvalidRoleIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidRoleIdError(value));
    }
    return Result.success(new RoleId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
