import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { HealthFacilityRepository } from '../../domain/ports/HealthFacilityRepository.js';
import type { FacilityStatus } from '../../domain/value-objects/FacilityStatus.js';
import { authorizeTenantConfigAdminister } from '../AuthorizeTenantConfigAdminister.js';
import type { TenantConfigPrincipal } from '../TenantConfigPrincipal.js';

export interface GetHealthFacilityQuery {
  readonly principal: TenantConfigPrincipal;
}

export type GetHealthFacilityError = 'FORBIDDEN' | 'FACILITY_NOT_FOUND';

export interface GetHealthFacilityResult {
  readonly tenantId: string;
  readonly name: string;
  readonly status: FacilityStatus;
  readonly createdAt: Date;
}

/**
 * Consultation de l'identite du `HealthFacility` du tenant courant (Phase 1, premier increment
 * vertical, permission `tenant-config:administer`) — TOUJOURS "son propre etablissement", jamais
 * un `tenantId` fourni par l'appelant : derive EXCLUSIVEMENT de `principal` (deja resolu depuis le
 * `ServerContext` serveur, voir `TenantConfigPrincipal.ts`/`composition-root.ts`).
 *
 * Query PURE (aucun effet de bord, aucune entree d'audit — convention deja en place dans ce
 * depot : seules les MUTATIONS produisent une `AuditEntry`, exception faite de la consultation du
 * journal d'audit lui-meme, categorie `AUDIT_ACCESS`, ADR-0009 §7, qui ne s'applique pas ici).
 *
 * `unitOfWork.withTransaction(..., { tenantId })` est OBLIGATOIRE ici (pas seulement pour une
 * commande) : `HealthFacility` est sous RLS FORCE (schema `public`) — sans transaction positionnant
 * `app.tenant_id`, `PrismaHealthFacilityRepository` retombe sur le client Prisma de base (voir
 * `resolvePrismaClient`) et ne verrait AUCUNE ligne (meme discipline que `resolveAccess()` dans
 * test/tenant/integration/provisioningSaga.test.ts).
 */
export class GetHealthFacilityHandler {
  constructor(
    private readonly repository: HealthFacilityRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(query: GetHealthFacilityQuery): Promise<Result<GetHealthFacilityResult, GetHealthFacilityError>> {
    const authorization = authorizeTenantConfigAdminister(query.principal);
    if (authorization.isFailure()) {
      return Result.failure('FORBIDDEN');
    }
    const { tenantId } = authorization.getValue();

    const tenantIdResult = TenantId.create(tenantId);
    if (tenantIdResult.isFailure()) {
      // Un TenantConfigPrincipal TENANT est toujours construit par composition-root.ts a partir
      // d'un ServerContext deja valide — un tenantId invalide ici trahit un bug appelant.
      throw new Error(`GetHealthFacilityHandler : tenantId de principal invalide ("${tenantId}").`);
    }
    const tenantIdVo = tenantIdResult.getValue();

    const facility = await this.unitOfWork.withTransaction(
      () => this.repository.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    if (facility === null) {
      return Result.failure('FACILITY_NOT_FOUND');
    }

    return Result.success({
      tenantId: facility.id.toString(),
      name: facility.name.value,
      status: facility.status,
      createdAt: facility.createdAt,
    });
  }
}
