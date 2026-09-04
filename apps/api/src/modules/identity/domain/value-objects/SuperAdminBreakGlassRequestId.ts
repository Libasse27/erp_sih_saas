import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidSuperAdminBreakGlassRequestIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de requete break-glass invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidSuperAdminBreakGlassRequestIdError';
  }
}

interface SuperAdminBreakGlassRequestIdProps {
  readonly value: string;
}

/** Identifiant de l'agregat `SuperAdminBreakGlassRequest` — calque strict de `MfaEnrollmentId`. */
export class SuperAdminBreakGlassRequestId extends ValueObject<SuperAdminBreakGlassRequestIdProps> {
  private constructor(props: SuperAdminBreakGlassRequestIdProps) {
    super(props);
  }

  static create(value: string): Result<SuperAdminBreakGlassRequestId, InvalidSuperAdminBreakGlassRequestIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidSuperAdminBreakGlassRequestIdError(value));
    }
    return Result.success(new SuperAdminBreakGlassRequestId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
