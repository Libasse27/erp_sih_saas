import { Result } from '../../../../shared-kernel/domain/Result.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlanRepository } from '../../domain/ports/PlanRepository.js';
import type { SubscriptionRepository } from '../../domain/ports/SubscriptionRepository.js';

export interface CheckUsersQuotaQuery {
  readonly tenantId: string;
  /**
   * Nombre de `UserTenantMembership` ACTIFS pour ce tenant (O-05 : jamais les roles, jamais les
   * memberships suspendus/revoques). Fourni par l'appelant plutot que resolu via un nouveau port
   * cross-module vers Identity : evite un couplage Subscription -> Identity non demande par le
   * perimetre de cette etape (voir rapport de fin de tache — residu documente). L'appelant HTTP
   * (hors perimetre ici) est deja en mesure d'obtenir ce compte via
   * `UserTenantMembershipRepository.countActive`, deja expose par Identity.
   */
  readonly activeMembershipsCount: number;
}

export type CheckUsersQuotaError = 'INVALID_TENANT_ID' | 'SUBSCRIPTION_NOT_FOUND' | 'PLAN_NOT_FOUND';

export interface UsersQuotaStatus {
  readonly withinLimit: boolean;
  readonly maxUsers: number;
  readonly activeMembershipsCount: number;
}

/**
 * Requete PURE de verification du quota `maxUsers` (O-02.3/O-02.4, reliquat clos le
 * 2026-08-24) : rapporte un statut, ne bloque JAMAIS rien. Aucune exception levee pour un
 * depassement — un depassement de quota n'est PAS une erreur de validation, c'est un fait
 * rapporte par la lecture ("alerte, jamais blocage", O-02.4). Ne verifie QUE `maxUsers` :
 * `maxBeds` existe deja comme donnee du `Plan` mais sa verification attend le futur module
 * Building/Room/Bed (hors perimetre avant Phase 4, voir PlanLimits.ts).
 *
 * Aucun appelant de cette etape (aucune commande, notamment `GrantMembership` d'Identity) ne
 * cable cette requete — c'est un residu explicite, documente en fin de tache, pas un oubli :
 * cabler une alerte (notification, tableau de bord Super Admin) est hors perimetre tant que le
 * module Notification (etape 9) n'existe pas.
 */
export class CheckUsersQuotaHandler {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly planRepository: PlanRepository,
  ) {}

  async execute(query: CheckUsersQuotaQuery): Promise<Result<UsersQuotaStatus, CheckUsersQuotaError>> {
    const tenantIdResult = TenantId.create(query.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const tenantId = tenantIdResult.getValue();

    const subscription = await this.subscriptionRepository.findByTenantId(tenantId);
    if (subscription === null) {
      return Result.failure('SUBSCRIPTION_NOT_FOUND');
    }

    const plan = await this.planRepository.findById(subscription.planId);
    if (plan === null) {
      return Result.failure('PLAN_NOT_FOUND');
    }

    return Result.success({
      withinLimit: query.activeMembershipsCount <= plan.limits.maxUsers,
      maxUsers: plan.limits.maxUsers,
      activeMembershipsCount: query.activeMembershipsCount,
    });
  }
}
