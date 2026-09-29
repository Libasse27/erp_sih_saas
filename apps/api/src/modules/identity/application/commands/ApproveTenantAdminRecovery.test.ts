import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryMembershipAuditTrail,
  InMemoryRoleRepository,
  InMemorySessionStore,
  InMemoryTenantAccessChecker,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  idFor,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Role } from '../../domain/Role.js';
import { TenantAdminRecoveryRequest } from '../../domain/TenantAdminRecoveryRequest.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import type { TenantAdminRecoveryRequestRepository } from '../../domain/ports/TenantAdminRecoveryRequestRepository.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { TenantAdminRecoveryRequestId } from '../../domain/value-objects/TenantAdminRecoveryRequestId.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { RoleId } from '../../domain/value-objects/RoleId.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { ApproveTenantAdminRecoveryHandler } from './ApproveTenantAdminRecovery.js';

const TENANT_ID = uuidAt(8101);
const REQUEST_ID = uuidAt(8102);
const REQUESTER_ID = idFor.userAccount(8103);
const APPROVER_ID = idFor.userAccount(8104);
const ADMIN_ROLE_ID = RoleId.create(uuidAt(8105)).getValue();
const MEMBERSHIP_ADMIN = Permission.create('membership:administer').getValue();

class InMemoryTenantAdminRecoveryRequests implements TenantAdminRecoveryRequestRepository {
  private readonly requests = new Map<string, TenantAdminRecoveryRequest>();
  private readonly persistedStatus = new Map<string, 'PENDING' | 'APPROVED'>();

  async save(request: TenantAdminRecoveryRequest): Promise<boolean> {
    const id = request.id.toString();
    if (!this.requests.has(id)) {
      this.requests.set(id, request);
      this.persistedStatus.set(id, request.status);
      return true;
    }
    if (this.persistedStatus.get(id) !== 'PENDING' || request.status !== 'APPROVED') return false;
    this.requests.set(id, request);
    this.persistedStatus.set(id, 'APPROVED');
    return true;
  }

  async findById(id: TenantAdminRecoveryRequestId): Promise<TenantAdminRecoveryRequest | null> {
    return this.requests.get(id.toString()) ?? null;
  }
}

