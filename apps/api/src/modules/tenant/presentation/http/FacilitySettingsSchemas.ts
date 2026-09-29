import { z } from 'zod';

/**
 * `GET /api/v1/facility-settings` — aucun parametre de requete legitime (meme discipline que
 * `RenameHealthFacilityBodySchema.ts` : `.strict()`, rejet des champs inconnus, anti mass-
 * assignment, regle §7.3 du system prompt). `tenantId`/`role`/tout autre champ forge dans la query
 * est REJETE en `400`, jamais silencieusement ignore — cette route derive TOUJOURS le tenant du
 * `ServerContext` serveur (`GetFacilitySettings.ts`), un `?tenantId=...` fourni par le client n'a
 * donc de toute facon aucun effet, mais doit etre explicitement refuse plutot que tolere en
 * silence (critere de gouvernance Phase 0 -> Phase 1, valeurs forgees rejetees et verifiees).
 */
export const GetFacilitySettingsQuerySchema = z.object({}).strict();

export type GetFacilitySettingsQueryInput = z.infer<typeof GetFacilitySettingsQuerySchema>;
