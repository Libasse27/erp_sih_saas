import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FakeRefreshTokenGenerator,
  FakeRefreshTokenHasher,
  FixedClock,
  idFor,
  InMemoryMfaEnrollmentRepository,
  InMemoryRefreshTokenRepository,
  InMemoryRoleRepository,
  InMemorySessionAuditTrail,
  InMemorySessionStore,
  InMemoryTenantAccessChecker,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Role } from '../../domain/Role.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import type { RefreshTokenHash } from '../../domain/value-objects/RefreshTokenHash.js';
import type { RefreshTokenRepository } from '../../domain/ports/RefreshTokenRepository.js';
import { SessionContextIssuer } from '../services/SessionContextIssuer.js';
import { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';
import { RefreshSessionHandler } from './RefreshSession.js';
import type { TenantSessionContext } from '../ports/SessionStore.js';

const TENANT_A = TenantId.create(uuidAt(4001)).getValue();

function permission(code: string): Permission {
  return Permission.create(code).getValue();
}

/** Force le PROCHAIN appel a `tryMarkRotatedIfActive` a echouer (course concurrente perdue), sans toucher a l'etat reel de la ligne — reproduit exactement ce qu'observerait le perdant d'une vraie course Postgres. */
class OnceFailingRotationRepository implements RefreshTokenRepository {
  private failNext = false;

  constructor(private readonly delegate: RefreshTokenRepository) {}

  armNextRotationToFail(): void {
    this.failNext = true;
  }

  findByHash(hash: RefreshTokenHash) {
    return this.delegate.findByHash(hash);
  }

  create(token: Parameters<RefreshTokenRepository['create']>[0]) {
    return this.delegate.create(token);
  }

  async tryMarkRotatedIfActive(hash: RefreshTokenHash, now: Date): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      return false;
    }
    return this.delegate.tryMarkRotatedIfActive(hash, now);
  }

  revokeChain(chainId: string, reason: Parameters<RefreshTokenRepository['revokeChain']>[1], now: Date) {
    return this.delegate.revokeChain(chainId, reason, now);
  }

  revokeChainBySessionId(sessionId: string, reason: Parameters<RefreshTokenRepository['revokeChainBySessionId']>[1], now: Date) {
    return this.delegate.revokeChainBySessionId(sessionId, reason, now);
  }

  revokeAllForUser(userId: string, reason: Parameters<RefreshTokenRepository['revokeAllForUser']>[1], now: Date) {
    return this.delegate.revokeAllForUser(userId, reason, now);
  }

  revokeAllForMembership(membershipId: string, reason: Parameters<RefreshTokenRepository['revokeAllForMembership']>[1], now: Date) {
    return this.delegate.revokeAllForMembership(membershipId, reason, now);
  }
}

