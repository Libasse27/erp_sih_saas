import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemorySessionStore,
  InMemorySuperAdminBreakGlassRequestRepository,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  mustFail,
  SequentialIdGenerator,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { SuperAdminBreakGlassRequestId } from '../../domain/value-objects/SuperAdminBreakGlassRequestId.js';
import type { PlatformSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { RequestSuperAdminBreakGlassHandler } from './RequestSuperAdminBreakGlass.js';

describe('RequestSuperAdminBreakGlassHandler (ADR-0005 Amendement 1, O-04 residu 4)', () => {
  let accounts: InMemoryUserAccountRepository;
  let breakGlassRequests: InMemorySuperAdminBreakGlassRequestRepository;
  let sessions: InMemorySessionStore;
  let auditTrail: InMemoryAuditTrail;
  let handler: RequestSuperAdminBreakGlassHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    breakGlassRequests = new InMemorySuperAdminBreakGlassRequestRepository();
    sessions = new InMemorySessionStore();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-09-03T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new RequestSuperAdminBreakGlassHandler(sessions, accounts, breakGlassRequests, auditTrail, new InMemoryUnitOfWork(), clock, idGenerator);
  });

  async function registerAccount(platformRole: 'SUPER_ADMIN' | 'NONE'): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create(`u${Date.now()}${Math.random()}@hopital.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole,
      clock,
      idGenerator,
    });
    await accounts.save(account);
    return account;
  }

  async function seedPlatformActorSession(mfaSatisfiedAt: string | null, userId?: string): Promise<string> {
    const session: PlatformSessionContext = {
      sessionId: 'platform-actor-session',
      kind: 'PLATFORM',
      userId: userId ?? idFor.userAccount(998).toString(),
      requiresMfa: true,
      mfaSatisfiedAt,
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'PLATFORM_SUPER_ADMIN',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  async function seedTenantActorSession(): Promise<string> {
    const session: TenantSessionContext = {
      sessionId: 'tenant-actor-session',
      kind: 'TENANT',
      userId: idFor.userAccount(997).toString(),
      tenantId: idFor.userAccount(1).toString(),
      membershipId: idFor.membership(1).toString(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['mfa:reset'],
      requiresMfa: true,
      mfaSatisfiedAt: clock.now().toISOString(),
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'TENANT_MFA_REQUIRED',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('SESSION_NOT_FOUND', async () => {
    const subject = await registerAccount('SUPER_ADMIN');
    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId: 'inconnue', reason: 'motif' });
    expect(mustFail(result)).toBe('SESSION_NOT_FOUND');
  });

  it("FORBIDDEN (isolation tenant) : une session TENANT, meme avec des permissions elevees (mfa:reset, ADMIN_ETABLISSEMENT), ne peut JAMAIS initier un break-glass — seule une session PLATFORM le peut", async () => {
    const subject = await registerAccount('SUPER_ADMIN');
    const actorSessionId = await seedTenantActorSession();

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'tentative illegitime' });

    expect(mustFail(result)).toBe('FORBIDDEN');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({
      eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED',
      outcome: 'DENIED',
      // Attribution du VRAI tenant/roles de l'acteur (correctif MAJEUR-2, jamais null/[] en dur).
      tenantId: idFor.userAccount(1).toString(),
      actorRoleCodes: ['ADMIN_ETABLISSEMENT'],
    });
  });

  it('FORBIDDEN : acteur PLATFORM sans step-up MFA (mfaSatisfiedAt null)', async () => {
    const subject = await registerAccount('SUPER_ADMIN');
    const actorSessionId = await seedPlatformActorSession(null);

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'motif' });

    expect(mustFail(result)).toBe('FORBIDDEN');
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED', outcome: 'DENIED' });
  });

  it('REASON_REQUIRED : audite quand meme un echec (motif vide apres trim)', async () => {
    const subject = await registerAccount('SUPER_ADMIN');
    const actorSessionId = await seedPlatformActorSession(clock.now().toISOString());

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: '   ' });

    expect(mustFail(result)).toBe('REASON_REQUIRED');
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED', outcome: 'FAILURE' });
  });

  it('SUBJECT_NOT_FOUND', async () => {
    const actorSessionId = await seedPlatformActorSession(clock.now().toISOString());
    const result = await handler.execute({ subjectUserAccountId: idFor.userAccount(555).toString(), actorSessionId, reason: 'motif valide' });
    expect(mustFail(result)).toBe('SUBJECT_NOT_FOUND');
  });

  it('SUBJECT_NOT_SUPER_ADMIN : le sujet existe mais ne porte pas le role SUPER_ADMIN (ForceMfaReEnrollment existe deja pour ce cas)', async () => {
    const actorSessionId = await seedPlatformActorSession(clock.now().toISOString());
    const subject = await registerAccount('NONE');

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'motif valide' });

    expect(mustFail(result)).toBe('SUBJECT_NOT_SUPER_ADMIN');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED', outcome: 'DENIED' });
  });

  it('CANNOT_TARGET_SELF (defense en profondeur domaine) : A ne peut pas se demander sa propre recuperation', async () => {
    const subject = await registerAccount('SUPER_ADMIN');
    const actorSessionId = await seedPlatformActorSession(clock.now().toISOString(), subject.id.toString());

    const result = await handler.execute({ subjectUserAccountId: subject.id.toString(), actorSessionId, reason: 'auto-demande illegitime' });

    expect(mustFail(result)).toBe('CANNOT_TARGET_SELF');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED', outcome: 'DENIED' });
  });

  it('succes : cree une demande PENDING, audite SUCCESS avec le motif, retourne requestId', async () => {
    const subject = await registerAccount('SUPER_ADMIN');
    const actorSessionId = await seedPlatformActorSession(clock.now().toISOString());

    const result = await handler.execute({
      subjectUserAccountId: subject.id.toString(),
      actorSessionId,
      reason: 'perte du telephone du SUPER_ADMIN, identite verifiee hors bande',
    });

    expect(result.isSuccess()).toBe(true);
    const { requestId } = result.getValue();
    expect(requestId).toBeTruthy();

    const stored = await breakGlassRequests.findById(SuperAdminBreakGlassRequestId.create(requestId).getValue());
    expect(stored?.status).toBe('PENDING');
    expect(stored?.subjectUserAccountId.toString()).toBe(subject.id.toString());

    expect(auditTrail.records[0]).toMatchObject({
      eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED',
      outcome: 'SUCCESS',
      reason: 'perte du telephone du SUPER_ADMIN, identite verifiee hors bande',
    });
  });
});
