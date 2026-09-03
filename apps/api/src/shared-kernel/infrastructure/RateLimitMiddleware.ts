import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RateLimiter } from '../domain/ports/RateLimiter.js';

export interface RateLimitMiddlewareConfig {
  /** Segment de cle stable identifiant la route (ex. `registrations`, `auth-sessions`, `mfa`) — jamais un chemin dynamique. */
  readonly route: string;
  readonly limiter: RateLimiter;
  readonly maxRequests: number;
  readonly windowSeconds: number;
}

/**
 * Middleware de limitation de debit PARTAGE des cinq routes pre-authentification (ADR-0010 §8,
 * "Gate pour l'agent d'implementation") — CONSTRUIT dans `composition-root.ts` (un seul point de
 * cablage, un appel de cette factory par famille de limite : inscription, connexion, MFA), monte
 * en PREMIER sur chaque route (avant toute desserialisation applicative, avant tout acces
 * Redis/PostgreSQL du controleur — §9 de l'ADR).
 *
 * Cle `sih:rate-limit:<route>:<ip>` — l'IP SEULE, jamais un `tenantId`, jamais l'email, jamais un
 * champ du corps de requete (ADR-0010 §8 : ces routes sont anonymes et pre-tenant, un champ
 * controle par le client se contournerait en le faisant varier). `req.ip` (jamais un en-tete
 * `X-Forwarded-For` lu directement, jamais spoofable par le client tant que `trust proxy` n'est
 * pas active — ce depot ne l'active pas, voir server.ts) — c'est l'adresse de connexion TCP brute
 * telle que vue par le processus Node.
 *
 * Aucune entree d'audit n'est ecrite sur un rejet (ADR-0010 §8, meme raisonnement qu'ADR-0009
 * §2.1) : point d'entree non authentifie, aucune purge disponible pour une IP. L'IP ne vit QUE
 * dans la cle Redis, avec TTL — jamais journalisee.
 */
export function createRateLimitMiddleware(config: RateLimitMiddlewareConfig): RequestHandler {
  // Garde a la CONSTRUCTION (echec immediat au demarrage du serveur), pas a chaque requete :
  // `RedisRateLimiter.consume` transmet `windowSeconds` tel quel a `EXPIRE` dans un script Lua
  // SANS rollback — un nombre non entier ou <= 0 ferait avorter le script APRES que `INCR` a deja
  // cree la cle (cle sans TTL, IP bloquee definitivement) ou desactiverait silencieusement la
  // limitation (`EXPIRE key 0` supprime la cle). Revue de securite independante de l'etape 12/13,
  // AC-B.
  if (!Number.isInteger(config.windowSeconds) || config.windowSeconds <= 0) {
    throw new Error(`createRateLimitMiddleware : windowSeconds doit etre un entier positif ("${config.route}", recu ${config.windowSeconds}).`);
  }
  if (!Number.isInteger(config.maxRequests) || config.maxRequests <= 0) {
    throw new Error(`createRateLimitMiddleware : maxRequests doit etre un entier positif ("${config.route}", recu ${config.maxRequests}).`);
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const key = `sih:rate-limit:${config.route}:${ip}`;
      const decision = await config.limiter.consume(key, config.maxRequests, config.windowSeconds);
      if (!decision.allowed) {
        res.set('Retry-After', String(decision.retryAfterSeconds));
        res.status(429).json({ error: 'too_many_requests' });
        return;
      }
      next();
    })().catch(next);
  };
}
