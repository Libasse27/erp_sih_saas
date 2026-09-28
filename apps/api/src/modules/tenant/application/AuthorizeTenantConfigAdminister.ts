import { Result } from '../../../shared-kernel/domain/Result.js';
import type { TenantConfigPrincipal } from './TenantConfigPrincipal.js';

export type TenantConfigAuthorizationError = 'FORBIDDEN';

export interface AuthorizedTenantConfigActor {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly roleCodes: readonly string[];
}

/**
 * Decision d'autorisation de la permission `tenant-config:administer` — fonction PURE, SOURCE
 * UNIQUE de cette regle (meme motif qu'`authorizeAuditRead`, module `audit`), appelee par les DEUX
 * handlers de ce module (`GetHealthFacility`/`RenameHealthFacility`) — jamais reimplementee.
 *
 * DEUX branches EXPLICITES, JAMAIS un fallthrough accidentel :
 *   - `PLATFORM` : refuse TOUJOURS — cette permission est portee EXCLUSIVEMENT par le role
 *     systeme TENANT `ADMIN_ETABLISSEMENT` (SystemRoleCatalog.ts), une session `PLATFORM` n'a
 *     structurellement aucun tenant sur lequel l'exercer. Ce n'est PAS le meme raisonnement que
 *     "permission manquante" ci-dessous (une session PLATFORM n'a d'ailleurs pas de
 *     `permissionCodes` a inspecter, voir `TenantConfigPrincipal.ts`) — d'ou une branche nommee
 *     plutot qu'une verification generique qui l'exclurait par accident.
 *   - `TENANT` sans `tenant-config:administer` dans ses `permissionCodes` : refuse.
 */
export function authorizeTenantConfigAdminister(
  principal: TenantConfigPrincipal,
): Result<AuthorizedTenantConfigActor, TenantConfigAuthorizationError> {
  if (principal.kind === 'PLATFORM') {
    return Result.failure('FORBIDDEN');
  }
  if (!principal.permissionCodes.includes('tenant-config:administer')) {
    return Result.failure('FORBIDDEN');
  }
  return Result.success({
    tenantId: principal.tenantId,
    actorUserId: principal.actorUserId,
    roleCodes: principal.roleCodes,
  });
}
