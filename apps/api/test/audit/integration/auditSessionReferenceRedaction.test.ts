import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { TenantSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { createTestPrismaClient } from './dbTestHelpers.js';

/**
 * Non-reutilisabilite de la reference de session (ADR-0009 §3.1/§10, correctif securite CRITIQUE
 * 2026-09-01). Trois assertions, la troisieme etant la SEULE qui prouve reellement la propriete
 * recherchee :
 *   1. apres une ouverture de contexte (`SESSION_CONTEXT_OPENED`) et un rafraichissement
 *      (`SESSION_REFRESH_ROTATED`), AUCUNE entree persistee (colonne `session_id`) ni AUCUNE
 *      reponse HTTP ne contient le `sessionId` REEL ;
 *   2. la valeur lue EGALE la derivation attendue du `sessionId` connu — correlation B1 preservee
 *      (deux entrees de la MEME session portent la MEME reference) ;
 *   3. la valeur lue, REJOUEE en `Authorization: Bearer`, produit `401` — JAMAIS `200`.
 *
 * Construit le VRAI `CompositionRoot` (meme pattern qu'`auditHttpIsolation.test.ts`) : ce test
 * cible le middleware d'authentification ET le controleur REELS, bout en bout — c'est precisement
 * ce qui permet a l'assertion 3 de constituer une preuve reelle (le rejeu passe par le MEME
 * `ServerContextResolver.resolve()` que n'importe quel appel authentifie du depot).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('AuditEntry — sessionRef non reutilisable comme jeton de session (ADR-0009 §3.1/§10)', () => {
  let root: CompositionRoot;
  let server: http.Server;
  let baseUrl: string;
  let sessionStore: RedisSessionStore;
  let prisma: ReturnType<typeof createTestPrismaClient>;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const rawSessionId = randomUUID();

  /**
   * Calcule INDEPENDAMMENT (ne reutilise pas `Sha256AuditSessionReferenceDeriver`, precisement
   * pour ne pas se contenter d'une coherence interne) la reference attendue selon la formule
   * DECIDEE par l'ADR (§3.1) : `"v1." + base64url(SHA-256("audit-session:v1|" + sessionId))`.
   */
  function expectedSessionRef(sessionId: string): string {
    const digest = createHash('sha256').update(`audit-session:v1|${sessionId}`, 'utf8').digest();
    return `v1.${digest.toString('base64url')}`;
  }

  beforeAll(async () => {
    root = buildCompositionRoot();
    prisma = createTestPrismaClient();
    const app = createApp(root);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Adresse de serveur de test inattendue.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    sessionStore = new RedisSessionStore(root.redis);

    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const tenantSession: TenantSessionContext = {
      sessionId: rawSessionId,
      kind: 'TENANT',
      userId,
      tenantId,
      membershipId: randomUUID(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['audit:read'],
      requiresMfa: false,
      mfaSatisfiedAt: null,
      issuedAt: now.toISOString(),
      sensitivityCategory: 'TENANT_STANDARD',
      absoluteExpiresAt,
    };
    await sessionStore.create(tenantSession);

    // Deux entrees REELLES de la MEME session (ouverture de contexte PUIS rafraichissement),
    // ecrites via le service `recordEntry` REEL du module `audit` — SEUL point de derivation
    // (`AuditEntry.record()`) — jamais reimplemente dans ce test.
    await root.identity.unitOfWork.withTransaction(async () => {
      await root.audit.services.recordEntry({
        category: 'SESSION',
        eventType: 'SESSION_CONTEXT_OPENED',
        outcome: 'SUCCESS',
        tenantId,
        actorKind: 'USER_TENANT',
        actorUserId: userId,
        actorRoleCodes: ['ADMIN_ETABLISSEMENT'],
        subjectUserId: userId,
        targetType: 'USER_ACCOUNT',
        targetId: userId,
        reason: null,
        sessionId: rawSessionId,
        correlationId: null,
      });
    });
    await root.identity.unitOfWork.withTransaction(async () => {
      await root.audit.services.recordEntry({
        category: 'SESSION',
        eventType: 'SESSION_REFRESH_ROTATED',
        outcome: 'SUCCESS',
        tenantId,
        actorKind: 'USER_TENANT',
        actorUserId: userId,
        actorRoleCodes: ['ADMIN_ETABLISSEMENT'],
        subjectUserId: userId,
        targetType: 'USER_ACCOUNT',
        targetId: userId,
        reason: null,
        sessionId: rawSessionId,
        correlationId: null,
      });
    });
  });

  afterAll(async () => {
    await sessionStore.delete(rawSessionId);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
    await root.shutdown();
  });

  function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${path}`, { headers }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        })
        .on('error', reject);
    });
  }

  function bearer(sessionId: string): Record<string, string> {
    return { Authorization: `Bearer ${sessionId}` };
  }

  it(
    'assertion 1+2 : la colonne session_id EN BASE ne contient JAMAIS le sessionId reel, ' +
      'porte la derivation attendue, et CORRELE les deux entrees de la meme session',
    async () => {
      const rows = await prisma.auditEntry.findMany({
        where: { subjectUserId: userId, eventType: { in: ['SESSION_CONTEXT_OPENED', 'SESSION_REFRESH_ROTATED'] } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(rows).toHaveLength(2);

      const expected = expectedSessionRef(rawSessionId);
      for (const row of rows) {
        expect(row.sessionId).not.toBeNull();
        expect(row.sessionId).not.toBe(rawSessionId);
        expect(row.sessionId).toBe(expected);
      }
      // Corrélation B1 : les DEUX entrées de la même session portent la MEME référence.
      expect(rows[0]?.sessionId).toBe(rows[1]?.sessionId);
    },
  );

  it(
    'assertion 1+2 : la reponse HTTP (DTO `sessionRef`) ne contient JAMAIS le sessionId reel, ' +
      'porte la derivation attendue, jamais un champ `sessionId`',
    async () => {
      const response = await get(`/api/v1/audit-entries?subjectUserId=${userId}&limit=200`, bearer(rawSessionId));
      expect(response.status).toBe(200);
      expect(response.body).not.toContain(rawSessionId);

      const parsed = JSON.parse(response.body) as {
        entries: Array<{ eventType: string; sessionRef: string | null; sessionId?: string }>;
      };
      const sessionEntries = parsed.entries.filter(
        (entry) => entry.eventType === 'SESSION_CONTEXT_OPENED' || entry.eventType === 'SESSION_REFRESH_ROTATED',
      );
      expect(sessionEntries.length).toBeGreaterThanOrEqual(2);

      const expected = expectedSessionRef(rawSessionId);
      for (const entry of sessionEntries) {
        expect(entry.sessionId).toBeUndefined();
        expect(entry.sessionRef).toBe(expected);
      }
    },
  );

  it(
    'assertion 3 (PREUVE REELLE) : la valeur lue, REJOUEE en Authorization: Bearer, produit 401 — jamais 200',
    async () => {
      const expected = expectedSessionRef(rawSessionId);

      // Verification prealable, non negociable pour que cette assertion ait un sens : la VRAIE
      // session, elle, fonctionne bien (sinon "401 sur la reference" ne prouverait rien).
      const withRealSession = await get('/api/v1/audit-entries', bearer(rawSessionId));
      expect(withRealSession.status).toBe(200);

      const replay = await get('/api/v1/audit-entries', bearer(expected));
      expect(replay.status).toBe(401);
      expect(JSON.parse(replay.body)).toEqual({ error: 'unauthenticated' });
    },
  );
});
