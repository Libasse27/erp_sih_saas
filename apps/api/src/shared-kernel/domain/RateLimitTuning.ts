/**
 * Constantes de reglage du limiteur de debit PARTAGE des cinq routes pre-authentification
 * (ADR-0010 §8/§12 point 4 : `POST /api/v1/registrations`, `POST /api/v1/auth/sessions`,
 * `POST /api/v1/auth/mfa/enrollment`, `POST /api/v1/auth/mfa/enrollment/confirmation`,
 * `POST /api/v1/auth/sessions/mfa-challenge`).
 *
 * Le MECANISME (compteur Redis atomique via script Lua unique `INCR`+`EXPIRE`, cle IP jamais
 * tenant-scopee, `Retry-After` = duree nominale constante) est valide et OBLIGATOIRE. Les VALEURS ci-dessous
 * sont explicitement NON DEFINITIVES — meme regime que
 * `modules/identity/domain/SessionDurationTuning.ts` (ADR-0006 §3) : aucun arbitrage metier
 * (produit/anti-abus) n'a ete rendu sur des seuils precis, ces nombres ne sont que des ordres de
 * grandeur conservateurs necessaires pour que le mecanisme soit executable et testable
 * (ADR-0010 §12 point 4, residu 4). Ne JAMAIS les presenter comme une politique de production
 * opposable tant que ce point n'est pas clos.
 *
 * Regroupees ICI et nommees explicitement (`<FAMILLE>_RATE_LIMIT_MAX_REQUESTS`/
 * `_WINDOW_SECONDS`) pour rester triviales a ajuster sans toucher au middleware, a
 * `composition-root.ts` ni a `server.ts` — ADR-0010, Gate pour l'agent d'implementation :
 * "Aucune valeur numerique ailleurs que dans le fichier de reglage dedie".
 *
 * A VALIDER METIER — NON DEFINITIF.
 */

/** `POST /api/v1/registrations` — surface anonyme la plus sensible (cree un tenant indestructible, ADR-0010 §Contexte 5). */
export const REGISTRATION_RATE_LIMIT_MAX_REQUESTS = 5;
export const REGISTRATION_RATE_LIMIT_WINDOW_SECONDS = 60;

/** `POST /api/v1/auth/sessions` (connexion initiale ET re-soumission apres enrolement MFA, §7 bis E). */
export const LOGIN_RATE_LIMIT_MAX_REQUESTS = 10;
export const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Les TROIS routes MFA (§7 bis) — surfaces pre-authentification portant un `Bearer` `MFA_PENDING`, jamais un contexte complet (ADR-0010 §8). */
export const MFA_ROUTES_RATE_LIMIT_MAX_REQUESTS = 10;
export const MFA_ROUTES_RATE_LIMIT_WINDOW_SECONDS = 60;
