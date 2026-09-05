import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../src/composition-root.js';
import { createApp, asyncRoute, createErrorHandler } from '../../src/server.js';
import {
  AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS,
  AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS,
} from '../../src/shared-kernel/domain/RateLimitTuning.js';
import type { RateLimitDecision, RateLimiter } from '../../src/shared-kernel/domain/ports/RateLimiter.js';
import { createAuditEntriesRateLimitMiddleware } from '../../src/shared-kernel/infrastructure/AuditEntriesRateLimitMiddleware.js';
import { RedisSessionStore } from '../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { TenantSessionContext } from '../../src/modules/identity/application/ports/SessionStore.js';
import { TenantId } from '../../src/shared-kernel/domain/value-objects/TenantId.js';
import { bearer, correlationId, getRequest, nextLoopbackIp, startTestServer, type TestServerHandle } from './httpTestClient.js';

/**
 * Limitation de debit DEDIEE de `GET /api/v1/audit-entries` (ADR-0011 §2/§4) — mecanisme REEL
 * contre Redis REEL (aucun double en memoire pour les scenarios HTTP, meme discipline que
 * `test/server/rateLimiting.test.ts`) et assertions sur l'ETAT REEL en base pour l'ecriture
 * d'audit (jamais uniquement le code de statut HTTP).
 *
 * Chaque scenario plante sa PROPRE session (via `RedisSessionStore`, meme pattern que
 * `test/audit/integration/auditHttpIsolation.test.ts`) avec un `actorUserId`/`tenantId` ALEATOIRES
 * — l'isolation entre sujets est elle-meme une propriete testee explicitement (D1), mais elle est
 * aussi la condition d'independance de tous les AUTRES scenarios de ce fichier entre eux (le
 * compteur cle sur `actorUserId`, jamais sur l'IP).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Limitation de debit — GET /api/v1/audit-entries, cle par sujet authentifie (ADR-0011 §2/§4)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;
  let sessionStore: RedisSessionStore;

  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    root = buildCompositionRoot();
    handle = await startTestServer(createApp(root));
    sessionStore = new RedisSessionStore(root.redis);
  });

  afterAll(async () => {
    await handle.close();
    await root.shutdown();
  });

  /** Plante une session TENANT reelle en Redis, portant `audit:read`, sans parametre de perimetre. */
  async function plantTenantSession(userId: string, tenantId: string, permissionCodes: readonly string[] = ['audit:read']): Promise<string> {
    const sessionId = randomUUID();
    const session: TenantSessionContext = {
      sessionId,
      kind: 'TENANT',
      userId,
      tenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes,
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt,
    };
    await sessionStore.create(session);
    return sessionId;
  }

  async function countAuditTrailQueried(tenantId: string, actorUserId: string): Promise<number> {
    const tenant = TenantId.create(tenantId).getValue();
    const page = await root.audit.repositories.auditEntries.listForTenant(
      tenant,
      { eventTypes: ['AUDIT_TRAIL_QUERIED'], actorUserId },
      { cursor: null, limit: 200 },
    );
    return page.entries.length;
  }

  async function listDeniedEntries(tenantId: string, actorUserId: string) {
    const tenant = TenantId.create(tenantId).getValue();
    const page = await root.audit.repositories.auditEntries.listForTenant(
      tenant,
      { eventTypes: ['AUDIT_TRAIL_QUERY_DENIED'], actorUserId },
      { cursor: null, limit: 200 },
    );
    return page.entries;
  }

  it(`seuil : les ${AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS} premieres requetes ne recoivent jamais 429, la requete N+1 recoit 429 avec Retry-After nominal`, async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionId = await plantTenantSession(userId, tenantId);

    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const response = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
      expect(response.status).not.toBe(429);
    }
    const rejected = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    expect(rejected.status).toBe(429);
    expect(JSON.parse(rejected.body)).toEqual({ error: 'too_many_requests' });
    expect(rejected.headers['retry-after']).toBe(String(AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS));
  });

  it('preuve directe D1 : deux sujets distincts depuis la MEME IP -> le compteur de A n_affecte jamais B (un 429 ici prouverait une cle IP)', async () => {
    const ip = nextLoopbackIp();
    const userA = randomUUID();
    const tenantA = randomUUID();
    const sessionA = await plantTenantSession(userA, tenantA);
    const userB = randomUUID();
    const tenantB = randomUUID();
    const sessionB = await plantTenantSession(userB, tenantB);

    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionA), localAddress: ip });
    }
    const exhaustedA = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionA), localAddress: ip });
    expect(exhaustedA.status).toBe(429);

    const freshB = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionB), localAddress: ip });
    expect(freshB.status).not.toBe(429);
  });

  it('preuve inverse : le MEME sujet depuis deux IP differentes atteint le 429 au MEME rang que depuis une seule (changer de reseau ne reinitialise jamais le compteur)', async () => {
    const ipA = nextLoopbackIp();
    const ipB = nextLoopbackIp();
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionId = await plantTenantSession(userId, tenantId);

    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const ip = i % 2 === 0 ? ipA : ipB;
      const response = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId), localAddress: ip });
      expect(response.status).not.toBe(429);
    }
    const rejected = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId), localAddress: ipA });
    expect(rejected.status).toBe(429);
  });

  it('deux sessions distinctes du meme compte (deux sessionId, meme actorUserId) partagent le meme compteur : ouvrir une seconde session ne double pas le quota', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionA = await plantTenantSession(userId, tenantId);
    const sessionB = await plantTenantSession(userId, tenantId);

    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const sessionId = i % 2 === 0 ? sessionA : sessionB;
      const response = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
      expect(response.status).not.toBe(429);
    }
    const rejected = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionB) });
    expect(rejected.status).toBe(429);
  });

  it('requetes non authentifiees : MAX+5 requetes sans Authorization -> toutes 401, jamais 429, et le compteur d_un sujet legitime reste intact', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionId = await plantTenantSession(userId, tenantId);

    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS + 5; i += 1) {
      const response = await getRequest(handle.baseUrl, '/api/v1/audit-entries');
      expect(response.status).toBe(401);
    }
    const legit = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    expect(legit.status).not.toBe(429);
  });

  it('le rejet survient AVANT toute lecture PostgreSQL du journal : aucune AUDIT_TRAIL_QUERIED supplementaire, aucun corps de liste renvoye', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionId = await plantTenantSession(userId, tenantId);
    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    }
    const queriedBefore = await countAuditTrailQueried(tenantId, userId);
    const rejected = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    expect(rejected.status).toBe(429);
    expect(rejected.body).not.toContain('entries');
    const queriedAfter = await countAuditTrailQueried(tenantId, userId);
    expect(queriedAfter).toBe(queriedBefore);
  });

  it('aucune cle sans TTL : apres une rafale, la cle sih:rate-limit:audit-entries:<actorUserId> a un TTL > 0', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionId = await plantTenantSession(userId, tenantId);
    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS + 2; i += 1) {
      await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    }
    const matchingKeys = await root.redis.keys(`sih:rate-limit:audit-entries:${userId}`);
    expect(matchingKeys).toHaveLength(1);
    const ttl = await root.redis.ttl(matchingKeys[0] as string);
    expect(ttl).toBeGreaterThan(0);
  });

  it('Retry-After constant : deux rejets 429 observes a des instants differents d_une MEME fenetre portent une valeur STRICTEMENT identique', async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const sessionId = await plantTenantSession(userId, tenantId);
    for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    }
    const first = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    expect(first.status).toBe(429);
    const firstRetryAfter = first.headers['retry-after'];

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const second = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe(firstRetryAfter);
    expect(Number(firstRetryAfter)).toBe(AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS);
  });

  it(
    `concurrence : 2xN requetes simultanees (N=${AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS}) du MEME sujet -> AU PLUS N acceptees`,
    async () => {
      const userId = randomUUID();
      const tenantId = randomUUID();
      const sessionId = await plantTenantSession(userId, tenantId);
      const total = AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS * 2;
      const responses = await Promise.all(
        Array.from({ length: total }, () => getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) })),
      );
      const acceptedCount = responses.filter((r) => r.status !== 429).length;
      const rejectedCount = responses.filter((r) => r.status === 429).length;
      expect(acceptedCount).toBeLessThanOrEqual(AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS);
      expect(acceptedCount + rejectedCount).toBe(total);
    },
    20_000,
  );

  describe('entree d_audit du rejet (ADR-0011 §4)', () => {
    it('sur le premier 429 : exactement une entree AUDIT_TRAIL_QUERY_DENIED/DENIED/AUDIT_TRAIL/RATE_LIMIT_EXCEEDED, imputee au sujet, ecrite dans la chaine du tenant DE L_ACTEUR, avec le correlationId fourni', async () => {
      const userId = randomUUID();
      const tenantId = randomUUID();
      const sessionId = await plantTenantSession(userId, tenantId);
      for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
        await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
      }
      const cid = randomUUID();
      const rejected = await getRequest(handle.baseUrl, '/api/v1/audit-entries', {
        headers: { ...bearer(sessionId), ...correlationId(cid) },
      });
      expect(rejected.status).toBe(429);

      // Ecrite AVANT la reponse : deja visible en base au moment ou ce test interroge la
      // meme base, immediatement apres avoir recu le 429 (aucune attente, aucune relecture
      // differee).
      const entries = await listDeniedEntries(tenantId, userId);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.outcome).toBe('DENIED');
      expect(entry.targetType).toBe('AUDIT_TRAIL');
      expect(entry.reason).toBe('RATE_LIMIT_EXCEEDED');
      expect(entry.actorUserId).toBe(userId);
      expect(entry.tenantId).toBe(tenantId);
      expect(entry.correlationId).toBe(cid);
    });

    it('borne d_amplification : 5 rejets supplementaires dans la MEME fenetre -> AUCUNE nouvelle entree (total inchange)', async () => {
      const userId = randomUUID();
      const tenantId = randomUUID();
      const sessionId = await plantTenantSession(userId, tenantId);
      for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
        await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
      }
      for (let i = 0; i < 6; i += 1) {
        const rejected = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
        expect(rejected.status).toBe(429);
      }
      const entries = await listDeniedEntries(tenantId, userId);
      expect(entries).toHaveLength(1);
    });

    it(
      'une NOUVELLE fenetre produit a nouveau UNE entree (jamais zero, jamais plus d_une par fenetre)',
      async () => {
        const userId = randomUUID();
        const tenantId = randomUUID();
        const sessionId = await plantTenantSession(userId, tenantId);
        for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
          await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
        }
        const firstRejection = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
        expect(firstRejection.status).toBe(429);
        expect(await listDeniedEntries(tenantId, userId)).toHaveLength(1);

        await new Promise((resolve) => setTimeout(resolve, (AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS + 2) * 1000));

        for (let i = 0; i < AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
          await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
        }
        const secondRejection = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
        expect(secondRejection.status).toBe(429);
        expect(await listDeniedEntries(tenantId, userId)).toHaveLength(2);
      },
      (AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS + 10) * 1000,
    );

    it('non-regression du refus d_AUTORISATION : un 403 forbidden continue d_ecrire AUDIT_TRAIL_QUERY_DENIED avec reason: null (distinguable du rejet de debit)', async () => {
      const userId = randomUUID();
      const tenantId = randomUUID();
      const sessionId = await plantTenantSession(userId, tenantId, []); // pas de audit:read

      const response = await getRequest(handle.baseUrl, '/api/v1/audit-entries', { headers: bearer(sessionId) });
      expect(response.status).toBe(403);

      const entries = await listDeniedEntries(tenantId, userId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.reason).toBeNull();
    });
  });

  describe('echec d_ecriture d_audit (double injecte au niveau de la factory — ADR-0011 §4.1)', () => {
    /** Rejette TOUJOURS, en franchissement de seuil, quels que soient les arguments — l'assemblage REEL (buildCompositionRoot) ne permet pas d'injecter un tel double, d'ou une app Express minimale ad hoc (meme pattern que test/server/errorHandler.test.ts). */
    class AlwaysFirstRejectionLimiter implements RateLimiter {
      async consume(): Promise<RateLimitDecision> {
        return Promise.resolve({ allowed: false, retryAfterSeconds: 60, firstRejectionInWindow: true });
      }
    }

    const fakeLogger = { error: (): void => {} };
    const app = express();
    app.get(
      '/test/audit-entries',
      (_req, res, next) => {
        Object.assign(res.locals, { auditPrincipal: { kind: 'PLATFORM', actorUserId: 'fixed-actor' } });
        next();
      },
      createAuditEntriesRateLimitMiddleware<{ actorUserId: string }>({
        limiter: new AlwaysFirstRejectionLimiter(),
        maxRequests: 1,
        windowSeconds: 60,
        getSubject: (res) => (res.locals as { auditPrincipal?: { actorUserId: string } }).auditPrincipal ?? null,
        onFirstRejectionInWindow: async () => {
          throw new Error('audit-write-down-simule');
        },
      }),
      asyncRoute(async (_req, res) => {
        res.status(200).json({ entries: [] });
      }),
    );
    app.use(createErrorHandler(fakeLogger));

    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Adresse de serveur de test inattendue.');
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });

    it('l_echec de l_ecriture d_audit termine la requete en 500 internal_error — jamais 429, jamais de liste servie', async () => {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get(`${baseUrl}/test/audit-entries`, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
          })
          .on('error', reject);
      });
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({ error: 'internal_error' });
      expect(response.body).not.toContain('audit-write-down-simule');
      expect(response.body).not.toContain('entries');
    });
  });
});
