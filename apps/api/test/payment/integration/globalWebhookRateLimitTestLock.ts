import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const LOCK_KEY = 'sih:test-lock:payment-webhook:global';
const LOCK_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 50;
// Volontairement < `testTimeout`/`hookTimeout` (20_000ms, vitest.config.ts) : un deadlock produit
// ainsi l'erreur explicite ci-dessous plutot que le timeout generique, moins informatif, de Vitest.
const ACQUIRE_TIMEOUT_MS = 15_000;

/** Ne libere la cle QUE si elle porte encore le jeton de CE detenteur (jamais le verrou d'un autre, ex. apres expiration du TTL et reacquisition entretemps). */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * Verrou Redis exclusif dedie a la cle `sih:rate-limit:payment-webhook:global` (CI-03) — jamais
 * la cle metier elle-meme, une cle DISTINCTE reservee au verrou.
 *
 * Ce compteur est VOLONTAIREMENT global (ADR-0011 D2, "aucune cle par tenant/IP") : il ne peut
 * donc jamais etre scope par test sans changer le comportement teste. Deux fichiers de test
 * integration le manipulent reellement (`paymentWebhookRateLimiting.test.ts` — qui le sature et
 * verifie l'etat resultant — et le dernier scenario de `paymentWebhookRateLimiterFailure.test.ts`
 * — qui verifie qu'aucune commande Redis reussie ne pose la cle quand le script Lua echoue) et
 * s'executent dans des workers Vitest distincts, potentiellement en parallele : sans coordination,
 * une rafale reelle de l'un peut poser ou faire disparaitre la cle pendant l'assertion de l'autre
 * (CI-03, reproduit de maniere deterministe en executant les deux fichiers ensemble).
 *
 * Isolation REELLE des donnees Redis partagees (jamais un controle du parallelisme Vitest) :
 * `SET ... PX <ttl> NX` (attribution atomique, jamais une paire GET+SET) avec attente active
 * bornee tant que le verrou est deja detenu, puis liberation par script Lua verifiant le jeton
 * (jamais un simple DEL, qui liberait aussi le verrou d'un autre detenteur apres expiration du
 * TTL). Le TTL borne tout deadlock a la duree du timeout d'un test Vitest (`testTimeout`,
 * vitest.config.ts) en cas de crash du processus detenteur.
 */
export async function acquireGlobalWebhookRateLimitLock(redis: Redis): Promise<() => Promise<void>> {
  const token = randomUUID();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    const acquired = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`Verrou de test ${LOCK_KEY} non acquis apres ${ACQUIRE_TIMEOUT_MS}ms (deadlock probable, CI-03).`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return async () => {
    await redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
  };
}
