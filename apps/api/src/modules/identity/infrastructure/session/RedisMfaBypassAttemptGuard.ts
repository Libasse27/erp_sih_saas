import type { Redis } from 'ioredis';
import type { MfaBypassAttemptGuard } from '../../application/ports/MfaBypassAttemptGuard.js';

function bypassAttemptKey(sessionId: string): string {
  return `sih:mfa-bypass-attempt:${sessionId}`;
}

/**
 * Implementation Redis de `MfaBypassAttemptGuard` (ADR-0005 §4) : `SET NX EX` — atomique,
 * la PREMIERE requete pour un `sessionId` donne pose la cle et recoit `true` (l'appelant doit
 * alors enregistrer l'entree d'audit) ; toute requete suivante dans la meme fenetre recoit
 * `false` (cle deja posee) sans reecrire l'entree d'audit.
 */
export class RedisMfaBypassAttemptGuard implements MfaBypassAttemptGuard {
  constructor(private readonly redis: Redis) {}

  async tryMark(sessionId: string, windowSeconds: number): Promise<boolean> {
    const result = await this.redis.set(bypassAttemptKey(sessionId), '1', 'EX', windowSeconds, 'NX');
    return result === 'OK';
  }
}
