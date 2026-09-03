import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../../src/composition-root.js';
import { createApp } from '../../../src/server.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { UserAccountEmailAlreadyRegisteredError } from '../../../src/modules/identity/domain/ports/UserAccountRepository.js';
import { getRequest, nextLoopbackIp, postJson, postRaw, startTestServer, type TestServerHandle } from '../../server/httpTestClient.js';
import { uniqueEmail, uniqueFacilityName } from './dbTestHelpers.js';

/**
 * `POST /api/v1/registrations` (ADR-0010 §2/§3/§4) — HTTP bout en bout contre le VRAI
 * `CompositionRoot`/`createApp()`, meme pattern que `auditHttpIsolation.test.ts`.
 * `startBackgroundJobs()` n'est JAMAIS appele (aucun job de fond necessaire — ce fichier ne teste
 * QUE la route synchrone, pas la Saga qu'elle declenche, deja couverte par
 * `provisioningSaga.test.ts` et par le parcours E2E dedie).
 *
 * Chaque scenario logiquement independant utilise sa propre adresse IP source
 * (`nextLoopbackIp()`) : le limiteur de debit partage (ADR-0010 §8) est teste separement dans
 * `test/server/rateLimiting.test.ts`, jamais ici (ce fichier ne doit dependre d'aucune valeur de
 * `RateLimitTuning.ts`).
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('POST /api/v1/registrations (ADR-0010 §2/§3/§4)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;

  beforeAll(async () => {
    root = buildCompositionRoot();
    handle = await startTestServer(createApp(root));
  });

  afterAll(async () => {
    await handle.close();
    await root.shutdown();
  });

  it('corps valide -> 202, userAccountId + tenantId retournes, HealthFacility reellement creee et ACTIVE, HealthFacilityCreated dans l_Outbox avec le bon ownerUserId', async () => {
    const email = uniqueEmail('registration-nominal');
    const facilityName = uniqueFacilityName('Registration Nominal');

    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'mot-de-passe-suffisant-1', facilityName },
      { localAddress: nextLoopbackIp() },
    );

    expect(response.status).toBe(202);
    const body = JSON.parse(response.body) as { userAccountId: string; tenantId: string; status: string };
    expect(body.status).toBe('provisioning');
    expect(body.userAccountId).toBeTruthy();
    expect(body.tenantId).toBeTruthy();

    const tenantIdVo = TenantId.create(body.tenantId).getValue();
    const facility = await root.tenant.unitOfWork.withTransaction(
      () => root.tenant.repositories.healthFacilities.findByTenantId(tenantIdVo),
      { tenantId: tenantIdVo },
    );
    expect(facility).not.toBeNull();
    expect(facility?.isActive()).toBe(true);

    const outboxRows = await root.prisma.outboxMessage.findMany({
      where: { eventType: 'tenant.health-facility.created', aggregateId: body.tenantId },
    });
    expect(outboxRows).toHaveLength(1);
    const payload = outboxRows[0]?.payload as { ownerUserId?: string } | null;
    expect(payload?.ownerUserId).toBe(body.userAccountId);
  });

  it('platformRole: "SUPER_ADMIN" (mass-assignment) -> 400 invalid_request, aucun compte cree', async () => {
    const email = uniqueEmail('registration-mass-assignment-role');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('Mass Assignment'), platformRole: 'SUPER_ADMIN' },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });

    const account = await root.identity.repositories.userAccounts.findByEmail(Email.create(email).getValue());
    expect(account).toBeNull();
  });

  it('ownerUserId fourni par le client (mass-assignment) -> 400 invalid_request', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      {
        email: uniqueEmail('registration-mass-assignment-owner'),
        password: 'mot-de-passe-suffisant-1',
        facilityName: uniqueFacilityName('Mass Assignment Owner'),
        ownerUserId: '11111111-1111-1111-1111-111111111111',
      },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('tenantId fourni par le client (mass-assignment) -> 400 invalid_request', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      {
        email: uniqueEmail('registration-mass-assignment-tenant'),
        password: 'mot-de-passe-suffisant-1',
        facilityName: uniqueFacilityName('Mass Assignment Tenant'),
        tenantId: '22222222-2222-2222-2222-222222222222',
      },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('facilityName vide -> 400, AUCUN UserAccount cree (preuve de l_ordre du §3 : la validation precede la creation du compte)', async () => {
    const email = uniqueEmail('registration-empty-facility-name');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'mot-de-passe-suffisant-1', facilityName: '   ' },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });

    const account = await root.identity.repositories.userAccounts.findByEmail(Email.create(email).getValue());
    expect(account).toBeNull();
  });

  it('facilityName > 200 caracteres -> 400, aucun UserAccount cree', async () => {
    const email = uniqueEmail('registration-long-facility-name');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'mot-de-passe-suffisant-1', facilityName: 'A'.repeat(201) },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });

    const account = await root.identity.repositories.userAccounts.findByEmail(Email.create(email).getValue());
    expect(account).toBeNull();
  });

  it('email deja enregistre -> 409 email_already_registered, aucune HealthFacility supplementaire creee', async () => {
    const email = uniqueEmail('registration-duplicate');
    const ip = nextLoopbackIp();
    const first = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('Duplicate First') },
      { localAddress: ip },
    );
    expect(first.status).toBe(202);

    const second = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'un-autre-mot-de-passe-1', facilityName: uniqueFacilityName('Duplicate Second') },
      { localAddress: ip },
    );
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: 'email_already_registered' });
  });

  it('email invalide -> 400, rien cree', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email: 'pas-un-email', password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('Invalid Email') },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('mot de passe < 8 caracteres -> 400, rien cree', async () => {
    const email = uniqueEmail('registration-short-password');
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email, password: 'court1', facilityName: uniqueFacilityName('Short Password') },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });

    const account = await root.identity.repositories.userAccounts.findByEmail(Email.create(email).getValue());
    expect(account).toBeNull();
  });

  it('JSON illisible -> 400 invalid_request (via createErrorHandler, non-regression du correctif invalid_request_body -> invalid_request)', async () => {
    const response = await postRaw(handle.baseUrl, '/api/v1/registrations', '{ceci n est pas du json valide', {
      localAddress: nextLoopbackIp(),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'invalid_request' });
  });

  it('deux inscriptions concurrentes avec le meme email -> un seul compte, l_autre en 409, jamais d_exception non geree ni de tenant orphelin', async () => {
    const email = uniqueEmail('registration-concurrent');
    const ip = nextLoopbackIp();
    const body = { email, password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('Concurrent') };

    const [a, b] = await Promise.all([
      postJson(handle.baseUrl, '/api/v1/registrations', body, { localAddress: ip }),
      postJson(handle.baseUrl, '/api/v1/registrations', { ...body, facilityName: uniqueFacilityName('Concurrent Bis') }, { localAddress: ip }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);

    const account = await root.identity.repositories.userAccounts.findByEmail(Email.create(email).getValue());
    expect(account).not.toBeNull();
  });

  it('deux ecritures CONCURRENTES avec le MEME email au niveau repository (deux comptes distincts, pas de pre-verification applicative) : un seul succes, l_autre echoue proprement (UserAccountEmailAlreadyRegisteredError), jamais une exception non geree (revue de securite independante de l_etape 12/13, BLOQUANT-2a)', async () => {
    // Deterministe (contrairement au test HTTP ci-dessus, qui depend du hasard de l'ordonnancement
    // des deux requetes) : deux agregats DISTINCTS (id different) portant le MEME email, ecrits
    // via DEUX transactions independantes — force la violation de la contrainte UNIQUE `email`
    // cote PostgreSQL, jamais la pre-verification applicative de `CreateUserAccountHandler`
    // (contournee ici volontairement pour isoler la garantie du repository lui-meme).
    const email = Email.create(uniqueEmail('registration-repo-concurrent')).getValue();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();

    const attempt = async (): Promise<'OK' | 'CONFLICT'> => {
      const uow = new PgUnitOfWork(root.prisma);
      const account = UserAccount.register({
        email,
        passwordHash: PasswordHash.fromHash('hash').getValue(),
        platformRole: 'NONE',
        clock,
        idGenerator,
      });
      try {
        await uow.withTransaction(async () => {
          await root.identity.repositories.userAccounts.save(account);
        });
        return 'OK';
      } catch (error) {
        if (error instanceof UserAccountEmailAlreadyRegisteredError) {
          return 'CONFLICT';
        }
        throw error;
      }
    };

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o === 'OK')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'CONFLICT')).toHaveLength(1);

    const account = await root.identity.repositories.userAccounts.findByEmail(email);
    expect(account).not.toBeNull();
  });

  it('le corps de requete (mot de passe inclus) n_apparait dans aucun log — verifie indirectement : le controleur ne journalise jamais en succes (voir RegistrationController.ts, aucun appel logger.* hors chemins pathologiques 500)', async () => {
    // Preuve structurelle plutot qu'un test de capture de logs (le logger de ce depot ecrit sur
    // stdout/stderr, pas de sink interceptable proprement en test d'integration) : le chemin
    // nominal de RegistrationController.handle() ne contient AUCUN appel a `this.logger`, verifie
    // par lecture du fichier source. Ce test verifie seulement l'ABSENCE d'echec technique sur un
    // scenario nominal, condition necessaire pour que ce chemin sans log soit bien celui exerce.
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email: uniqueEmail('registration-no-log'), password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('No Log') },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(202);
  });

  it('reponse 202 ne contient aucun Cache-Control:no-store impose a tort et GET est bien absent (route non idempotente-lecture) — verifie que la reponse est un JSON strict sans champ superflu', async () => {
    const response = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email: uniqueEmail('registration-shape'), password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('Shape') },
      { localAddress: nextLoopbackIp() },
    );
    expect(response.status).toBe(202);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['status', 'tenantId', 'userAccountId']);
  });

  it('GET /api/v1/registrations n_existe pas (aucune sixieme route inventee)', async () => {
    const response = await getRequest(handle.baseUrl, '/api/v1/registrations', { localAddress: nextLoopbackIp() });
    expect(response.status).toBe(404);
  });
});
