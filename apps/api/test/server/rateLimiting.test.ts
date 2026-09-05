import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../src/composition-root.js';
import { createApp } from '../../src/server.js';
import {
  REGISTRATION_RATE_LIMIT_MAX_REQUESTS,
  REGISTRATION_RATE_LIMIT_WINDOW_SECONDS,
  LOGIN_RATE_LIMIT_MAX_REQUESTS,
  MFA_ROUTES_RATE_LIMIT_MAX_REQUESTS,
} from '../../src/shared-kernel/domain/RateLimitTuning.js';
import { Email } from '../../src/modules/identity/domain/value-objects/Email.js';
import { bearer, correlationId, nextLoopbackIp, postJson, postRaw, startTestServer, type TestServerHandle } from './httpTestClient.js';
import { uniqueEmail, uniqueFacilityName } from '../identity/integration/dbTestHelpers.js';

function registrationBody(prefix: string): { email: string; password: string; facilityName: string } {
  return { email: uniqueEmail(prefix), password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName(prefix) };
}

/**
 * Limiteur de debit PARTAGE des cinq routes pre-authentification (ADR-0010 §8/§12 point 4) —
 * mecanisme REEL contre Redis REEL (aucun double en memoire : c'est l'atomicite de la primitive
 * Redis elle-meme qui est eprouvee, jamais celle du middleware seul — voir "Tests attendus").
 *
 * La majorite des scenarios ci-dessous ciblent `POST /api/v1/registrations` (le mecanisme est
 * IDENTIQUE sur les cinq routes — meme classe `RedisRateLimiter`, meme middleware factory,
 * seul le segment `<route>` de la cle et les constantes de `RateLimitTuning.ts` different) ; deux
 * scenarios dedies verifient explicitement `POST /api/v1/auth/sessions` (non-contournement par
 * `context.tenantId`) et les trois routes MFA (compteur reellement PARTAGE entre elles, meme
 * middleware `rateLimitMfa` monte trois fois — voir composition-root.ts).
 *
 * Chaque scenario utilise sa PROPRE adresse IP source (`nextLoopbackIp()`) — l'isolation entre IP
 * est elle-meme une propriete testee explicitement, mais elle est aussi la condition
 * d'independance de tous les AUTRES scenarios de ce fichier entre eux.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Limitation de debit partagee (ADR-0010 §8)', () => {
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

  it(`seuil : les ${REGISTRATION_RATE_LIMIT_MAX_REQUESTS} premieres requetes passent, la requete N+1 recoit 429 avec Retry-After`, async () => {
    const ip = nextLoopbackIp();
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const response = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-threshold'), { localAddress: ip });
      expect(response.status).not.toBe(429);
    }
    const rejected = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-threshold'), { localAddress: ip });
    expect(rejected.status).toBe(429);
    expect(JSON.parse(rejected.body)).toEqual({ error: 'too_many_requests' });
    expect(rejected.headers['retry-after']).toBe(String(REGISTRATION_RATE_LIMIT_WINDOW_SECONDS));
  });

  it('isolation entre IP : une IP differente n_est jamais affectee par le compteur d_une autre', async () => {
    const ipA = nextLoopbackIp();
    const ipB = nextLoopbackIp();
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-isolation-a'), { localAddress: ipA });
    }
    const exhaustedA = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-isolation-a'), { localAddress: ipA });
    expect(exhaustedA.status).toBe(429);

    const freshB = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-isolation-b'), { localAddress: ipB });
    expect(freshB.status).not.toBe(429);
  });

  it(
    `concurrence : 2xN requetes simultanees (N=${REGISTRATION_RATE_LIMIT_MAX_REQUESTS}) depuis la meme IP -> AU PLUS N acceptees, aucune course ne permet de depasser le seuil`,
    async () => {
      const ip = nextLoopbackIp();
      const total = REGISTRATION_RATE_LIMIT_MAX_REQUESTS * 2;
      const responses = await Promise.all(
        Array.from({ length: total }, (_, i) => postJson(handle.baseUrl, '/api/v1/registrations', registrationBody(`rate-limit-concurrency-${i}`), { localAddress: ip })),
      );
      const acceptedCount = responses.filter((r) => r.status !== 429).length;
      const rejectedCount = responses.filter((r) => r.status === 429).length;
      expect(acceptedCount).toBeLessThanOrEqual(REGISTRATION_RATE_LIMIT_MAX_REQUESTS);
      expect(acceptedCount + rejectedCount).toBe(total);
    },
    20_000,
  );

  it('non-contournement par changement de CORPS (email/facilityName varies a CHAQUE requete) sur /registrations -> 429 au meme rang que sans variation', async () => {
    const ip = nextLoopbackIp();
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const response = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody(`rate-limit-body-variation-${i}`), { localAddress: ip });
      expect(response.status).not.toBe(429);
    }
    const rejectedEmail = uniqueEmail('rate-limit-body-variation-rejected');
    const rejected = await postJson(
      handle.baseUrl,
      '/api/v1/registrations',
      { email: rejectedEmail, password: 'mot-de-passe-suffisant-1', facilityName: uniqueFacilityName('rate-limit-body-variation-rejected') },
      { localAddress: ip },
    );
    expect(rejected.status).toBe(429);

    // Preuve directe : le rejet survient AVANT tout acces PostgreSQL du controleur — aucun
    // UserAccount n'a ete cree pour cet email pourtant unique.
    const account = await root.identity.repositories.userAccounts.findByEmail(Email.create(rejectedEmail).getValue());
    expect(account).toBeNull();
  });

  it('non-contournement par changement de context.tenantId (existants/inexistants/malformes melanges) sur /auth/sessions -> 429 au meme rang que sans variation', async () => {
    const ip = nextLoopbackIp();
    const tenantIdVariants = ['11111111-1111-1111-1111-111111111111', 'pas-un-uuid', '22222222-2222-2222-2222-222222222222', 'encore-invalide'];
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const variant = tenantIdVariants[i % tenantIdVariants.length];
      const response = await postJson(
        handle.baseUrl,
        '/api/v1/auth/sessions',
        { email: uniqueEmail('rate-limit-login-variation'), password: 'peu-importe-1', context: { kind: 'TENANT', tenantId: variant } },
        { localAddress: ip },
      );
      expect(response.status).not.toBe(429);
    }
    const rejected = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions',
      { email: uniqueEmail('rate-limit-login-variation'), password: 'peu-importe-1', context: { kind: 'TENANT', tenantId: '33333333-3333-3333-3333-333333333333' } },
      { localAddress: ip },
    );
    expect(rejected.status).toBe(429);
  });

  it('les TROIS routes MFA partagent REELLEMENT le meme compteur (meme middleware `rateLimitMfa` monte trois fois, ADR-0010 §8/§9)', async () => {
    const ip = nextLoopbackIp();
    // Melange delibere entre les DEUX routes MFA les plus faciles a appeler sans etat prealable
    // (aucune ne necessite un Bearer valide pour ETRE COMPTEE : le rejet 429 survient AVANT toute
    // lecture de session, seul le comptage nous interesse ici).
    let lastStatus = 0;
    for (let i = 0; i < MFA_ROUTES_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const path = i % 2 === 0 ? '/api/v1/auth/mfa/enrollment' : '/api/v1/auth/mfa/enrollment/confirmation';
      const body = i % 2 === 0 ? undefined : { totpCode: '000000' };
      const response = await postJson(handle.baseUrl, path, body, { localAddress: ip, headers: bearer('inconnu') });
      lastStatus = response.status;
      expect(response.status).not.toBe(429);
    }
    expect(lastStatus).toBe(401); // confirme que le compteur monte bien AU-DELA du controleur (401 attendu, pas une erreur de test)

    // La requete N+1, sur la TROISIEME route MFA (jamais appelee jusqu'ici dans ce test), est
    // DEJA rejetee -> preuve que le compteur est bien PARTAGE entre les trois routes.
    const rejected = await postJson(
      handle.baseUrl,
      '/api/v1/auth/sessions/mfa-challenge',
      { factor: { kind: 'TOTP', code: '000000' } },
      { localAddress: ip, headers: bearer('inconnu') },
    );
    expect(rejected.status).toBe(429);
  });

  it('aucune entree d_audit n_est ecrite sur un rejet 429', async () => {
    const ip = nextLoopbackIp();
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-no-audit'), { localAddress: ip });
    }
    // `X-Correlation-Id` UNIQUE a la SEULE requete rejetee de ce scenario (jamais reutilise
    // ailleurs) : le delta est ainsi borne au PERIMETRE EXACT de ce scenario, jamais un `count()`
    // GLOBAL sur toute la table `AuditEntry` — celui-ci collisionne avec
    // `auditEntriesRateLimiting.test.ts`, qui ecrit plusieurs centaines d'entrees `AUDIT_TRAIL_QUERIED`
    // en parallele sur la meme base de test partagee (ADR-0011 Amendement 1, BLOQUANT-2). La
    // requete rejetee ne peut de toute facon jamais atteindre le controleur (le limiteur est monte
    // en PREMIER middleware, avant `express.json()`), donc aucune entree ne peut porter ce
    // correlationId : le compte doit rester `0` avant ET apres, quel que soit ce qui se passe en
    // parallele dans d'autres fichiers de test.
    const scenarioCorrelationId = `rate-limit-no-audit-${randomUUID()}`;
    const countBefore = await root.prisma.auditEntry.count({ where: { correlationId: scenarioCorrelationId } });
    const rejected = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-no-audit'), {
      localAddress: ip,
      headers: correlationId(scenarioCorrelationId),
    });
    expect(rejected.status).toBe(429);
    const countAfter = await root.prisma.auditEntry.count({ where: { correlationId: scenarioCorrelationId } });
    expect(countAfter).toBe(countBefore);
  });

  it('un corps JSON illisible est compte par le limiteur, PAS contourne (le limiteur est monte avant express.json(), non-regression BLOQUANT-3)', async () => {
    const ip = nextLoopbackIp();
    // `REGISTRATION_RATE_LIMIT_MAX_REQUESTS` corps ILLISIBLES depuis la MEME IP : chacun echoue en
    // 400 (via createErrorHandler/express.json), mais DOIT quand meme incrementer le compteur —
    // sans quoi un attaquant contournerait totalement la limitation en envoyant `{` comme corps.
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const malformed = await postRaw(handle.baseUrl, '/api/v1/registrations', '{ceci n est pas du json valide', { localAddress: ip });
      expect(malformed.status).toBe(400);
    }
    // La requete N+1, cette fois avec un corps VALIDE, doit deja etre rejetee : preuve que les
    // corps illisibles precedents ont bien ete comptabilises.
    const rejected = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-malformed-body'), { localAddress: ip });
    expect(rejected.status).toBe(429);
  });

  it('aucune cle sans TTL : apres une rafale, toute cle sih:rate-limit:* presente en Redis a un TTL > 0', async () => {
    const ip = nextLoopbackIp();
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS + 2; i += 1) {
      await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-ttl'), { localAddress: ip });
    }
    // Cle recherchee par MOTIF (jamais construite en dur avec `ip`) : le serveur de test ecoute
    // sur un socket dual-stack (`app.listen(0)`), et `req.ip` pour une connexion IPv4 y est donc
    // rapporte au format IPv4-mappe-IPv6 (`::ffff:<ip>`), pas en notation decimale pointee — un
    // bug de CE TEST (pas du mecanisme de limitation) construisait auparavant une cle qui ne
    // correspondait jamais a la cle reellement posee par le middleware (`ttl` retournait `-2`,
    // c'est-a-dire "cle absente", alors que le mecanisme fonctionnait correctement).
    const matchingKeys = await root.redis.keys(`sih:rate-limit:registrations:*${ip}`);
    expect(matchingKeys).toHaveLength(1);
    const ttl = await root.redis.ttl(matchingKeys[0] as string);
    expect(ttl).toBeGreaterThan(0);
  });

  it('Retry-After constant : deux rejets 429 observes a des instants differents d_une MEME fenetre portent une valeur STRICTEMENT identique', async () => {
    const ip = nextLoopbackIp();
    for (let i = 0; i < REGISTRATION_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-retry-after-constant'), { localAddress: ip });
    }
    const firstRejection = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-retry-after-constant'), { localAddress: ip });
    expect(firstRejection.status).toBe(429);
    const firstRetryAfter = firstRejection.headers['retry-after'];

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const secondRejection = await postJson(handle.baseUrl, '/api/v1/registrations', registrationBody('rate-limit-retry-after-constant'), { localAddress: ip });
    expect(secondRejection.status).toBe(429);
    const secondRetryAfter = secondRejection.headers['retry-after'];

    expect(secondRetryAfter).toBe(firstRetryAfter);
    expect(Number(firstRetryAfter)).toBe(REGISTRATION_RATE_LIMIT_WINDOW_SECONDS);
  });
});
