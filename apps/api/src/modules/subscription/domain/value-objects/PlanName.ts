import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidPlanNameError extends Error {
  constructor(value: string) {
    super(`Nom de forfait invalide : "${value}".`);
    this.name = 'InvalidPlanNameError';
  }
}

interface PlanNameProps {
  readonly value: string;
}

const MAX_LENGTH = 100;

/** Nom affichable du forfait (distinct de `PlanCode`, qui est l'identifiant stable du catalogue). */
export class PlanName extends ValueObject<PlanNameProps> {
  private constructor(props: PlanNameProps) {
    super(props);
  }

  static create(value: string): Result<PlanName, InvalidPlanNameError> {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > MAX_LENGTH) {
      return Result.failure(new InvalidPlanNameError(value));
    }
    return Result.success(new PlanName({ value: normalized }));
  }

  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.props.value;
  }
}
