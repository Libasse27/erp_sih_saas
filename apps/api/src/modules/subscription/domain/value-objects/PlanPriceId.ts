import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPlanPriceIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de tarif de forfait invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidPlanPriceIdError';
  }
}

interface PlanPriceIdProps {
  readonly value: string;
}

/** Identifiant d'un `PlanPrice` (tarif historise, distinct du `Plan` — voir domain/PlanPrice.ts). */
export class PlanPriceId extends ValueObject<PlanPriceIdProps> {
  private constructor(props: PlanPriceIdProps) {
    super(props);
  }

  static create(value: string): Result<PlanPriceId, InvalidPlanPriceIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidPlanPriceIdError(value));
    }
    return Result.success(new PlanPriceId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
