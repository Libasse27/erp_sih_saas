import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryMembershipAuditTrail,
  InMemorySessionStore,
  InMemoryTenantAccessChecker,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  SequentialIdGenerator,
  idFor,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { TenantAdminRecoveryRequest } from '../../domain/TenantAdminRecoveryRequest.js';
import type { TenantAdminRecoveryRequestRepository } from '../../domain/ports/TenantAdminRecoveryRequestRepository.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { TenantAdminRecoveryRequestId } from '../../domain/value-objects/TenantAdminRecoveryRequestId.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlatformSessionContext } from '../ports/SessionStore.js';
import { RequestTenantAdminRecoveryHandler } from './RequestTenantAdminRecovery.js';

const TENANT_ID = uuidAt(8201);
const REQUESTER_ID = idFor.userAccount(8203);

class InMemoryTenantAdminRecoveryRequests implements TenantAdminRecoveryRequestRepository {
  readonly byId = new Map<string, TenantAdminRecoveryRequest>();

  async save(request: TenantAdminRecoveryRequest): Promise<boolean> {
    const id = request.id.toString();
    if (this.byId.has(id)) return false;
    this.byId.set(id, request);
    return true;
  }

  async findById(id: TenantAdminRecoveryRequestId): Promise<TenantAdminRecoveryRequest | null> {
    return this.byId.get(id.toString()) ?? null;
  }
}

describe('RequestTenantAdminRecoveryHandler', () => {
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;
  let sessions: InMemorySessionStore;
  let userAccounts: InMemoryUserAccountRepository;
  let tenantAccessChecker: InMemoryTenantAccessChecker;
  let requests: InMemoryTenantAdminRecoveryRequests;
  let audit: InMemoryMembershipAuditTrail;
  let handler: RequestTenantAdminRecoveryHandler;
  let beneficiaryUserId: string;

  beforeEach(async () => {
    clock = new FixedClock('2026-09-29T12:00:00Z');
    idGenerator = new SequentialIdGenerator();
    sessions = new InMemorySessionStore();
    userAccounts = new InMemoryUserAccountRepository();
    tenantAccessChecker = new InMemoryTenantAccessChecker();
    tenantAccessChecker.seed(TenantId.create(TENANT_ID).getValue());
    requests = new InMemoryTenantAdminRecoveryRequests();
    audit = new InMemoryMembershipAuditTrail();
    handler = new RequestTenantAdminRecoveryHandler(
      sessions,
      userAccounts,
      tenantAccessChecker,
      requests,
      audit,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
    const beneficiary = UserAccount.register({
      email: Email.create('beneficiaire-request@hopital-test.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await userAccounts.save(beneficiary);
    beneficiaryUserId = beneficiary.id.toString();
  });

  async function addPlatformSession(mfaSatisfiedAt: string | null): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId: 'platform-requester',
      kind: 'PLATFORM',
      userId: REQUESTER_ID.toString(),
      requiresMfa: true,
      mfaSatisfiedAt,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('crée une demande PENDING et journalise le demandeur plateforme', async () => {
    const sessionId = await addPlatformSession(clock.now().toISOString());
    const result = await handler.execute({
      tenantId: TENANT_ID,
      beneficiaryUserId,
      actorSessionId: sessionId,
      reason: 'Récupération demandée.',
    });

    expect(result.isSuccess()).toBe(true);
    expect(requests.byId.get(result.getValue().requestId)?.status).toBe('PENDING');
    expect(audit.records.at(-1)).toMatchObject({
      eventType: 'TENANT_ADMIN_RECOVERY_REQUESTED',
      outcome: 'SUCCESS',
      actorKind: 'USER_PLATFORM',
      actorUserId: REQUESTER_ID.toString(),
      subjectUserId: beneficiaryUserId,
    });
  });

  it('refuse une demande depuis une session PLATFORM sans MFA', async () => {
    const sessionId = await addPlatformSession(null);
    const result = await handler.execute({
      tenantId: TENANT_ID,
      beneficiaryUserId,
      actorSessionId: sessionId,
      reason: 'Récupération demandée.',
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
    expect(requests.byId.size).toBe(0);
    expect(audit.records.at(-1)).toMatchObject({ eventType: 'TENANT_ADMIN_RECOVERY_REQUESTED', outcome: 'DENIED' });
  });
});
