import { Redis } from 'ioredis';

/**
 * Connexion ioredis DEDIEE a BullMQ (etape 6/13, ADR-0004) — distincte de la connexion Redis
 * partagee du composition-root (`sessions`/cache, `maxRetriesPerRequest: 3`). BullMQ EXIGE
 * `maxRetriesPerRequest: null` sur toute connexion utilisee par un `Worker`/`QueueEvents` (commandes
 * bloquantes `BRPOPLPUSH`/`BZPOPMIN` en interne) — reutiliser la connexion applicative existante
 * romprait silencieusement cette contrainte documentee par BullMQ. Une seconde connexion Redis
 * legere (meme instance Redis, deux clients TCP) est le cout accepte pour ne jamais coupler les
 * deux usages.
 */
export function createOutboxQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
}
