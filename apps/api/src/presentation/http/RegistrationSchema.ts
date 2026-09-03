import { z } from 'zod';

// Reprend LITTERALEMENT le motif de `modules/identity/domain/value-objects/Email.ts` — jamais
// importee depuis le domaine (regle dependency-cruiser `no-cross-module-domain-import` : ce
// fichier vit hors de `modules/`, `src/presentation/http/` n'a de toute facon pas vocation a
// importer un VO de domaine). Duplication DELIBEREE, voir ADR-0010 §2/§3.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `POST /api/v1/registrations` (ADR-0010 §2/§3). `.strict()` — rejet des champs inconnus
 * (anti mass-assignment, regle §7.3) : `platformRole`, `ownerUserId`, `tenantId`, `roleCodes`,
 * `permissionCodes`, `planCode` ne sont acceptes D'AUCUNE MANIERE, jamais silencieusement.
 *
 * Les bornes ci-dessous DUPLIQUENT VOLONTAIREMENT celles des VO `Email`/`FacilityName`/
 * `CreateUserAccountHandler.MIN_PASSWORD_LENGTH` — ADR-0010 §3 : c'est un CHOIX, pas un oubli.
 * `facilityName` en particulier est une GARDE D'ORDONNANCEMENT : valider le corps ENTIER
 * (email + password + facilityName) en un seul schema, AVANT tout appel a `CreateUserAccount`,
 * est la SEULE protection possible contre le compte orphelin (deux commandes, deux transactions,
 * aucune transaction englobante possible — voir RegistrationController.ts). NE PAS factoriser
 * cette duplication avec le VO `FacilityName` : un futur lecteur qui la "nettoierait" en
 * important le VO depuis `modules/tenant/domain/` violerait a la fois cette garde ET la regle
 * dependency-cruiser `no-cross-module-domain-import`.
 */
export const RegistrationBodySchema = z
  .object({
    email: z.string().trim().min(1).max(254).regex(EMAIL_PATTERN, 'email invalide'),
    password: z.string().min(8).max(512),
    facilityName: z.string().trim().min(1).max(200),
  })
  .strict();

export type RegistrationBodyInput = z.infer<typeof RegistrationBodySchema>;
