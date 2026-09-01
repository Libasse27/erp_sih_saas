import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { FacilitySettingsRepository } from '../../domain/ports/FacilitySettingsRepository.js';
import type { ProvisioningAuditTrail } from '../ports/ProvisioningAuditTrail.js';

export type CompleteProvisioningError =
  | 'INVALID_TENANT_ID'
  | 'FACILITY_SETTINGS_NOT_FOUND'
  | 'PROVISIONING_ALREADY_COMPLETED';

export interface CompleteProvisioningCommand {
  readonly tenantId: string;
}

export interface CompleteProvisioningResult {
  readonly facilitySettingsId: string;
}

/**
 * Derniere etape chorographiee de la Saga de provisioning (ADR-0008 §11, amendement 1, Phase 0
 * etape 10/13) — emet `ProvisioningCompleted` (signal de cloture backend minimal, AUCUNE machine
 * a etats metier, voir `domain/events/ProvisioningCompleted.ts`). Declenchee par
 * `FacilityConfigurationSeeded` (voir
 * application/services/CompleteProvisioningOnFacilityConfigurationSeeded.ts).
 *
 * `FACILITY_SETTINGS_NOT_FOUND` est une ANOMALIE REELLE (l'etape precedente de la Saga n'a pas
 * encore ete rejouee par l'Outbox, ou n'a jamais persiste) — le consommateur Outbox appelant doit
 * la traiter comme un ECHEC (message laisse `PENDING`, retente au cycle suivant, ADR-0008 §5),
 * jamais comme un succes silencieux. `PROVISIONING_ALREADY_COMPLETED` est au contraire le meme
 * idiome d'idempotence que `MEMBERSHIP_ALREADY_EXISTS`/`SUBSCRIPTION_ALREADY_EXISTS` : un rejeu
 * de cette etape est un succes du point de vue de la Saga.
 */
export class CompleteProvisioningHandler {
  constructor(
    private readonly repository: FacilitySettingsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly provisioningAuditTrail: ProvisioningAuditTrail,
  ) {}

  async execute(
    command: CompleteProvisioningCommand,
  ): Promise<Result<CompleteProvisioningResult, CompleteProvisioningError>> {
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const tenantId = tenantIdResult.getValue();

    return this.unitOfWork.withTransaction(
      async () => {
        const settings = await this.repository.findByTenantId(tenantId);
        if (settings === null) {
          return Result.failure('FACILITY_SETTINGS_NOT_FOUND');
        }

        const completion = settings.completeProvisioning(this.clock, this.idGenerator);
        if (completion.isFailure()) {
          return Result.failure('PROVISIONING_ALREADY_COMPLETED');
        }

        await this.repository.save(settings, tenantId);

        await this.provisioningAuditTrail.record({
          eventType: 'PROVISIONING_COMPLETED',
          outcome: 'SUCCESS',
          tenantId: tenantId.toString(),
          actorKind: 'SYSTEM',
          actorUserId: null,
          subjectUserId: null,
          targetType: 'HEALTH_FACILITY',
          targetId: tenantId.toString(),
          reason: null,
          sessionId: null,
          correlationId: null,
        });

        return Result.success({ facilitySettingsId: settings.id.toString() });
      },
      { tenantId },
    );
  }
}
