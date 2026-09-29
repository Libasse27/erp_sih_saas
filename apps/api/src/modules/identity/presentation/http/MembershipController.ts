import type { Request, Response } from 'express';
import type { ListTenantMembershipsHandler } from '../../application/queries/ListTenantMemberships.js';
import type { MembershipAdminPrincipal } from '../../application/MembershipAdminPrincipal.js';
import { MEMBERSHIP_PAGE_DEFAULT_LIMIT } from '../../domain/MembershipPage.js';
import { ListTenantMembershipsQuerySchema } from './MembershipSchemas.js';
import { toMembershipListResponse } from './MembershipDto.js';

/**
 * Ce que `requireAuthenticatedContext` (construit dans `composition-root.ts`) attache a
 * `res.locals` AVANT ce controleur — jamais un second chemin de resolution de contexte (meme
 * discipline que `FacilityHttpLocals`, module `tenant` : `identity` possede ICI son PROPRE type de
 * principal pour cette permission, distinct d'`AuditReadPrincipal`/`TenantConfigPrincipal` meme si
 * les champs coincident structurellement pour une session TENANT).
 */
export interface MembershipHttpLocals {
  readonly membershipAdminPrincipal: MembershipAdminPrincipal;
  readonly sessionId: string;
}

function isMembershipHttpLocals(locals: Record<string, unknown>): locals is Record<string, unknown> & MembershipHttpLocals {
  return locals.membershipAdminPrincipal !== undefined && typeof locals.sessionId === 'string';
}

/**
 * PREMIER endpoint HTTP mono-module `identity` de ce type (Phase 1, deuxieme increment vertical —
 * permission `membership:administer`, deja declaree au catalogue mais jusqu'ici inutilisee par
 * aucune route). Le controleur fait STRICTEMENT trois choses (§3.5 du system prompt) : valider
 * (zod `.strict()`), deleguer (`ListTenantMemberships`), presenter (DTO explicite) — aucune
 * logique metier ni verification d'autorisation ici, entierement deleguee a
 * `authorizeMembershipAdminister` (module `identity`), jamais reimplementee (meme discipline que
 * `FacilityController`/`AuditEntryController`).
 *
 * `tenantId` n'est JAMAIS lu depuis l'URL ni depuis la query : cette route retourne TOUJOURS "les
 * memberships de mon propre etablissement", derive exclusivement du `ServerContext` serveur (voir
 * `MembershipAdminPrincipal.ts`/`composition-root.ts`) — aucun `tenantId` fourni par le client
 * n'a le moindre effet, meme s'il en contenait un (le schema `.strict()` le rejette de toute
 * facon en `400`, mass-assignment).
 */
export class MembershipController {
  constructor(private readonly listTenantMemberships: ListTenantMembershipsHandler) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isMembershipHttpLocals(locals)) {
      // Ne devrait jamais arriver : `requireAuthenticatedContext` repond deja 401 AVANT d'atteindre
      // ce controleur si aucun principal n'a pu etre resolu (voir composition-root.ts).
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    const parsed = ListTenantMembershipsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const q = parsed.data;

    const result = await this.listTenantMemberships.execute({
      principal: locals.membershipAdminPrincipal,
      ...(q.status !== undefined ? { status: q.status } : {}),
      cursor: q.cursor ?? null,
      limit: q.limit ?? MEMBERSHIP_PAGE_DEFAULT_LIMIT,
    });

    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'FORBIDDEN') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // INVALID_QUERY — curseur malforme (le schema `.strict()` ci-dessus ne peut pas le
      // detecter : c'est une chaine opaque, sa structure interne n'est validee qu'ici).
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    res.status(200).json(toMembershipListResponse(result.getValue()));
  };
}
