import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPlanIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de forfait invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidPlanIdError';
  }
}

interface PlanIdProps {
  readonly value: string;
}

/** Identifiant d'un `Plan` (catalogue de forfaits, niveau plateforme — voir domain/Plan.ts). */
export class PlanId extends ValueObject<PlanIdProps> {
  private constructor(props: PlanIdProps) {
    super(props);
  }

  static create(value: string): Result<PlanId, InvalidPlanIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidPlanIdError(value));
    }
    return Result.success(new PlanId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
