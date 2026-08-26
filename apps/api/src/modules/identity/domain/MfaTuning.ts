/**
 * Constantes de reglage du MFA TOTP (ADR-0005, "Residus a fermer avant la fin de Phase 0" §1-2).
 * Valeurs confirmees par le responsable technique le 2026-08-26 comme DEFAUTS D'IMPLEMENTATION
 * (pas encore une politique definitivement figee) — regroupees ici, nommees, et commentees pour
 * rester triviales a ajuster sans chasser des litteraux disperses dans le code.
 *
 * Vit dans `domain/` (aucune dependance framework) : ce sont des regles metier (verrouillage
 * anti-brute-force, nombre de codes de secours, fenetre de challenge), pas un detail
 * d'infrastructure.
 */

/** Nombre d'echecs consecutifs (TOTP ou code de recuperation) avant verrouillage temporaire du facteur. */
export const MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS = 5;

/** Duree du verrouillage temporaire une fois le seuil ci-dessus atteint. */
export const MFA_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** Nombre de codes de recuperation generes a l'enrolement et a chaque regeneration. */
export const MFA_RECOVERY_CODE_COUNT = 10;

/**
 * Fenetre de validite d'une session `MFA_PENDING` (borne technique, PAS une politique de duree de
 * session opposable — voir ADR-0005 §4, meme nature que `RedisSessionStore.OPERATIONAL_SAFETY_TTL_SECONDS`).
 */
export const MFA_PENDING_SESSION_WINDOW_SECONDS = 5 * 60;
