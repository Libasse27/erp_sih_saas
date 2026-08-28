import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeRefreshTokenGenerator,
  FakeRefreshTokenHasher,
  FixedClock,
  InMemoryRefreshTokenRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import type { PlatformSessionContext, TenantSessionContext, MfaPendingSessionContext } from '../ports/SessionStore.js';
import { RefreshTokenIssuer } from './RefreshTokenIssuer.js';

function platformSession(overrides: Partial<PlatformSessionContext> = {}): PlatformSessionContext {
  return {
    sessionId: 'session-platform-1',
    kind: 'PLATFORM',
    userId: uuidAt(1),
    requiresMfa: true,
    mfaSatisfiedAt: '2026-08-28T00:00:00.000Z',
    issuedAt: '2026-08-28T00:00:00.000Z',
    sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
    absoluteExpiresAt: '2026-08-28T08:00:00.000Z',
    ...overrides,
  };
}

function tenantSession(overrides: Partial<TenantSessionContext> = {}): TenantSessionContext {
  return {
    sessionId: 'session-tenant-1',
    kind: 'TENANT',
    userId: uuidAt(2),
    tenantId: uuidAt(9001),
    membershipId: uuidAt(9002),
    roleCodes: ['MEDECIN'],
    permissionCodes: ['patient:read'],
    requiresMfa: false,
    mfaSatisfiedAt: null,
    issuedAt: '2026-08-28T00:00:00.000Z',
    sensitivityCategory: 'TENANT_STANDARD',
    absoluteExpiresAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

function mfaPendingSession(): MfaPendingSessionContext {
  return {
    sessionId: 'session-pending-1',
    kind: 'MFA_PENDING',
    userId: uuidAt(3),
    intent: { kind: 'PLATFORM' },
    reason: 'CHALLENGE_REQUIRED',
    auditRoleCodes: [],
    issuedAt: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-08-28T00:05:00.000Z',
  };
}

describe('RefreshTokenIssuer (ADR-0006 §5-§6)', () => {
  let repository: InMemoryRefreshTokenRepository;
  let clock: FixedClock;
  let issuer: RefreshTokenIssuer;

  beforeEach(() => {
    repository = new InMemoryRefreshTokenRepository();
    clock = new FixedClock('2026-08-28T00:00:00.000Z');
    issuer = new RefreshTokenIssuer(
      repository,
      new FakeRefreshTokenGenerator(),
      new FakeRefreshTokenHasher(),
      new InMemoryUnitOfWork(),
      clock,
      new SequentialIdGenerator(),
    );
  });

  it('issueChain retourne null pour une session MFA_PENDING — aucune chaine ne doit jamais en etre issue (ADR-0006 §7)', async () => {
    const result = await issuer.issueChain(mfaPendingSession());
    expect(result).toBeNull();
    expect(repository.all()).toHaveLength(0);
  });

  it('issueChain persiste une nouvelle chaine ACTIVE pour une session TENANT complete', async () => {
    const session = tenantSession();
    const result = await issuer.issueChain(session);
    expect(result).not.toBeNull();

    const [record] = repository.all();
    expect(record?.status).toBe('ACTIVE');
    expect(record?.userId.toString()).toBe(session.userId);
    expect(record?.tenantId?.toString()).toBe(session.tenantId);
    expect(record?.membershipId).toBe(session.membershipId);
    expect(record?.sensitivityCategory).toBe('TENANT_STANDARD');
    expect(record?.sessionId).toBe(session.sessionId);
  });

  it('issueChain persiste tenantId=null pour une session PLATFORM', async () => {
    await issuer.issueChain(platformSession());
    const [record] = repository.all();
    expect(record?.tenantId).toBeNull();
    expect(record?.membershipId).toBeNull();
    expect(record?.sensitivityCategory).toBe('PLATFORM_SUPER_ADMIN');
  });

  it('validateForRotation : NOT_FOUND pour un token jamais emis', async () => {
    const outcome = await issuer.validateForRotation('jamais-emis');
    expect(outcome.kind).toBe('NOT_FOUND');
  });

  it('validateForRotation : VALID pour une chaine active dans les deux fenetres', async () => {
    const issued = await issuer.issueChain(tenantSession());
    const outcome = await issuer.validateForRotation(issued!.raw);
    expect(outcome.kind).toBe('VALID');
  });

  it('validateForRotation : REUSE_DETECTED pour un token deja ROTATED (rejeu)', async () => {
    const issued = await issuer.issueChain(tenantSession());
    const [record] = repository.all();
    record?.markRotated();

    const outcome = await issuer.validateForRotation(issued!.raw);
    expect(outcome.kind).toBe('REUSE_DETECTED');
  });

  it("validateForRotation : CHAIN_ALREADY_REVOKED (pas REUSE_DETECTED) pour un token dont la chaine a deja ete fermee pour une raison benigne (logout, etc.) — evite de qualifier chaque tentative post-logout d'attaque", async () => {
    const issued = await issuer.issueChain(tenantSession());
    const [record] = repository.all();
    record?.markRevoked('LOGOUT', clock.now());

    const outcome = await issuer.validateForRotation(issued!.raw);
    expect(outcome.kind).toBe('CHAIN_ALREADY_REVOKED');
  });

  it('validateForRotation : ABSOLUTE_CEILING_EXCEEDED apres le plafond absolu de la categorie (TENANT_STANDARD : 24h)', async () => {
    const issued = await issuer.issueChain(tenantSession());
    clock.advanceMs(25 * 60 * 60 * 1000);

    const outcome = await issuer.validateForRotation(issued!.raw);
    expect(outcome.kind).toBe('ABSOLUTE_CEILING_EXCEEDED');
  });

  it("validateForRotation : INACTIVITY_TIMEOUT_EXCEEDED apres la fenetre d_inactivite (TENANT_STANDARD : 1h) mais AVANT le plafond absolu", async () => {
    const issued = await issuer.issueChain(tenantSession());
    clock.advanceMs(90 * 60 * 1000); // 1h30 : > inactivite (1h), < plafond absolu (24h)

    const outcome = await issuer.validateForRotation(issued!.raw);
    expect(outcome.kind).toBe('INACTIVITY_TIMEOUT_EXCEEDED');
  });

  it('completeRotation : succes — cree une nouvelle generation dans la MEME chaine et marque la precedente ROTATED', async () => {
    const issued = await issuer.issueChain(tenantSession());
    const validation = await issuer.validateForRotation(issued!.raw);
    if (validation.kind !== 'VALID') throw new Error('setup invalide');

    const rotated = await issuer.completeRotation({ previous: validation.record, newSessionId: 'session-tenant-2' });
    expect(rotated).not.toBeNull();

    const all = repository.all();
    expect(all).toHaveLength(2);
    const [oldRow, newRow] = all;
    expect(oldRow?.status).toBe('ROTATED');
    expect(newRow?.status).toBe('ACTIVE');
    expect(newRow?.chainId).toBe(oldRow?.chainId);
    expect(newRow?.previousTokenId).toBe(oldRow?.id.toString());
    // Le plafond absolu de la chaine ne doit JAMAIS changer d'une generation a l'autre.
    expect(newRow?.absoluteExpiresAt).toEqual(oldRow?.absoluteExpiresAt);
  });

  it("completeRotation : retourne null (course concurrente perdue) si la ligne n_est deja plus ACTIVE au moment de l_ecriture — PAS une reutilisation, la chaine reste intacte", async () => {
    const issued = await issuer.issueChain(tenantSession());
    const validation = await issuer.validateForRotation(issued!.raw);
    if (validation.kind !== 'VALID') throw new Error('setup invalide');

    // Simule une rotation CONCURRENTE deja gagnee par un autre appel entre la validation et cet appel.
    const [record] = repository.all();
    record?.markRotated();

    const rotated = await issuer.completeRotation({ previous: validation.record, newSessionId: 'session-tenant-2' });
    expect(rotated).toBeNull();
    // Aucune ligne supplementaire n'a ete creee : la tentative perdante n'a rien pollue.
    expect(repository.all()).toHaveLength(1);
  });

  it('revokeChain revoque toutes les lignes de la chaine (les deux generations apres une rotation)', async () => {
    const issued = await issuer.issueChain(tenantSession());
    const validation = await issuer.validateForRotation(issued!.raw);
    if (validation.kind !== 'VALID') throw new Error('setup invalide');
    await issuer.completeRotation({ previous: validation.record, newSessionId: 'session-tenant-2' });

    const [oldRow] = repository.all();
    await issuer.revokeChain(oldRow!.chainId, 'LOGOUT');

    for (const row of repository.all()) {
      expect(row.status).toBe('REVOKED');
    }
  });

  it('revokeChainBySessionId retrouve la chaine via le sessionId courant et la revoque', async () => {
    const session = tenantSession();
    await issuer.issueChain(session);

    await issuer.revokeChainBySessionId(session.sessionId, 'LOGOUT');

    expect(repository.all()[0]?.status).toBe('REVOKED');
  });

  it('revokeAllForMembership revoque toutes les chaines du membership, jamais celles d_un autre', async () => {
    const sessionA = tenantSession({ sessionId: 's-a', membershipId: uuidAt(5001) });
    const sessionB = tenantSession({ sessionId: 's-b', membershipId: uuidAt(5002) });
    await issuer.issueChain(sessionA);
    await issuer.issueChain(sessionB);

    await issuer.revokeAllForMembership(uuidAt(5001), 'MEMBERSHIP_REVOKED');

    const byMembership = new Map(repository.all().map((row) => [row.membershipId, row.status]));
    expect(byMembership.get(uuidAt(5001))).toBe('REVOKED');
    expect(byMembership.get(uuidAt(5002))).toBe('ACTIVE');
  });
});