describe('RefreshSessionHandler (O-06.5, ADR-0006)', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let tenants: InMemoryTenantAccessChecker;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let auditTrail: InMemorySessionAuditTrail;
  let repository: InMemoryRefreshTokenRepository;
  let rotationRepository: OnceFailingRotationRepository;
  let refreshTokenIssuer: RefreshTokenIssuer;
  let sessionContextIssuer: SessionContextIssuer;
  let handler: RefreshSessionHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let unitOfWork: InMemoryUnitOfWork;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    tenants = new InMemoryTenantAccessChecker();
    tenants.seed(TENANT_A);
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    auditTrail = new InMemorySessionAuditTrail();
    repository = new InMemoryRefreshTokenRepository();
    rotationRepository = new OnceFailingRotationRepository(repository);
    clock = new FixedClock('2026-08-28T00:00:00.000Z');
    idGenerator = new SequentialIdGenerator();
    unitOfWork = new InMemoryUnitOfWork();

    sessionContextIssuer = new SessionContextIssuer(accounts, memberships, roles, tenants, mfaEnrollments, unitOfWork, clock, idGenerator);
    refreshTokenIssuer = new RefreshTokenIssuer(
      rotationRepository,
      new FakeRefreshTokenGenerator(),
      new FakeRefreshTokenHasher(),
      unitOfWork,
      clock,
      idGenerator,
    );
    handler = new RefreshSessionHandler(refreshTokenIssuer, rotationRepository, sessionContextIssuer, sessions, auditTrail, unitOfWork, clock);
  });

  async function seedAccountWithRole(roleCode: string, permissionCode: string): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create(`${roleCode.toLowerCase()}@hopital.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    const role = Role.system({ id: idFor.role(1), code: roleCode, name: roleCode, permissions: [permission(permissionCode)] });
    roles.seed(role);
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_A, createdBy: account.id, initialRoleIds: [role.id], clock, idGenerator }),
      TENANT_A,
    );
    return account;
  }

  async function login(account: UserAccount): Promise<{ session: TenantSessionContext; refreshToken: string }> {
    const result = await sessionContextIssuer.issueForNewContext({ userId: account.id, intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    const session = result.getValue() as TenantSessionContext;
    await sessions.create(session);
    const issued = await refreshTokenIssuer.issueChain(session);
    return { session, refreshToken: issued!.raw };
  }

  it('INVALID_TOKEN pour un refresh token jamais emis — aucune entree d_audit (aucun sujet identifiable)', async () => {
    const result = await handler.execute({ refreshToken: 'jamais-emis' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_TOKEN');
    expect(auditTrail.records).toHaveLength(0);
  });

  it('succes : rotate, ferme l_ancienne session, en cree une nouvelle, audite SESSION_REFRESH_ROTATED', async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { session, refreshToken } = await login(account);

    const result = await handler.execute({ refreshToken });

    expect(result.isSuccess()).toBe(true);
    const { session: newSession, refreshToken: newRefreshToken } = result.getValue();
    expect(newSession.sessionId).not.toBe(session.sessionId);
    expect(newRefreshToken).not.toBe(refreshToken);
    expect(await sessions.get(session.sessionId)).toBeNull();
    expect(await sessions.get(newSession.sessionId)).not.toBeNull();
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SESSION_REFRESH_ROTATED', outcome: 'SUCCESS' });
  });

  it('REUSE_DETECTED : reutiliser un refresh token deja consomme revoque TOUTE la chaine et ferme la session courante, audite DENIED', async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { refreshToken } = await login(account);

    const first = await handler.execute({ refreshToken });
    expect(first.isSuccess()).toBe(true);
    const secondSessionId = first.getValue().session.sessionId;

    const replay = await handler.execute({ refreshToken });
    expect(replay.isFailure()).toBe(true);
    expect(replay.getError()).toBe('REUSE_DETECTED');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SESSION_REFRESH_REUSE_DETECTED', outcome: 'DENIED' });

    // La chaine ENTIERE est revoquee, y compris la session issue de la rotation legitime precedente.
    for (const row of repository.all()) {
      expect(row.status).toBe('REVOKED');
    }
    expect(await sessions.get(secondSessionId)).toBeNull();
  });

  it('ABSOLUTE_CEILING_EXCEEDED : refuse et revoque la chaine (pas un incident de securite) une fois le plafond absolu depasse', async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { refreshToken } = await login(account);

    clock.advanceMs(25 * 60 * 60 * 1000); // TENANT_STANDARD : plafond 24h

    const result = await handler.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('ABSOLUTE_CEILING_EXCEEDED');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SESSION_ABSOLUTE_CEILING_EXCEEDED', outcome: 'FAILURE' });
    expect(repository.all()[0]?.status).toBe('REVOKED');
  });

  it("INACTIVITY_TIMEOUT_EXCEEDED : refuse et revoque la chaine une fois la fenetre d_inactivite depassee (avant le plafond absolu)", async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { refreshToken } = await login(account);

    clock.advanceMs(90 * 60 * 1000); // TENANT_STANDARD : inactivite 1h, plafond 24h

    const result = await handler.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INACTIVITY_TIMEOUT_EXCEEDED');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SESSION_INACTIVITY_TIMEOUT', outcome: 'FAILURE' });
  });

  it('CONTEXT_NO_LONGER_AVAILABLE : refuse et revoque la chaine si le membership a ete revoque depuis l_emission', async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { refreshToken } = await login(account);

    const membership = await memberships.findActiveByUserAndTenant(account.id, TENANT_A);
    membership?.revoke(clock, idGenerator);
    if (membership !== null) {
      await memberships.save(membership, TENANT_A);
    }

    const result = await handler.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('CONTEXT_NO_LONGER_AVAILABLE');
    expect(repository.all()[0]?.status).toBe('REVOKED');
  });

  it("CONTEXT_NO_LONGER_AVAILABLE : refuse et revoque la chaine si le role du membership est monte sous le plancher MFA APRES l'ouverture de la chaine, alors que le second facteur n'a jamais ete prouve (correctif securite, revue independante)", async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { refreshToken } = await login(account);

    const adminRole = Role.system({ id: idFor.role(2), code: 'ADMIN_ETABLISSEMENT', name: 'Admin', permissions: [permission('membership:administer')] });
    roles.seed(adminRole);
    const membership = await memberships.findActiveByUserAndTenant(account.id, TENANT_A);
    membership?.assignRole(adminRole.id, clock, idGenerator);
    if (membership !== null) {
      await memberships.save(membership, TENANT_A);
    }

    const result = await handler.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('CONTEXT_NO_LONGER_AVAILABLE');
    expect(repository.all()[0]?.status).toBe('REVOKED');
  });

  it("CONTEXT_NO_LONGER_AVAILABLE : refuse (fail-CLOSED) si la session Redis d'origine a disparu — ne fabrique JAMAIS mfaSatisfiedAt=null pour laisser passer le renouvellement quand meme (correctif securite, revue independante)", async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { session, refreshToken } = await login(account);

    await sessions.delete(session.sessionId); // simule une eviction/desynchronisation Redis

    const result = await handler.execute({ refreshToken });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('CONTEXT_NO_LONGER_AVAILABLE');
    expect(repository.all()[0]?.status).toBe('REVOKED');
  });

  it('CONCURRENT_REFRESH_CONFLICT : une course perdue sur l_ecriture atomique est un echec PROPRE, sans revocation ni audit SESSION_* (ADR-0006 §5, nuance)', async () => {
    const account = await seedAccountWithRole('MEDECIN', 'patient:read');
    const { refreshToken } = await login(account);

    rotationRepository.armNextRotationToFail();
    const result = await handler.execute({ refreshToken });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('CONCURRENT_REFRESH_CONFLICT');
    expect(auditTrail.records).toHaveLength(0);
    // La ligne d'origine reste ACTIVE : un refresh ulterieur avec le MEME token doit pouvoir reussir.
    expect(repository.all()[0]?.status).toBe('ACTIVE');

    const retry = await handler.execute({ refreshToken });
    expect(retry.isSuccess()).toBe(true);
  });
});
