import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { FacilitySettings } from '../../domain/FacilitySettings.js';
import type { FacilitySettingsRepository } from '../../domain/ports/FacilitySettingsRepository.js';

export interface SeedFacilityConfigurationCommand {
  readonly tenantId: string;
}

export type SeedFacilityConfigurationError = 'INVALID_TENANT_ID' | 'FACILITY_SETTINGS_ALREADY_EXISTS';

export interface SeedFacilityConfigurationResult {
  readonly facilitySettingsId: string;
}

/**
 * Seme la configuration technique minimale d'un tenant (ADR-0008 §10, amendement 1, Phase 0
 * etape 10/13) — troisieme etape chorographiee de la Saga de provisioning, declenchee par
 * `MembershipGranted` (voir application/services/SeedFacilityConfigurationOnMembershipGranted.ts).
 *
 * Idempotent au meme idiome que `StartTrialSubscriptionHandler` : une ligne deja presente pour ce
 * tenant renvoie `FACILITY_SETTINGS_ALREADY_EXISTS` (Result.failure METIER, jamais une exception)
 * — le consommateur Outbox appelant traite ce cas comme une etape deja realisee (ADR-0008 §5,
 * retry-jusqu'a-completion).
 */
export class SeedFacilityConfigurationHandler {
  constructor(
    private readonly repository: FacilitySettingsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: SeedFacilityConfigurationCommand,
  ): Promise<Result<SeedFacilityConfigurationResult, SeedFacilityConfigurationError>> {
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const tenantId = tenantIdResult.getValue();

    return this.unitOfWork.withTransaction(
      async () => {
        const existing = await this.repository.findByTenantId(tenantId);
        if (existing !== null) {
          return Result.failure('FACILITY_SETTINGS_ALREADY_EXISTS');
        }

        const settings = FacilitySettings.create({ tenantId, clock: this.clock, idGenerator: this.idGenerator });
        await this.repository.save(settings, tenantId);

        return Result.success({ facilitySettingsId: settings.id.toString() });
      },
      { tenantId },
    );
  }
}
