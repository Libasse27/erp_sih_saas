import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork, UnitOfWorkContext } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { FacilityNameUnchangedError } from '../../domain/HealthFacility.js';
import type { HealthFacilityRepository } from '../../domain/ports/HealthFacilityRepository.js';
import { FacilityName } from '../../domain/value-objects/FacilityName.js';
import type { FacilityStatus } from '../../domain/value-objects/FacilityStatus.js';
import { authorizeTenantConfigAdminister } from '../AuthorizeTenantConfigAdminister.js';
import type { TenantConfigActorKind, TenantConfigAuditTrail } from '../ports/TenantConfigAuditTrail.js';
import type { TenantConfigPrincipal } from '../TenantConfigPrincipal.js';

export interface RenameHealthFacilityCommand {
  readonly principal: TenantConfigPrincipal;
  readonly newName: string;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

export type RenameHealthFacilityError = 'FORBIDDEN' | 'INVALID_NAME' | 'FACILITY_NOT_FOUND' | 'NAME_UNCHANGED';

export interface RenameHealthFacilityResult {
  readonly tenantId: string;
  readonly name: string;
  readonly status: FacilityStatus;
  readonly createdAt: Date;
}

/**
 * Renomme le `HealthFacility` du tenant courant (Phase 1, premier increment vertical, permission
 * `tenant-config:administer`) — TOUJOURS "son propre etablissement", jamais un `tenantId` fourni
 * par l'appelant (derive EXCLUSIVEMENT de `principal`, voir `TenantConfigPrincipal.ts`).
 *
 * ADR-0005 Amendement 3 (meme convention que `ApproveSuperAdminBreakGlass.ts`, commit `1b9f18e`) :
 * le CONTROLE D'AUTORISATION et son audit `DENIED` s'executent DANS `unitOfWork.withTransaction`,
 * jamais avant — un `Result.failure` ne leve jamais d'exception, l'entree d'audit committe meme
 * quand la commande echoue globalement. Succes ET refus produisent TOUS une entree d'audit.
 *
 * Session `PLATFORM` : refusee EXPLICITEMENT (voir `authorizeTenantConfigAdminister`), jamais un
 * fallthrough — `tenant-config:administer` est portee exclusivement par un role TENANT. Le
 * contexte transactionnel n'inclut alors AUCUN `tenantId` (meme discipline que
 * `RequestSuperAdminBreakGlass.ts`) : cette branche n'accede jamais a une table tenant-scopee,
 * seule l'ecriture d'audit (hors RLS, schema `platform`) s'y produit.
 */
export class RenameHealthFacilityHandler {
  constructor(
    private readonly repository: HealthFacilityRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly tenantConfigAuditTrail: TenantConfigAuditTrail,
  ) {}

  async execute(command: RenameHealthFacilityCommand): Promise<Result<RenameHealthFacilityResult, RenameHealthFacilityError>> {
    const principal = command.principal;
    const actorKind: TenantConfigActorKind = principal.kind === 'TENANT' ? 'USER_TENANT' : 'USER_PLATFORM';
    const actorRoleCodes = principal.kind === 'TENANT' ? principal.roleCodes : [];

    let context: UnitOfWorkContext | undefined;
    if (principal.kind === 'TENANT') {
      const tenantIdResult = TenantId.create(principal.tenantId);
      if (tenantIdResult.isFailure()) {
        // Un TenantConfigPrincipal TENANT est toujours construit par composition-root.ts a partir
        // d'un ServerContext deja valide — un tenantId invalide ici trahit un bug appelant.
        throw new Error(`RenameHealthFacilityHandler : tenantId de principal invalide ("${principal.tenantId}").`);
      }
      context = { tenantId: tenantIdResult.getValue(), actorUserId: principal.actorUserId };
    }

    return this.unitOfWork.withTransaction(async (): Promise<Result<RenameHealthFacilityResult, RenameHealthFacilityError>> => {
      // Autorisation verifiee DANS la transaction (ADR-0005 Amendement 3) — AVANT toute lecture de
      // l'agregat, jamais apres.
      const authorization = authorizeTenantConfigAdminister(principal);
      if (authorization.isFailure()) {
        await this.audit({
          outcome: 'DENIED',
          tenantId: principal.kind === 'TENANT' ? principal.tenantId : null,
          actorKind,
          actorUserId: principal.actorUserId,
          actorRoleCodes,
          sessionId: command.sessionId,
          correlationId: command.correlationId,
        });
        return Result.failure('FORBIDDEN');
      }
      const { tenantId, actorUserId } = authorization.getValue();
      const tenantIdVo = TenantId.create(tenantId).getValue();

      const nameResult = FacilityName.create(command.newName);
      if (nameResult.isFailure()) {
        await this.audit({
          outcome: 'FAILURE',
          tenantId,
          actorKind,
          actorUserId,
          actorRoleCodes,
          sessionId: command.sessionId,
          correlationId: command.correlationId,
        });
        return Result.failure('INVALID_NAME');
      }
      const newName = nameResult.getValue();

      const facility = await this.repository.findByTenantId(tenantIdVo);
      if (facility === null) {
        // Defensif : une session TENANT deja resolue implique normalement un HealthFacility
        // existant (meme raisonnement qu'ENROLLMENT_NOT_FOUND, ApproveSuperAdminBreakGlass.ts) —
        // FAILURE, pas DENIED (ce n'est pas un refus d'autorisation).
        await this.audit({
          outcome: 'FAILURE',
          tenantId,
          actorKind,
          actorUserId,
          actorRoleCodes,
          sessionId: command.sessionId,
          correlationId: command.correlationId,
        });
        return Result.failure('FACILITY_NOT_FOUND');
      }

      const renameResult = facility.rename(newName, this.clock, this.idGenerator);
      if (renameResult.isFailure()) {
        if (!(renameResult.getError() instanceof FacilityNameUnchangedError)) {
          // Union fermee a une seule erreur nommee aujourd'hui (voir HealthFacility.rename()) —
          // toute autre valeur trahirait une divergence non geree entre le domaine et ce handler.
          throw renameResult.getError();
        }
        await this.audit({
          outcome: 'FAILURE',
          tenantId,
          actorKind,
          actorUserId,
          actorRoleCodes,
          sessionId: command.sessionId,
          correlationId: command.correlationId,
        });
        return Result.failure('NAME_UNCHANGED');
      }

      await this.repository.save(facility, tenantIdVo);
      await this.audit({
        outcome: 'SUCCESS',
        tenantId,
        actorKind,
        actorUserId,
        actorRoleCodes,
        sessionId: command.sessionId,
        correlationId: command.correlationId,
      });

      return Result.success({
        tenantId,
        name: facility.name.value,
        status: facility.status,
        createdAt: facility.createdAt,
      });
    }, context);
  }

  private async audit(params: {
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
    tenantId: string | null;
    actorKind: TenantConfigActorKind;
    actorUserId: string;
    actorRoleCodes: readonly string[];
    sessionId: string | null;
    correlationId: string | null;
  }): Promise<void> {
    await this.tenantConfigAuditTrail.record({
      eventType: 'TENANT_CONFIG_FACILITY_RENAMED',
      outcome: params.outcome,
      tenantId: params.tenantId,
      actorKind: params.actorKind,
      actorUserId: params.actorUserId,
      actorRoleCodes: params.actorRoleCodes,
      // La cible EST le tenant lui-meme (`HealthFacility.id === tenantId`, voir HealthFacility.ts).
      targetId: params.tenantId,
      reason: null,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
    });
  }
}
