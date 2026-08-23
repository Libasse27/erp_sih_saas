import type { Redis } from 'ioredis';
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

function parseSession(raw: string): SessionContext {
  return JSON.parse(raw) as SessionContext;
}

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(session: SessionContext): Promise<void> {
    const payload = JSON.stringify(session);
    const pipeline = this.redis.pipeline();
    pipeline.set(sessionKey(session.sessionId), payload, 'EX', OPERATIONAL_SAFETY_TTL_SECONDS);
    if (session.kind === 'TENANT') {
      pipeline.sadd(membershipIndexKey(session.membershipId), session.sessionId);
      pipeline.expire(membershipIndexKey(session.membershipId), OPERATIONAL_SAFETY_TTL_SECONDS);
    }
    await pipeline.exec();
  }

  async get(sessionId: string): Promise<SessionContext | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    return raw === null ? null : parseSession(raw);
  }

  async delete(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    await this.redis.del(sessionKey(sessionId));
    if (session !== null && session.kind === 'TENANT') {
      await this.redis.srem(membershipIndexKey(session.membershipId), sessionId);
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
}
