/**
 * Categorie de sensibilite d'une session complete (PLATFORM ou TENANT), utilisee pour calculer sa
 * duree (O-06.1/O-06.2, ADR-0006 §1). Calquee EXACTEMENT sur ce que `MfaPolicy.ts` implemente deja
 * (booleen `requiresMfa`, plus la regle fixe PLATFORM) — pas une taxonomie plus fine : O-06.1
 * interdit explicitement une "troisieme taxonomie de risque" distincte de celle d'O-04.1, et
 * `MfaPolicy.ts` ne distingue pas "admin tenant" de "finance a fort impact" (les deux fusionnent
 * dans le meme booleen). Voir `services/MfaPolicy.ts::resolveSessionSensitivityCategory`.
 *
 * N'existe jamais sur une session `MFA_PENDING` (fenetre courte et non negociable, independante
 * de cette politique — voir `MfaTuning.ts::MFA_PENDING_SESSION_WINDOW_SECONDS`).
 */
export type SessionSensitivityCategory = 'PLATFORM_SUPER_ADMIN' | 'TENANT_MFA_REQUIRED' | 'TENANT_STANDARD';
