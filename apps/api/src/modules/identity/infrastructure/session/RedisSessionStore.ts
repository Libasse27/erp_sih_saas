import type { Redis } from 'ioredis';
import { MFA_PENDING_SESSION_WINDOW_SECONDS } from '../../domain/MfaTuning.js';
import { resolveSessionDurationPolicy } from '../../domain/SessionDurationTuning.js';
import type { SessionContext, SessionStore } from '../../application/ports/SessionStore.js';

/**
 * TTL d'hygiene des cles d'INDEX (SET Redis `sih:session-index:*`) uniquement — PAS la duree
 * d'une session individuelle (voir `ttlSecondsFor` pour celle-ci, differenciee par categorie
 * depuis l'etape 8/13). Un index peut legitimement contenir des `sessionId` dont la cle
 * individuelle a deja expire (nettoyage paresseux, sans consequence : `get()`/`delete()` ne
 * lisent jamais l'index comme source de verite sur la validite d'une session) ; cette TTL evite
 * seulement l'accumulation indefinie de l'index lui-meme si plus aucune session n'est jamais
 * recreee pour ce membership/utilisateur. Valeur volontairement large et fixe (pas une politique
 * O-06 opposable).
 */
const INDEX_KEY_HYGIENE_TTL_SECONDS = 7 * 24 * 60 * 60;

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
 * TTL effective selon le type de session. Une session `MFA_PENDING` porte une fenetre de
 * challenge COURTE et NON NEGOCIABLE (`MFA_PENDING_SESSION_WINDOW_SECONDS`, ADR-0005 §4).
 *
 * Une session complete (etape 8/13, ADR-0006 §2/§3) utilise `min(secondes jusqu'a
 * absoluteExpiresAt, inactivitySeconds de sa categorie)` : le plafond absolu de la CHAINE
 * (transporte tel quel sur `session.absoluteExpiresAt`, jamais recalcule ici) prime TOUJOURS sur
 * la fenetre d'inactivite de la categorie — sans ce plafonnement, la DERNIERE session emise juste
 * avant l'atteinte du plafond resterait exploitable en Redis jusqu'a une fenetre d'inactivite
 * COMPLETE supplementaire, en violation directe d'O-06.1. Un plafond deja depasse au moment de
 * l'appel (horloge desynchronisee, appel tardif) produit une TTL d'AU MOINS 1 seconde plutot
 * qu'une valeur nulle ou negative : Redis `SET ... EX 0`/negatif est une erreur de commande, pas
 * une expiration immediate.
 *
 * LIMITE HONNETE (revue independante, etape 8/13) : a ce jour, cette TTL EST le seul mecanisme qui
 * applique le plafond absolu d'une session DEJA EMISE — `ServerContextResolver.resolve()` ne relit
 * ni `absoluteExpiresAt` ni `mfaSatisfiedAt`, il ne discrimine que sur `session.kind`. Ce n'est pas
 * un contournement identifie (aucune rotation ne peut etendre `absoluteExpiresAt`, voir
 * `RefreshToken.issueRotated`), mais une absence de redondance applicative : la duree de vie
 * repose entierement sur une propriete d'infrastructure (persistance Redis, politique
 * d'eviction, horloge serveur). Ajouter un controle explicite dans `ServerContextResolver` (comparer
 * `absoluteExpiresAt` a `clock.now()`) fermerait cet ecart, mais exigerait d'y injecter un `Clock`
 * — changement delibere non fait dans cette etape pour ne pas alourdir ce chemin chaud deja
 * lourdement teste (ADR-0006, alternative 4 ecartee) ; a reconsiderer si un besoin de defense en
 * profondeur explicite se confirme.
 */
function ttlSecondsFor(session: SessionContext): number {
  if (session.kind === 'MFA_PENDING') {
    return MFA_PENDING_SESSION_WINDOW_SECONDS;
  }
  const policy = resolveSessionDurationPolicy(session.sensitivityCategory);
  const secondsUntilAbsoluteCeiling = Math.floor((new Date(session.absoluteExpiresAt).getTime() - Date.now()) / 1000);
  return Math.max(1, Math.min(policy.inactivitySeconds, secondsUntilAbsoluteCeiling));
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
      pipeline.expire(membershipIndexKey(session.membershipId), INDEX_KEY_HYGIENE_TTL_SECONDS);
    }
    // Index par utilisateur (etape 7/13) : alimente pour TOUTES les variantes (PLATFORM, TENANT,
    // MFA_PENDING) — `deleteAllForUser` (ForceMfaReEnrollment) doit pouvoir couper une session
    // MFA_PENDING encore ouverte aussi bien qu'une session complete.
    pipeline.sadd(userIndexKey(session.userId), session.sessionId);
    pipeline.expire(userIndexKey(session.userId), INDEX_KEY_HYGIENE_TTL_SECONDS);
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
