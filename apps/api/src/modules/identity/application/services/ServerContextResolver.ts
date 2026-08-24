import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWorkContext } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlatformSessionContext, SessionStore, TenantSessionContext } from '../ports/SessionStore.js';

export type ServerContext =
  | { readonly kind: 'PLATFORM'; readonly actorUserId: string; readonly session: PlatformSessionContext }
  | {
      readonly kind: 'TENANT';
      readonly actorUserId: string;
      readonly tenantId: TenantId;
      readonly session: TenantSessionContext;
    };

export type ResolveServerContextError = 'SESSION_NOT_FOUND';

/**
 * Resout le contexte serveur (`tenantId`, `actorUserId`) a partir d'un `sessionId` porte par la
 * requete entrante (cookie/en-tete — 01-target-architecture.md §3.2 couche 1 : "le tenantId est
 * resolu serveur depuis le jeton, jamais lu du corps ni de l'URL"). C'est le point de passage
 * OBLIGATOIRE entre "ce que le client pretend" et "ce que `UnitOfWork.withTransaction` recoit
 * comme contexte RLS" (ADR-0001 couche 4) : aucun `tenantId` ne doit jamais transiter d'une
 * requete HTTP vers une transaction sans passer par ici.
 *
 * EMPLACEMENT (decision non triviale, Phase 0 etape 3) : ce service vit dans
 * `modules/identity/application/`, PAS dans `modules/tenant/` ni dans `shared-kernel/`.
 * - Toutes ses dependances reelles (`SessionStore`, `SessionContext`, `PlatformSessionContext`,
 *   `TenantSessionContext`) sont deja des concepts possedes par Identity — ce service n'a
 *   strictement rien a faire avec le domain/ de Tenant, il ne l'importe donc pas (regle
 *   dependency-cruiser `no-cross-module-domain-import` ajoutee avec ce module).
 * - `shared-kernel/` est ecarte deliberement : shared-kernel ne doit JAMAIS dependre d'un
 *   module (la dependance va uniquement module -> shared-kernel, jamais l'inverse). Or
 *   `SessionContext` porte des champs specifiques a Identity (`membershipId`, `roleCodes`,
 *   `permissionCodes`) qui n'ont aucun sens generique a extraire dans le shared-kernel — ce
 *   n'est pas une abstraction neutre, c'est un concept Identity.
 * - Le seul type partage entre modules ici est `UnitOfWorkContext`, deja dans shared-kernel/
 *   depuis l'etape Identity (concu des le depart pour etre reutilise par tous les modules — voir
 *   commentaire sur `UnitOfWorkContext`), donc aucun nouveau port cross-module n'est necessaire
 *   dans ce sens (Identity -> shared-kernel est toujours autorise).
 */
export class ServerContextResolver {
  constructor(private readonly sessionStore: SessionStore) {}

  async resolve(sessionId: string): Promise<Result<ServerContext, ResolveServerContextError>> {
    const session = await this.sessionStore.get(sessionId);
    if (session === null) {
      // Session absente OU deja fermee/expiree : aucun contexte ne doit etre construit. L'appelant
      // ne doit alors JAMAIS appeler `toUnitOfWorkContext` — sans UnitOfWorkContext, le RLS refuse
      // par defaut (couche 4, deja verifie dans test/identity/integration/rls.test.ts).
      return Result.failure('SESSION_NOT_FOUND');
    }

    if (session.kind === 'PLATFORM') {
      return Result.success({ kind: 'PLATFORM', actorUserId: session.userId, session });
    }

    const tenantIdResult = TenantId.create(session.tenantId);
    if (tenantIdResult.isFailure()) {
      // Un SessionContext TENANT est toujours cree par ResolveTenantContextHandler a partir d'un
      // TenantId deja valide (voir ResolveTenantContext.ts) : un tenantId invalide ici trahit une
      // corruption du stockage de session (Redis), pas un echec metier attendu — on ne degrade
      // jamais silencieusement vers "pas de tenant" dans ce cas, on leve.
      throw new Error(`SessionContext TENANT corrompu : tenantId invalide ("${session.tenantId}").`);
    }

    return Result.success({
      kind: 'TENANT',
      actorUserId: session.userId,
      tenantId: tenantIdResult.getValue(),
      session,
    });
  }

  /**
   * Traduit un `ServerContext` deja resolu en `UnitOfWorkContext` a transmettre a
   * `withTransaction`. Un contexte `PLATFORM` ne porte jamais de `tenantId` — c'est correct et
   * intentionnel (niveau plateforme, hors RLS tenant, ADR-0001 §3.2 dernier paragraphe).
   */
  toUnitOfWorkContext(context: ServerContext): UnitOfWorkContext {
    return context.kind === 'TENANT'
      ? { tenantId: context.tenantId, actorUserId: context.actorUserId }
      : { actorUserId: context.actorUserId };
  }
}
