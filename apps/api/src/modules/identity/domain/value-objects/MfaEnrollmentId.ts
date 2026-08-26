import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidMfaEnrollmentIdError extends Error {
  constructor(value: string) {
    super(`Identifiant d'enrolement MFA invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidMfaEnrollmentIdError';
  }
}

interface MfaEnrollmentIdProps {
  readonly value: string;
}

/** Identifiant de l'agregat `MfaEnrollment` — calque strict de `UserAccountId` (voir ce fichier). */
export class MfaEnrollmentId extends ValueObject<MfaEnrollmentIdProps> {
  private constructor(props: MfaEnrollmentIdProps) {
    super(props);
  }

  static create(value: string): Result<MfaEnrollmentId, InvalidMfaEnrollmentIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidMfaEnrollmentIdError(value));
    }
    return Result.success(new MfaEnrollmentId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
