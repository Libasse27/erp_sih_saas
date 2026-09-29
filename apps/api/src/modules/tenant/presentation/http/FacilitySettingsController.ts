import type { Request, Response } from 'express';
import type { GetFacilitySettingsHandler } from '../../application/queries/GetFacilitySettings.js';
import type { TenantConfigPrincipal } from '../../application/TenantConfigPrincipal.js';
import { GetFacilitySettingsQuerySchema } from './FacilitySettingsSchemas.js';
import { toFacilitySettingsResponse } from './FacilitySettingsDto.js';

/**
 * Ce que `requireAuthenticatedContext` attache a `res.locals` AVANT ce controleur — meme discipline
 * que `FacilityHttpLocals` (ce module ne possede qu'UN principal, `TenantConfigPrincipal`, partage
 * par `FacilityController` et ce controleur : meme permission `tenant-config:administer`, aucune
 * nouvelle permission introduite pour cette ressource).
 */
export interface FacilitySettingsHttpLocals {
  readonly tenantConfigPrincipal: TenantConfigPrincipal;
}

function isFacilitySettingsHttpLocals(
  locals: Record<string, unknown>,
): locals is Record<string, unknown> & FacilitySettingsHttpLocals {
  return locals.tenantConfigPrincipal !== undefined;
}

/**
 * `GET /api/v1/facility-settings` — lecture seule des parametres regionaux du tenant courant
 * (locale/fuseau/devise/indicatif telephonique), aucune mutation exposee (`FacilitySettings` n'a
 * pas de commande de modification a ce jour, hors perimetre de cet increment). Meme discipline de
 * controleur que `FacilityController` : valider (zod `.strict()` — aucun parametre de requete
 * legitime, tout champ forge comme `tenantId`/`role` est REJETE en `400`, jamais ignore
 * silencieusement) / deleguer / presenter, aucune logique metier ni verification d'autorisation
 * ici.
 */
export class FacilitySettingsController {
  constructor(private readonly getFacilitySettings: GetFacilitySettingsHandler) {}

  get = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isFacilitySettingsHttpLocals(locals)) {
      // Ne devrait jamais arriver : `requireAuthenticatedContext` repond deja 401 AVANT d'atteindre
      // ce controleur si aucun principal n'a pu etre resolu (voir composition-root.ts).
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    const parsedQuery = GetFacilitySettingsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const result = await this.getFacilitySettings.execute({ principal: locals.tenantConfigPrincipal });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'FORBIDDEN') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // FACILITY_SETTINGS_NOT_FOUND — defensif (voir GetFacilitySettings.ts).
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.status(200).json(toFacilitySettingsResponse(result.getValue()));
  };
}
