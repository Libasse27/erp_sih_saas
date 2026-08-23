import { Result } from '../Result.js';
import { ValueObject } from '../ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de tenant invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidTenantIdError';
  }
}

interface TenantIdProps {
  readonly value: string;
}

/**
 * Identifiant de tenant (etablissement). Value Object obligatoire dans chaque Command,
 * Query et signature de repository (ADR-0001, defense en profondeur couche 2) — jamais
 * une simple string, pour rendre un oubli de filtrage tenant detectable a la compilation.
 */
export class TenantId extends ValueObject<TenantIdProps> {
  private constructor(props: TenantIdProps) {
    super(props);
  }

  static create(value: string): Result<TenantId, InvalidTenantIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidTenantIdError(value));
    }
    return Result.success(new TenantId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
