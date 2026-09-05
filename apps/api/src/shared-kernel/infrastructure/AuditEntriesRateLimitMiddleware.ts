import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RateLimiter } from '../domain/ports/RateLimiter.js';
import { assertPositiveIntegerRateLimitConfig } from './RateLimitConfigGuard.js';

/** Contrainte minimale portee par le sujet authentifie — jamais plus que necessaire a la cle. */
export interface AuditEntriesRateLimitSubject {
  readonly actorUserId: string;
}

export interface AuditEntriesRateLimitMiddlewareConfig<TSubject extends AuditEntriesRateLimitSubject> {
  readonly limiter: RateLimiter;
  readonly maxRequests: number;
  readonly windowSeconds: number;
  /**
   * Lit EXCLUSIVEMENT le sujet deja resolu et depose en `res.locals` par
   * `requireAuthenticatedContext` (compose ICI dans `composition-root.ts`, jamais dans ce fichier
   * qui n'importe ni le module `audit` ni le module `identity`) — jamais `req.ip`, jamais un
   * en-tete, jamais un parametre de requete (ADR-0011 §2, Gate d'implementation). `null` si absent
   * : NE DOIT JAMAIS ARRIVER (ce middleware est monte APRES `requireAuthenticatedContext`, qui
   * repond deja 401/403 avant), traite comme une erreur technique — JAMAIS un repli silencieux sur
   * l'IP, qui creerait une politique divergente invisible.
   */
  readonly getSubject: (res: Response) => TSubject | null;
  /**
   * Invoque UNIQUEMENT lors du PREMIER franchissement du seuil dans la fenetre
   * (`decision.firstRejectionInWindow`, ADR-0011 §4.3) — AVANT que le `429` soit envoye au client.
   * Si la promesse retournee REJETTE, la requete se termine par cette meme rejection (propagee a
   * `next`, donc au `createErrorHandler` du serveur -> `500 internal_error`) : JAMAIS de `429`,
   * JAMAIS de reponse servie sans trace (ADR-0011 §4.1). C'est l'appelant qui fournit ici
   * l'ecriture d'audit REELLE (`RecordAuditAccessHandler`, module `audit`) — ce fichier reste
   * volontairement ignorant de sa forme exacte.
   */
  readonly onFirstRejectionInWindow: (req: Request, res: Response, subject: TSubject) => Promise<void>;
}

/**
 * Middleware DEDIE a `GET /api/v1/audit-entries` (ADR-0011 §2/§4) — DISTINCT du middleware
 * PARTAGE `createRateLimitMiddleware` (ADR-0010 §8, RateLimitMiddleware.ts, INCHANGE octet pour
 * octet) : cette route est authentifiee, sa cle est le SUJET (`actorUserId`), jamais l'IP, et un
 * rejet y produit une ecriture d'audit (jamais un `429` muet). Monte, dans `server.ts`, APRES
 * `requireAuthenticatedContext` (sa cle n'existe pas avant) et AVANT le controleur (aucun acces
 * PostgreSQL du journal sur une requete rejetee).
 *
 * Cle Redis : `sih:rate-limit:audit-entries:<actorUserId>` — JAMAIS suffixee par une IP, un
 * `sessionId` ou un `tenantId` (ADR-0011 §2 : deux sessions du meme compte partagent le meme
 * compteur ; changer de reseau ne le remet jamais a zero).
 *
 * Test d'architecture (ADR-0011, "Tests attendus") : ce fichier ne contient AUCUNE occurrence de
 * `200` comme chemin de reponse — le seul code de statut qu'il emet jamais est `429` (ou une
 * absence de reponse directe, deleguee a `next()`/`createErrorHandler`).
 */
export function createAuditEntriesRateLimitMiddleware<TSubject extends AuditEntriesRateLimitSubject>(
  config: AuditEntriesRateLimitMiddlewareConfig<TSubject>,
): RequestHandler {
  assertPositiveIntegerRateLimitConfig({
    route: 'audit-entries',
    maxRequests: config.maxRequests,
    windowSeconds: config.windowSeconds,
  });
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const subject = config.getSubject(res);
      if (subject === null) {
        // Ne devrait jamais arriver (voir commentaire de `getSubject` ci-dessus) : jamais de
        // repli silencieux sur l'IP, jamais de 429 sans sujet identifie.
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      const key = `sih:rate-limit:audit-entries:${subject.actorUserId}`;
      const decision = await config.limiter.consume(key, config.maxRequests, config.windowSeconds);
      if (!decision.allowed) {
        if (decision.firstRejectionInWindow) {
          // AVANT le 429, dans le flux normal de la promesse : une rejection ici remonte au
          // `.catch(next)` plus bas SANS jamais atteindre le `res.status(429)` suivant.
          await config.onFirstRejectionInWindow(req, res, subject);
        }
        res.set('Retry-After', String(decision.retryAfterSeconds));
        res.status(429).json({ error: 'too_many_requests' });
        return;
      }
      next();
    })().catch(next);
  };
}
