import { Result } from '../../../shared-kernel/domain/Result.js';
import type { MembershipAdminPrincipal } from './MembershipAdminPrincipal.js';

export type MembershipAdminAuthorizationError = 'FORBIDDEN';

export interface AuthorizedMembershipAdminActor {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly roleCodes: readonly string[];
}

/**
 * Decision d'autorisation de la permission `membership:administer` — fonction PURE, SOURCE
 * UNIQUE de cette regle (meme motif qu'`authorizeTenantConfigAdminister`, module `tenant`),
 * appelee par `ListTenantMembershipsHandler` — jamais reimplementee.
 *
 * DEUX branches EXPLICITES, JAMAIS un fallthrough accidentel :
 *   - `PLATFORM` : refuse TOUJOURS — cette permission est portee EXCLUSIVEMENT par le role
 *     systeme TENANT `ADMIN_ETABLISSEMENT` (SystemRoleCatalog.ts), une session `PLATFORM` n'a
 *     structurellement aucun tenant sur lequel l'exercer. Ce n'est PAS le meme raisonnement que
 *     "permission manquante" ci-dessous (une session PLATFORM n'a d'ailleurs pas de
 *     `permissionCodes` a inspecter, voir `MembershipAdminPrincipal.ts`) — d'ou une branche
 *     nommee plutot qu'une verification generique qui l'exclurait par accident.
 *   - `TENANT` sans `membership:administer` dans ses `permissionCodes` : refuse.
 */
export function authorizeMembershipAdminister(
  principal: MembershipAdminPrincipal,
): Result<AuthorizedMembershipAdminActor, MembershipAdminAuthorizationError> {
  if (principal.kind === 'PLATFORM') {
    return Result.failure('FORBIDDEN');
  }
  if (!principal.permissionCodes.includes('membership:administer')) {
    return Result.failure('FORBIDDEN');
  }
  return Result.success({
    tenantId: principal.tenantId,
    actorUserId: principal.actorUserId,
    roleCodes: principal.roleCodes,
  });
}
