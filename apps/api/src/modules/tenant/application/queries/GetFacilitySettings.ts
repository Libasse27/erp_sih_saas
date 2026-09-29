import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { FacilitySettingsRepository } from '../../domain/ports/FacilitySettingsRepository.js';
import { authorizeTenantConfigAdminister } from '../AuthorizeTenantConfigAdminister.js';
import type { TenantConfigPrincipal } from '../TenantConfigPrincipal.js';

export interface GetFacilitySettingsQuery {
  readonly principal: TenantConfigPrincipal;
}

export type GetFacilitySettingsError = 'FORBIDDEN' | 'FACILITY_SETTINGS_NOT_FOUND';

export interface GetFacilitySettingsResult {
  readonly tenantId: string;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly phoneCountryCode: string;
  readonly createdAt: Date;
}

/**
 * Consultation des parametres regionaux (`FacilitySettings`) du tenant courant — MEME permission
 * `tenant-config:administer` que `GetHealthFacility` (meme module, meme autorisation deja
 * decidee, jamais reimplementee), TOUJOURS "son propre etablissement", jamais un `tenantId` fourni
 * par l'appelant : derive EXCLUSIVEMENT de `principal`.
 *
 * Query PURE (aucun effet de bord, aucune entree d'audit — meme convention que
 * `GetHealthFacility` : seules les MUTATIONS produisent une `AuditEntry`).
 *
 * `unitOfWork.withTransaction(..., { tenantId })` OBLIGATOIRE : `FacilitySettings` est sous RLS
 * FORCE (meme raisonnement que `GetHealthFacility.ts`).
 *
 * `FACILITY_SETTINGS_NOT_FOUND` est defensif : la ligne est semee automatiquement en fin de Saga
 * de provisioning (ADR-0008 §10) — un tenant ADMIN_ETABLISSEMENT authentifie a normalement
 * toujours une ligne, ce cas ne devrait survenir qu'en cours de provisioning ou en incident.
 */
export class GetFacilitySettingsHandler {
  constructor(
    private readonly repository: FacilitySettingsRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    query: GetFacilitySettingsQuery,
  ): Promise<Result<GetFacilitySettingsResult, GetFacilitySettingsError>> {
    const authorization = authorizeTenantConfigAdminister(query.principal);
    if (authorization.isFailure()) {
      return Result.failure('FORBIDDEN');
    }
    const { tenantId } = authorization.getValue();

    const tenantIdResult = TenantId.create(tenantId);
    if (tenantIdResult.isFailure()) {
      // Un TenantConfigPrincipal TENANT est toujours construit par composition-root.ts a partir
      // d'un ServerContext deja valide — un tenantId invalide ici trahit un bug appelant.
      throw new Error(`GetFacilitySettingsHandler : tenantId de principal invalide ("${tenantId}").`);
    }
    const tenantIdVo = tenantIdResult.getValue();

    const settings = await this.unitOfWork.withTransaction(
      () => this.repository.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    if (settings === null) {
      return Result.failure('FACILITY_SETTINGS_NOT_FOUND');
    }

    return Result.success({
      tenantId: settings.tenantId.toString(),
      locale: settings.locale,
      timezone: settings.timezone,
      currency: settings.currency,
      phoneCountryCode: settings.phoneCountryCode,
      createdAt: settings.createdAt,
    });
  }
}
