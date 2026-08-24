import { Result } from '../../../../shared-kernel/domain/Result.js';
import { ValueObject } from '../../../../shared-kernel/domain/ValueObject.js';

export class InvalidPlanLimitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanLimitsError';
  }
}

interface PlanLimitsProps {
  readonly maxUsers: number;
  readonly maxBeds: number;
}

/**
 * Limites en donnees portees par un `Plan` (O-02.3, reliquat clos le 2026-08-24 —
 * 03-open-decisions.md O-02). Seules deux limites existent en V1, aucune autre ressource n'est
 * plafonnee (pas de `maxPatients`, `maxConsultations`, `maxStorage`...) — ne pas etendre cette
 * liste sans une nouvelle decision explicite.
 *
 * `maxBeds` existe des cette etape (donnee du `Plan`) mais sa verification effective attend le
 * futur module Building/Room/Bed (hors perimetre avant Phase 4) — voir
 * `application/services/CheckUsersQuota.ts`, qui ne verifie que `maxUsers`.
 */
export class PlanLimits extends ValueObject<PlanLimitsProps> {
  private constructor(props: PlanLimitsProps) {
    super(props);
  }

  static create(maxUsers: number, maxBeds: number): Result<PlanLimits, InvalidPlanLimitsError> {
    if (!Number.isInteger(maxUsers) || maxUsers <= 0) {
      return Result.failure(
        new InvalidPlanLimitsError(`maxUsers doit etre un entier strictement positif, reçu : ${maxUsers}.`),
      );
    }
    if (!Number.isInteger(maxBeds) || maxBeds <= 0) {
      return Result.failure(
        new InvalidPlanLimitsError(`maxBeds doit etre un entier strictement positif, reçu : ${maxBeds}.`),
      );
    }
    return Result.success(new PlanLimits({ maxUsers, maxBeds }));
  }

  get maxUsers(): number {
    return this.props.maxUsers;
  }

  get maxBeds(): number {
    return this.props.maxBeds;
  }
}
