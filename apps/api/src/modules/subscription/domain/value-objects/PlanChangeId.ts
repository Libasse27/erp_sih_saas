import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidPlanChangeIdError extends Error {
  constructor(value: string) {
    super(`Identifiant de changement de forfait invalide : "${value}" n'est pas un UUID v4.`);
    this.name = 'InvalidPlanChangeIdError';
  }
}

interface PlanChangeIdProps {
  readonly value: string;
}

/** Identifiant d'un `PlanChange` (ligne d'historique append-only — voir domain/PlanChange.ts). */
export class PlanChangeId extends ValueObject<PlanChangeIdProps> {
  private constructor(props: PlanChangeIdProps) {
    super(props);
  }

  static create(value: string): Result<PlanChangeId, InvalidPlanChangeIdError> {
    if (!UUID_V4_PATTERN.test(value)) {
      return Result.failure(new InvalidPlanChangeIdError(value));
    }
    return Result.success(new PlanChangeId({ value: value.toLowerCase() }));
  }

  override toString(): string {
    return this.props.value;
  }
}