describe('ApproveTenantAdminRecoveryHandler', () => {
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let sessions: InMemorySessionStore;
  let userAccounts: InMemoryUserAccountRepository;
  let tenantAccessChecker: InMemoryTenantAccessChecker;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let audit: InMemoryMembershipAuditTrail;
  let requests: InMemoryTenantAdminRecoveryRequests;
  let handler: ApproveTenantAdminRecoveryHandler;
  let beneficiary: UserAccount;

  beforeEach(async () => {
    clock = new FixedClock('2026-09-29T12:00:00Z');
    idGenerator = new SequentialIdGenerator();
    sessions = new InMemorySessionStore();
    userAccounts = new InMemoryUserAccountRepository();
    tenantAccessChecker = new InMemoryTenantAccessChecker();
    tenantAccessChecker.seed(TenantId.create(TENANT_ID).getValue());
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    audit = new InMemoryMembershipAuditTrail();
    requests = new InMemoryTenantAdminRecoveryRequests();
    const adminRole = Role.system({
      id: ADMIN_ROLE_ID,
      code: 'ADMIN_ETABLISSEMENT',
      name: 'Administrateur établissement',
      permissions: [MEMBERSHIP_ADMIN],
    });
    roles.seed(adminRole);
    handler = new ApproveTenantAdminRecoveryHandler(
      sessions,
      requests,
      userAccounts,
      tenantAccessChecker,
      memberships,
      roles,
      audit,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
    beneficiary = UserAccount.register({
      email: Email.create('beneficiaire@hopital-test.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await userAccounts.save(beneficiary);
    const requestId = TenantAdminRecoveryRequestId.create(REQUEST_ID).getValue();
    const request = TenantAdminRecoveryRequest.request({
      id: requestId,
      tenantId: TenantId.create(TENANT_ID).getValue(),
      beneficiaryUserId: beneficiary.id,
      requestedByUserId: REQUESTER_ID,
      reason: 'Vérification de la demande de récupération.',
      clock,
    }).getValue();
    await requests.save(request);
  });

  async function seedPlatformSession(userId: string, mfaSatisfiedAt: string | null = clock.now().toISOString()): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId: `session-${userId}`,
      kind: 'PLATFORM',
      userId,
      requiresMfa: true,
      mfaSatisfiedAt,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('refuse que le demandeur approuve sa propre demande', async () => {
    const sessionId = await seedPlatformSession(REQUESTER_ID.toString());
    const result = await handler.execute({ requestId: REQUEST_ID, actorSessionId: sessionId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('CANNOT_APPROVE_OWN_REQUEST');
    expect(audit.records.at(-1)).toMatchObject({ eventType: 'TENANT_ADMIN_RECOVERY_APPROVED', outcome: 'DENIED' });
  });

  it('refuse un tenant où un rôle personnalisé porte déjà membership:administer', async () => {
    const tenantId = TenantId.create(TENANT_ID).getValue();
    const customRoleId = RoleId.create(uuidAt(8106)).getValue();
    roles.seed(Role.custom({
      id: customRoleId,
      code: 'CUSTOM_ACCESS_MANAGER',
      name: 'Gestionnaire personnalisé',
      tenantId,
      permissions: [MEMBERSHIP_ADMIN],
      allowedByPlan: [MEMBERSHIP_ADMIN],
    }));
    const existingAdmin = UserAccount.register({
      email: Email.create('admin-existant@hopital-test.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await userAccounts.save(existingAdmin);
    const membership = UserTenantMembership.grant({
      userId: existingAdmin.id,
      tenantId,
      createdBy: existingAdmin.id,
      initialRoleIds: [customRoleId],
      clock,
      idGenerator,
    });
    await memberships.save(membership, tenantId);

    const sessionId = await seedPlatformSession(APPROVER_ID.toString());
    const result = await handler.execute({ requestId: REQUEST_ID, actorSessionId: sessionId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('TENANT_ALREADY_HAS_ADMIN');
    expect(audit.records.at(-1)).toMatchObject({ eventType: 'TENANT_ADMIN_RECOVERY_APPROVED', outcome: 'DENIED' });
    expect((await requests.findById(TenantAdminRecoveryRequestId.create(REQUEST_ID).getValue()))?.status).toBe('PENDING');
  });

  it('attribue le rôle d’administration et audite l’approbation en succès quand le tenant n’a aucun admin', async () => {
    const sessionId = await seedPlatformSession(APPROVER_ID.toString());
    const result = await handler.execute({ requestId: REQUEST_ID, actorSessionId: sessionId });

    expect(result.isSuccess()).toBe(true);
    const membership = await memberships.findActiveByUserAndTenant(beneficiary.id, TenantId.create(TENANT_ID).getValue());
    expect(membership?.roleIds.map((roleId) => roleId.toString())).toContain(ADMIN_ROLE_ID.toString());
    expect(audit.records.map((record) => record.eventType)).toContain('TENANT_ADMIN_RECOVERY_APPROVED');
    expect(audit.records.at(-1)).toMatchObject({ eventType: 'MEMBERSHIP_GRANTED', outcome: 'SUCCESS' });
  });

  it('refuse une session PLATFORM sans preuve MFA récente', async () => {
    const sessionId = await seedPlatformSession(APPROVER_ID.toString(), null);
    const result = await handler.execute({ requestId: REQUEST_ID, actorSessionId: sessionId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
    expect(audit.records.at(-1)).toMatchObject({ eventType: 'TENANT_ADMIN_RECOVERY_APPROVED', outcome: 'DENIED' });
  });

  it('refuse une session TENANT, même si son MFA est satisfaite', async () => {
    const session: TenantSessionContext = {
      sessionId: 'tenant-session',
      kind: 'TENANT',
      userId: APPROVER_ID.toString(),
      tenantId: TENANT_ID,
      membershipId: uuidAt(8107),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['membership:administer'],
      requiresMfa: true,
      mfaSatisfiedAt: clock.now().toISOString(),
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'TENANT_MFA_REQUIRED',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);

    const result = await handler.execute({ requestId: REQUEST_ID, actorSessionId: session.sessionId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
    expect(audit.records.at(-1)).toMatchObject({ outcome: 'DENIED', actorKind: 'USER_TENANT', tenantId: TENANT_ID });
  });
});
