import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimiter } from '../domain/ports/RateLimiter.js';

/**
 * Script Lua unique — Redis garantit qu'aucune autre commande ne s'intercale pendant son
 * execution (contrairement a `SET NX EX` PUIS `INCR`, qui sont DEUX allers-retours reseau
 * distincts et NON atomiques entre eux : si la cle expire entre les deux, `INCR` la recree SANS
 * aucun TTL, c'est-a-dire une IP bloquee DEFINITIVEMENT — le deni de service permanent que la
 * version precedente pretendait avoir ecarte sans y parvenir, corrige a la revue de securite
 * independante de l'etape 12/13, BLOQUANT-3).
 *
 * `INCR` cree la cle a 1 si elle n'existe pas ; le TTL est repose DANS LA MEME execution atomique
 * si la cle vient d'etre creee (`current == 1`) OU si elle existe deja SANS aucun TTL
 * (`PTTL` renvoie `-1`) — cette seconde branche AUTO-REPARE toute cle laissee sans expiration par
 * un bug anterieur (ou par un futur `EXPIRE` qui echouerait pour une autre raison) : sans elle,
 * une IP ainsi bloquee resterait bloquee A VIE meme apres correction du bug (revue de securite
 * independante de l'etape 12/13, AC-B).
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/**
 * Implementation Redis du port `RateLimiter` (ADR-0010 §8/§12 point 4). Compteur incremente et
 * son TTL pose en UNE SEULE execution Lua atomique (`CONSUME_SCRIPT` ci-dessus) — jamais deux
 * commandes separees.
 *
 * `retryAfterSeconds` est TOUJOURS la fenetre NOMINALE fournie par l'appelant (`windowSeconds`),
 * jamais le TTL residuel lu depuis Redis (`PTTL`/`TTL`) : c'est precisement ce qui garantit la
 * propriete testable d'ADR-0010 §8 ("deux rejets `429` survenant a des instants differents d'une
 * MEME fenetre portent une valeur de `Retry-After` STRICTEMENT identique").
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const count = await this.redis.eval(CONSUME_SCRIPT, 1, key, windowSeconds.toString());
    return { allowed: Number(count) <= limit, retryAfterSeconds: windowSeconds };
  }
}
