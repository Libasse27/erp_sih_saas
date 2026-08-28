import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidRefreshTokenIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de refresh token invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidRefreshTokenIdError';
  }
}

interface RefreshTokenIdProps {
  readonly value: string;
}

/** Identifiant d'une ligne `RefreshToken` — calque strict de `MfaEnrollmentId` (voir ce fichier). */
export class RefreshTokenId extends ValueObject<RefreshTokenIdProps> {
  private constructor(props: RefreshTokenIdProps) {
    super(props);
  }

  static create(value: string): Result<RefreshTokenId, InvalidRefreshTokenIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidRefreshTokenIdError(value));
    }
    return Result.success(new RefreshTokenId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
