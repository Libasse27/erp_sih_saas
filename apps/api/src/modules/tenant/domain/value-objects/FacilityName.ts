import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidFacilityNameError extends Error {
  constructor(value: string) {
    super(`Raison sociale d'etablissement invalide : "${value}".`);
    this.name = 'InvalidFacilityNameError';
  }
}

interface FacilityNameProps {
  readonly value: string;
}

const MAX_LENGTH = 200;

/**
 * Raison sociale de l'etablissement (`HealthFacility`). Validation volontairement minimale
 * (non vide, longueur raisonnable) — aucune regle metier de nommage (forme juridique, prefixe
 * "Hopital"/"Clinique"...) n'est inventee ici, cf. regle d'escalade du system prompt.
 */
export class FacilityName extends ValueObject<FacilityNameProps> {
  private constructor(props: FacilityNameProps) {
    super(props);
  }

  static create(value: string): Result<FacilityName, InvalidFacilityNameError> {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > MAX_LENGTH) {
      return Result.failure(new InvalidFacilityNameError(value));
    }
    return Result.success(new FacilityName({ value: normalized }));
  }

  get value(): string {
    return this.props.value;
  }

  override toString(): string {
    return this.props.value;
  }
}
