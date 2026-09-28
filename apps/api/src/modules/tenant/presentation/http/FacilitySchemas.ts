import { z } from 'zod';

/**
 * `PATCH /api/v1/facility` — Phase 1, premier increment vertical (permission
 * `tenant-config:administer`). `.strict()` — rejet des champs inconnus (anti mass-assignment,
 * regle §7.3) : `tenantId`/`role`/`permissionCodes` ne sont acceptes D'AUCUNE MANIERE, jamais
 * silencieusement (`tenantId`/le role de l'acteur sont TOUJOURS derives du `ServerContext` serveur,
 * jamais du corps de la requete — meme discipline que `RegistrationBodySchema.ts`).
 *
 * Bornes ci-dessous DUPLIQUENT VOLONTAIREMENT celles du VO `FacilityName`
 * (`modules/tenant/domain/value-objects/FacilityName.ts`) — meme choix deliberement assume que
 * `RegistrationBodySchema.ts` (§3 de l'ADR-0010) : validation de forme a la frontiere HTTP, defense
 * en profondeur, jamais une dependance du presentation/ vers le domain/ d'un VO (ce fichier vit
 * dans le MEME module que le VO, mais la duplication reste deliberee pour ne jamais coupler le
 * contrat HTTP a un detail d'implementation du domaine).
 */
export const RenameHealthFacilityBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict();

export type RenameHealthFacilityBodyInput = z.infer<typeof RenameHealthFacilityBodySchema>;
