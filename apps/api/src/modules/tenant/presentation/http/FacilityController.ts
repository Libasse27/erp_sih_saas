import type { Request, Response } from 'express';
import type { GetHealthFacilityHandler } from '../../application/queries/GetHealthFacility.js';
import type { RenameHealthFacilityHandler } from '../../application/commands/RenameHealthFacility.js';
import type { TenantConfigPrincipal } from '../../application/TenantConfigPrincipal.js';
import { RenameHealthFacilityBodySchema } from './FacilitySchemas.js';
import { toHealthFacilityResponse } from './FacilityDto.js';

/**
 * Ce que `requireAuthenticatedContext` (construit dans `composition-root.ts`) attache a
 * `res.locals` AVANT ce controleur — jamais un second chemin de resolution de contexte (meme
 * discipline qu'`AuditHttpLocals`, module `audit` : `tenant` possede son PROPRE type de principal,
 * jamais celui d'un autre module).
 */
export interface FacilityHttpLocals {
  readonly tenantConfigPrincipal: TenantConfigPrincipal;
  readonly sessionId: string;
}

function isFacilityHttpLocals(locals: Record<string, unknown>): locals is Record<string, unknown> & FacilityHttpLocals {
  return locals.tenantConfigPrincipal !== undefined && typeof locals.sessionId === 'string';
}

/**
 * PREMIER endpoint HTTP du module `tenant` (Phase 1, premier increment vertical — permission
 * `tenant-config:administer`, deja declaree au catalogue mais jusqu'ici inutilisee par aucune
 * route). Le controleur fait STRICTEMENT trois choses (§3.5 du system prompt) : valider (zod
 * `.strict()`), deleguer (`GetHealthFacility`/`RenameHealthFacility`), presenter (DTO explicite) —
 * aucune logique metier ni verification d'autorisation ici, entierement deleguee a
 * `authorizeTenantConfigAdminister` (module `tenant`), jamais reimplementee (meme discipline que
 * `AuditEntryController`/`SuperAdminBreakGlassController`).
 *
 * `tenantId` n'est JAMAIS lu depuis l'URL ni depuis le corps de la requete : les DEUX operations
 * portent TOUJOURS sur "l'etablissement du principal courant", derive exclusivement du
 * `ServerContext` serveur (voir `TenantConfigPrincipal.ts`/`composition-root.ts`) — aucun `tenantId`
 * ni `role` fourni par le client n'a le moindre effet, meme si le corps de la requete en contient
 * un (le schema `.strict()` le rejette de toute facon en `400`, mass-assignment).
 */
export class FacilityController {
  constructor(
    private readonly getHealthFacility: GetHealthFacilityHandler,
    private readonly renameHealthFacility: RenameHealthFacilityHandler,
  ) {}

  get = async (_req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isFacilityHttpLocals(locals)) {
      // Ne devrait jamais arriver : `requireAuthenticatedContext` repond deja 401 AVANT d'atteindre
      // ce controleur si aucun principal n'a pu etre resolu (voir composition-root.ts).
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    const result = await this.getHealthFacility.execute({ principal: locals.tenantConfigPrincipal });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'FORBIDDEN') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // FACILITY_NOT_FOUND — defensif (voir GetHealthFacility.ts) ; §3.2 du system prompt : ne
      // jamais reveler l'existence, meme traitement qu'une ressource hors tenant ailleurs dans ce
      // depot.
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.status(200).json(toHealthFacilityResponse(result.getValue()));
  };

  rename = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isFacilityHttpLocals(locals)) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    const parsed = RenameHealthFacilityBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id') ?? null;

    const result = await this.renameHealthFacility.execute({
      principal: locals.tenantConfigPrincipal,
      newName: parsed.data.name,
      sessionId: locals.sessionId,
      correlationId,
    });

    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'FORBIDDEN') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (error === 'FACILITY_NOT_FOUND') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (error === 'INVALID_NAME') {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      // NAME_UNCHANGED — refus metier explicite (meme convention que ProrationCalculator.
      // NOT_AN_UPGRADE, voir HealthFacility.rename()), jamais un succes silencieux.
      res.status(409).json({ error: 'conflict' });
      return;
    }

    res.status(200).json(toHealthFacilityResponse(result.getValue()));
  };
}
