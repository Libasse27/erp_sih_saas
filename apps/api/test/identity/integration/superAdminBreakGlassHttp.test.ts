import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { RedisSessionStore } from '../../../src/modules/identity/infrastructure/session/RedisSessionStore.js';
import type { PlatformSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { MfaEnrollment } from '../../../src/modules/identity/domain/MfaEnrollment.js';
import { SuperAdminBreakGlassRequest } from '../../../src/modules/identity/domain/SuperAdminBreakGlassRequest.js';
import { SuperAdminBreakGlassRequestId } from '../../../src/modules/identity/domain/value-objects/SuperAdminBreakGlassRequestId.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { EncryptedTotpSecret } from '../../../src/modules/identity/domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../../src/modules/identity/domain/value-objects/RecoveryCodeHash.js';
import { createRawPgClient, uniqueEmail } from './dbTestHelpers.js';

/**
 * Integration reelle (PostgreSQL + Redis, bout en bout via le VRAI `CompositionRoot`/`createApp`)
 * du break-glass `SUPER_ADMIN` (ADR-0005 Amendement 1, O-04 residu 4) : la course CONCURRENTE
 * exacte que ni un test en memoire (mono-thread) ni un test au niveau handler seul ne peut
 * reproduire fidelement — deux `SUPER_ADMIN` distincts (C1, C2), tous deux legitimes (aucun n'est
 * A ni B), approuvent la MEME demande `PENDING` en meme temps.
 *
 * Sessions plantees DIRECTEMENT dans Redis via `RedisSessionStore` (meme pattern que
 * auditHttpIsolation.test.ts) pour C1/C2/B (leur existence en tant que compte n'est jamais
 * verifiee par les handlers). Le sujet A et son `MfaEnrollment` ACTIVE sont, eux, de VRAIES lignes
 * Postgres (l'approbation les exige : `UserAccountRepository.isSuperAdmin()`,
 * `MfaEnrollmentRepository.findByUserId()`).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('POST /api/v1/platform/super-admin/break-glass-requests/:requestId/approval — concurrence reelle (ADR-0005 Amendement 1)', () => {
  let root: CompositionRoot;
  let server: http.Server;
  let baseUrl: string;
  let sessionStore: RedisSessionStore;
  let rawClient: Client;
  let subjectAId: UserAccountId;
  let pendingRequestId: string;

  const requesterBId = UserAccountId.create(randomUUID()).getValue();
  const approverC1Id = UserAccountId.create(randomUUID()).getValue();
  const approverC2Id = UserAccountId.create(randomUUID()).getValue();
  const sessionC1 = randomUUID();
  const sessionC2 = randomUUID();

  beforeAll(async () => {
    root = buildCompositionRoot();
    const app = createApp(root);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Adresse de serveur de test inattendue.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    sessionStore = new RedisSessionStore(root.redis);
    rawClient = await createRawPgClient();

    // Sujet A : VRAI compte SUPER_ADMIN Postgres, avec un MfaEnrollment ACTIVE (exige par
    // ApproveSuperAdminBreakGlassHandler.forceReEnrollment).
    const created = await root.identity.handlers.createUserAccount.execute({
      email: uniqueEmail('break-glass-subject'),
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'SUPER_ADMIN',
    });
    if (created.isFailure()) {
      throw new Error(`Echec creation du compte sujet A : ${created.getError()}`);
    }
    subjectAId = UserAccountId.create(created.getValue().userAccountId).getValue();

    const enrollment = MfaEnrollment.start({
      userId: subjectAId,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock: root.clock,
      idGenerator: root.idGenerator,
    });
    enrollment.confirmEnrollment({
      timeStep: 1,
      recoveryCodes: [RecoveryCodeHash.create('v1.p1.h').getValue()],
      clock: root.clock,
      idGenerator: root.idGenerator,
    });
    await root.identity.repositories.mfaEnrollments.save(enrollment);

    // Demande PENDING plantee DIRECTEMENT (equivalent d'un appel deja reussi a
    // RequestSuperAdminBreakGlassHandler, deja couvert par ses propres tests dedies) — ce test
    // cible UNIQUEMENT la course sur l'APPROBATION.
    const requestIdResult = SuperAdminBreakGlassRequestId.create(root.idGenerator.generate());
    if (requestIdResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide (bug de test).');
    }
    const requestResult = SuperAdminBreakGlassRequest.request({
      id: requestIdResult.getValue(),
      requestedByUserId: requesterBId,
      subjectUserAccountId: subjectAId,
      reason: 'perte du telephone du SUPER_ADMIN, identite verifiee hors bande',
      clock: root.clock,
      idGenerator: root.idGenerator,
    });
    if (requestResult.isFailure()) {
      throw new Error('Construction de la demande PENDING invalide (bug de test).');
    }
    await root.identity.repositories.superAdminBreakGlassRequests.save(requestResult.getValue());
    pendingRequestId = requestIdResult.getValue().toString();

    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const platformSession = (sessionId: string, userId: string): PlatformSessionContext => ({
      sessionId,
      kind: 'PLATFORM',
      userId,
      requiresMfa: true,
      mfaSatisfiedAt: now.toISOString(),
      issuedAt: now.toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt,
    });
    await sessionStore.create(platformSession(sessionC1, approverC1Id.toString()));
    await sessionStore.create(platformSession(sessionC2, approverC2Id.toString()));
  });

  afterAll(async () => {
    await sessionStore.delete(sessionC1);
    await sessionStore.delete(sessionC2);
    await rawClient.query('DELETE FROM "platform"."SuperAdminBreakGlassRequest" WHERE id = $1', [pendingRequestId]);
    await rawClient.query('DELETE FROM "platform"."MfaEnrollment" WHERE "user_id" = $1', [subjectAId.toString()]);
    await rawClient.query('DELETE FROM "platform"."UserAccount" WHERE id = $1', [subjectAId.toString()]);
    await rawClient.end();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await root.shutdown();
  });

  function postApproval(sessionId: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/platform/super-admin/break-glass-requests/${pendingRequestId}/approval`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionId}`, 'Content-Type': 'application/json', 'Content-Length': '2' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
  }

  it(
    'deux SUPER_ADMIN distincts (C1, C2), tous deux legitimes, approuvent la MEME demande PENDING en meme temps : ' +
      'un seul 200 (approuve), l_autre 409 (conflict/REQUEST_NOT_PENDING) — jamais deux succes, jamais une exception non geree (500)',
    async () => {
      const [resultC1, resultC2] = await Promise.all([postApproval(sessionC1), postApproval(sessionC2)]);
      const outcomes = [resultC1, resultC2];

      const successes = outcomes.filter((r) => r.status === 200);
      const conflicts = outcomes.filter((r) => r.status === 409);
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(JSON.parse(successes[0]?.body ?? '{}')).toEqual({ status: 'approved' });
      expect(JSON.parse(conflicts[0]?.body ?? '{}')).toEqual({ error: 'conflict' });
      // Aucune reponse serveur (aucune exception non geree ne devant jamais atteindre le client).
      expect(outcomes.every((r) => r.status < 500)).toBe(true);

      // Etat final Postgres : UN SEUL approbateur retenu (C1 OU C2, jamais les deux, jamais aucun).
      const row = await rawClient.query<{ status: string; approved_by_user_id: string | null }>(
        'SELECT status, approved_by_user_id FROM "platform"."SuperAdminBreakGlassRequest" WHERE id = $1',
        [pendingRequestId],
      );
      expect(row.rows[0]?.status).toBe('APPROVED');
      expect([approverC1Id.toString(), approverC2Id.toString()]).toContain(row.rows[0]?.approved_by_user_id);

      // Le re-enrolement force n'a ete applique QU'UNE SEULE FOIS (pas de double effet de bord).
      const enrollmentRow = await rawClient.query<{ status: string }>(
        'SELECT status FROM "platform"."MfaEnrollment" WHERE user_id = $1',
        [subjectAId.toString()],
      );
      expect(enrollmentRow.rows[0]?.status).toBe('RESET_REQUIRED');
    },
  );
});
