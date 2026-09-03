/**
 * Port de limitation de debit (ADR-0010 §8/§12 point 4) — MECANISME valide et rendu
 * obligatoirement complet par le responsable technique : compteur atomique (script Lua unique,
 * `INCR` + `EXPIRE` dans la MEME execution — jamais deux commandes separees, revue de securite
 * independante de l'etape 12/13, BLOQUANT-3/AC-B), aucune cle possible sans TTL, `Retry-After`
 * egal a la duree NOMINALE de la fenetre (jamais le temps residuel). Les VALEURS numeriques
 * (limite, taille de fenetre) restent explicitement NON DECIDEES par cette ADR — voir
 * `shared-kernel/domain/RateLimitTuning.ts`, meme regime que `SessionDurationTuning.ts`.
 *
 * Aucune dependance framework (domain/, regle §5 01-target-architecture.md) : l'implementation
 * Redis vit dans `shared-kernel/infrastructure/RedisRateLimiter.ts`.
 */
export interface RateLimitDecision {
  /** `true` si la requete est acceptee (compteur toujours <= limite APRES incrementation). */
  readonly allowed: boolean;
  /**
   * Duree NOMINALE de la fenetre concernee, en secondes entieres — jamais le TTL residuel de la
   * cle, jamais une date HTTP (ADR-0010 §8, regle "Retry-After — la duree nominale complete,
   * jamais le temps restant"). Renseignee que la requete soit acceptee OU refusee : seul le
   * refus l'expose au client (en-tete `Retry-After`), mais la valeur est calculable dans les deux
   * cas (c'est une CONSTANTE de la politique de la route, pas un etat du compteur).
   */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /**
   * Incremente atomiquement le compteur associe a `key` (deja namespace par l'appelant, voir
   * `sih:rate-limit:<route>:<ip>`, ADR-0010 §8) et retourne la decision. `limit`/`windowSeconds`
   * sont fournis par l'appelant a CHAQUE appel (jamais stockes cote implementation) — la fenetre
   * est fixe et demarre a la premiere requete qui pose la cle (`SET NX EX`), jamais glissante.
   */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}
