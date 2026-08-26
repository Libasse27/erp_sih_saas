import type { Redis } from 'ioredis';
import { MFA_PENDING_SESSION_WINDOW_SECONDS } from '../../domain/MfaTuning.js';
import type { SessionContext, SessionStore } from '../../application/ports/SessionStore.js';

/**
 * Garde-fou technique d'hygiene Redis — PAS la politique de duree de session O-06 (dont les
 * valeurs numeriques par categorie restent un residu explicite non tranche, voir
 * docs/architecture/03-open-decisions.md O-06). Cette TTL n'exprime aucune duree de session
 * opposable ; elle evite seulement l'accumulation indefinie de cles orphelines si une session
 * n'est jamais fermee explicitement. A remplacer par l'expiration differenciee par categorie
 * lors de l'etape "Sessions avancees" (Phase 0, etape 8) — cette classe n'a pas besoin d'etre
 * reecrite pour cela, seule la valeur de la TTL et son calcul par categorie changeront.
 */
const OPERATIONAL_SAFETY_TTL_SECONDS = 24 * 60 * 60;

function sessionKey(sessionId: string): string {
  return `sih:session:${sessionId}`;
}

function membershipIndexKey(membershipId: string): string {
  return `sih:session-index:membership:${membershipId}`;
}

function userIndexKey(userId: string): string {
  return `sih:session-index:user:${userId}`;
}

function parseSession(raw: string): SessionContext {
  return JSON.parse(raw) as SessionContext;
}

/**
 * TTL effective selon le type de session (etape 7/13, ADR-0005 §4) : une session `MFA_PENDING`
 * porte une fenetre de challenge COURTE et NON NEGOCIABLE
 * (`MFA_PENDING_SESSION_WINDOW_SECONDS`) — jamais la TTL d'hygiene generique de 24h, qui laisserait
 * une intention deja validee serveur exploitable bien au-dela de la fenetre de second facteur
 * documentee par l'ADR. Les sessions completes conservent la TTL d'hygiene inchangee.
 */
function ttlSecondsFor(session: SessionContext): number {
  return session.kind === 'MFA_PENDING' ? MFA_PENDING_SESSION_WINDOW_SECONDS : OPERATIONAL_SAFETY_TTL_SECONDS;
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(session: SessionContext): Promise<void> {
    const payload = JSON.stringify(session);
    const ttlSeconds = ttlSecondsFor(session);
    const pipeline = this.redis.pipeline();
    pipeline.set(sessionKey(session.sessionId), payload, 'EX', ttlSeconds);
    if (session.kind === 'TENANT') {
      pipeline.sadd(membershipIndexKey(session.membershipId), session.sessionId);
      pipeline.expire(membershipIndexKey(session.membershipId), OPERATIONAL_SAFETY_TTL_SECONDS);
    }
    // Index par utilisateur (etape 7/13) : alimente pour TOUTES les variantes (PLATFORM, TENANT,
    // MFA_PENDING) — `deleteAllForUser` (ForceMfaReEnrollment) doit pouvoir couper une session
    // MFA_PENDING encore ouverte aussi bien qu'une session complete.
    pipeline.sadd(userIndexKey(session.userId), session.sessionId);
    pipeline.expire(userIndexKey(session.userId), OPERATIONAL_SAFETY_TTL_SECONDS);
    await pipeline.exec();
  }

  async get(sessionId: string): Promise<SessionContext | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    return raw === null ? null : parseSession(raw);
  }

  async delete(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    await this.redis.del(sessionKey(sessionId));
    if (session !== null) {
      if (session.kind === 'TENANT') {
        await this.redis.srem(membershipIndexKey(session.membershipId), sessionId);
      }
      await this.redis.srem(userIndexKey(session.userId), sessionId);
    }
  }

  async deleteAllForMembership(membershipId: string): Promise<void> {
    const key = membershipIndexKey(membershipId);
    const sessionIds = await this.redis.smembers(key);
    const pipeline = this.redis.pipeline();
    for (const sessionId of sessionIds) {
      pipeline.del(sessionKey(sessionId));
    }
    pipeline.del(key);
    await pipeline.exec();
  }

  async deleteAllForUser(userId: string): Promise<void> {
    const key = userIndexKey(userId);
    const sessionIds = await this.redis.smembers(key);
    const pipeline = this.redis.pipeline();
    for (const sessionId of sessionIds) {
      pipeline.del(sessionKey(sessionId));
    }
    pipeline.del(key);
    await pipeline.exec();
  }
}
