import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidTenantAdminRecoveryRequestIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de récupération d'accès invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidTenantAdminRecoveryRequestIdError';
  }
}

interface TenantAdminRecoveryRequestIdProps {
  readonly value: string;
}

export class TenantAdminRecoveryRequestId extends ValueObject<TenantAdminRecoveryRequestIdProps> {
  private constructor(props: TenantAdminRecoveryRequestIdProps) {
    super(props);
  }

  static create(value: string): Result<TenantAdminRecoveryRequestId, InvalidTenantAdminRecoveryRequestIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidTenantAdminRecoveryRequestIdError(value));
    }
    return Result.success(new TenantAdminRecoveryRequestId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
