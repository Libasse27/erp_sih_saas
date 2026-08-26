import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidMfaRecoveryCodeIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de code de recuperation MFA invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidMfaRecoveryCodeIdError';
  }
}

interface MfaRecoveryCodeIdProps {
  readonly value: string;
}

/** Identifiant de l'entite interne `MfaRecoveryCode` — calque strict de `UserAccountId`. */
export class MfaRecoveryCodeId extends ValueObject<MfaRecoveryCodeIdProps> {
  private constructor(props: MfaRecoveryCodeIdProps) {
    super(props);
  }

  static create(value: string): Result<MfaRecoveryCodeId, InvalidMfaRecoveryCodeIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidMfaRecoveryCodeIdError(value));
    }
    return Result.success(new MfaRecoveryCodeId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
