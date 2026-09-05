import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RateLimitDecision, RateLimiter } from '../domain/ports/RateLimiter.js';
import { assertPositiveIntegerRateLimitConfig } from './RateLimitConfigGuard.js';

/**
 * Motif d'un rejet, transmis a `onRejected` — vocabulaire GENERIQUE du shared-kernel, distinct du
 * vocabulaire de log du module `payment` (`reason: 'rate_limited'` / `'rate_limiter_unavailable'`,
 * compose par `composition-root.ts` a partir de cette valeur). Ce fichier n'importe donc jamais le
 * vocabulaire de log du module `payment` : ADR-0011 Amendement 1, BLOQUANT-1.
 *   - `'threshold_exceeded'`  : le compteur a reellement depasse `maxRequests` sur la fenetre.
 *   - `'limiter_unavailable'` : `limiter.consume(...)` a leve une exception (Redis en bascule,
 *     timeout, OOM, erreur EVAL, ...) — la requete est alors traitee EXACTEMENT comme un
 *     depassement de seuil (fail-closed silencieux), mais le motif reel ne doit JAMAIS etre
 *     confondu avec un depassement normal : il mentirait sur la cause.
 */
export type SilentRateLimitRejectionReason = 'threshold_exceeded' | 'limiter_unavailable';

export interface SilentRateLimitGuardConfig {
  readonly route: string;
  readonly limiter: RateLimiter;
  readonly maxRequests: number;
  readonly windowSeconds: number;
  /**
   * Rappel d'observabilite SEUL effet de bord d'un rejet (jamais une `AuditEntry` — ADR-0011
   * §5.3 : aucun acteur imputable, aucun sujet, aucun tenant connu a ce stade, fait de niveau
   * transport). Ce fichier n'importe JAMAIS le module `payment` ni son logger : l'appelant
   * (`composition-root.ts`) fournit ici une simple fonction synchrone, qui recoit le MOTIF exact
   * du rejet (ADR-0011 Amendement 1, BLOQUANT-1) pour ne jamais journaliser `rate_limiter_unavailable`
   * sous le motif `rate_limited`, qui mentirait sur la cause reelle.
   */
  readonly onRejected: (reason: SilentRateLimitRejectionReason) => void;
}

/**
 * Factory SEPAREE et DISTINCTE de `createRateLimitMiddleware` (ADR-0010 §8, RateLimitMiddleware.ts,
 * INCHANGE octet pour octet) — ADR-0011 §5.2/§7, decision D4. Protege `POST
 * /api/v1/payments/webhook` d'un flood generique SANS JAMAIS repondre par le code de rejet
 * standard des cinq routes ADR-0010 : c'est un invariant PREEXISTANT, ferme et teste au niveau
 * HTTP reel (commit `649a7b6`, `test/payment/integration/paymentWebhookHttp.test.ts`) que
 * `PaymentWebhookController.handle` repond TOUJOURS avec le code de succes `200`, quelle que soit
 * l'issue — repondre autrement fournirait a l'appelant un oracle que quatre autres cas de rejet de
 * cette route s'interdisent deja, et declencherait la tempete de re-livraison que ce `200`
 * systematique existe pour eviter.
 *
 * L'UNIQUE chemin de reponse de ce fichier est `res.status(200).end()` : AUCUNE occurrence du code
 * de rejet standard n'y figure (verifiable par simple lecture, test d'architecture d'ADR-0011,
 * "Tests attendus"). AUCUN drapeau `silent` n'est ajoute a `createRateLimitMiddleware` (alternative
 * ecartee #6 d'ADR-0011) : une politique de reponse pilotee par un booleen rendrait possible, par
 * une simple erreur de cablage, un rejet explicite sur le webhook ou un succes silencieux sur
 * l'inscription. Deux factories, deux noms, aucune ambiguite.
 *
 * Montee en PREMIER middleware de la route, AVANT `express.raw()` (server.ts) — jamais apres :
 * sous flood, un corps de 256 Ko ne doit JAMAIS etre lu/bufferise avant que la decision de
 * limitation soit prise (meme invariant qu'ADR-0010 §9, correctif BLOQUANT-3).
 *
 * Cle Redis GLOBALE UNIQUE `sih:rate-limit:<route>:global` — PAS l'IP (mutualisee entre les
 * clients d'un meme PSP), PAS le tenant (inconnu a ce stade, cf. `ConfirmPayment.ts`), PAS un
 * champ du corps de requete (ADR-0011 §3, decision D2).
 *
 * **Fail-closed silencieux (ADR-0011 Amendement 1, BLOQUANT-1)** : si `limiter.consume(...)`
 * leve une exception (Redis en bascule, timeout, OOM, erreur `EVAL`, ...), la requete emprunte le
 * MEME et UNIQUE chemin de sortie que "seuil depasse" — JAMAIS `.catch(next)`/`createErrorHandler`,
 * qui produirait un `500` et declencherait la meme tempete de re-livraison PSP que le `200`
 * systematique existe pour eviter, au moment le plus defavorable (Redis deja degrade). Le motif
 * transmis a `onRejected` distingue neanmoins les deux cas (`'threshold_exceeded'` vs
 * `'limiter_unavailable'`) : le second ne doit JAMAIS etre journalise comme le premier, qui
 * mentirait sur la cause reelle du rejet.
 */
export function createSilentRateLimitGuard(config: SilentRateLimitGuardConfig): RequestHandler {
  assertPositiveIntegerRateLimitConfig({
    route: config.route,
    maxRequests: config.maxRequests,
    windowSeconds: config.windowSeconds,
  });
  const key = `sih:rate-limit:${config.route}:global`;
  return (_req: Request, res: Response, next: NextFunction): void => {
    const respondRejected = (reason: SilentRateLimitRejectionReason): void => {
      try {
        config.onRejected(reason);
      } catch {
        // L'observabilite ne doit JAMAIS empecher le 200 : une exception du callback de log ne
        // doit pas se propager hors de cette IIFE (elle deviendrait une promesse non geree, non
        // catchee par le seul autre `try` de cette fonction). Seul cas ou ignorer une exception
        // est la decision de securite correcte, l'inverse casserait l'invariant D4.
      }
      // Reponse IDENTIQUE a tous les autres cas de rejet de cette route (signature absente,
      // payload illisible, transaction inconnue, limiteur indisponible) : aucune verification de
      // signature, aucun acces base, aucun traitement metier n'a lieu au-dela de ce point.
      res.status(200).end();
    };
    void (async () => {
      let decision: RateLimitDecision;
      try {
        decision = await config.limiter.consume(key, config.maxRequests, config.windowSeconds);
      } catch {
        // Le limiteur lui-meme est en panne : fail-closed silencieux, MEME chemin de sortie que le
        // depassement de seuil (ADR-0011 Amendement 1, BLOQUANT-1) — jamais un `500` qui fournirait
        // un signal exploitable au moment ou l'infrastructure est deja degradee.
        respondRejected('limiter_unavailable');
        return;
      }
      if (!decision.allowed) {
        respondRejected('threshold_exceeded');
        return;
      }
      next();
    })();
  };
}
