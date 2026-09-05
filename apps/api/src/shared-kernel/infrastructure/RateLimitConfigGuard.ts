/**
 * Garde de construction PARTAGEE entre les DEUX NOUVELLES factories de limitation de debit
 * introduites par ADR-0011 (`AuditEntriesRateLimitMiddleware.ts` et `SilentRateLimitGuard.ts`) —
 * memes verifications, au meme instant (la CONSTRUCTION du middleware, jamais a chaque requete),
 * que celles deja appliquees par `RateLimitMiddleware.ts` (ADR-0010 §12 point 4, AC-B) :
 * `RedisRateLimiter.consume` transmet `windowSeconds` tel quel a `EXPIRE` dans un script Lua SANS
 * rollback — un nombre non entier ou <= 0 ferait avorter le script APRES que `INCR` a deja cree la
 * cle (cle sans TTL) ou desactiverait silencieusement la limitation (`EXPIRE key 0` supprime la
 * cle).
 *
 * Extraite ICI pour n'etre dupliquee NULLE PART entre les deux nouvelles factories (ADR-0011 §7,
 * Gate pour l'agent d'implementation : "extraire la garde de construction ... dans une fonction
 * partagee plutot que la dupliquer"). `RateLimitMiddleware.ts` (ADR-0010) N'EST PAS reecrit pour
 * l'utiliser : il reste inchange, octet pour octet — contrainte explicite d'ADR-0011 ("ne modifie
 * pas createRateLimitMiddleware"), les verifications qu'il contient deja restent une troisieme
 * copie volontaire, pas un oubli.
 */
export function assertPositiveIntegerRateLimitConfig(config: {
  readonly route: string;
  readonly maxRequests: number;
  readonly windowSeconds: number;
}): void {
  if (!Number.isInteger(config.windowSeconds) || config.windowSeconds <= 0) {
    throw new Error(`Limitation de debit ("${config.route}") : windowSeconds doit etre un entier positif (recu ${config.windowSeconds}).`);
  }
  if (!Number.isInteger(config.maxRequests) || config.maxRequests <= 0) {
    throw new Error(`Limitation de debit ("${config.route}") : maxRequests doit etre un entier positif (recu ${config.maxRequests}).`);
  }
}
