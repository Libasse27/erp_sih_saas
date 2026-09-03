import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeTotpService,
  FixedClock,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  SequentialIdGenerator,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import type { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { MfaEnrollmentConcurrencyConflictError } from '../../domain/ports/MfaEnrollmentRepository.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import type { MfaPendingSessionContext, TenantSessionContext } from '../ports/SessionStore.js';
import { StartMfaEnrollmentHandler } from './StartMfaEnrollment.js';

/**
 * Double qui simule EXACTEMENT ce que `PrismaMfaEnrollmentRepository.save()` fait sur une
 * violation de la contrainte UNIQUE `userId` lors d'un TOUT PREMIER enrolement concurrent (revue
 * de securite independante de l'etape 12/13, BLOQUANT-2b/AC-F) : la premiere ecriture pour un
 * `userId` donne echoue avec `MfaEnrollmentConcurrencyConflictError`, comme si un AUTRE writer
 * venait de gagner la course. Delegue ensuite normalement (une seule injection de panne).
 */
class ConflictOnFirstSaveMfaEnrollmentRepository extends InMemoryMfaEnrollmentRepository {
  private hasThrown = false;

  override async save(enrollment: MfaEnrollment): Promise<void> {
    if (!this.hasThrown) {
      this.hasThrown = true;
      throw new MfaEnrollmentConcurrencyConflictError('injection de test : course concurrente simulee sur le premier enrolement');
    }
    await super.save(enrollment);
  }
}

describe('StartMfaEnrollmentHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let mfaEnrollments: InMemoryMfaEnrollmentRepository;
  let sessions: InMemorySessionStore;
  let totpService: FakeTotpService;
  let auditTrail: InMemoryAuditTrail;
  let handler: StartMfaEnrollmentHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    sessions = new InMemorySessionStore();
    totpService = new FakeTotpService();
    auditTrail = new InMemoryAuditTrail();
    clock = new FixedClock('2026-08-26T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new StartMfaEnrollmentHandler(
      sessions,
      accounts,
      mfaEnrollments,
      totpService,
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function registerAccount(): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create('user@hopital.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    return account;
  }

  async function seedPendingEnrollmentSession(userId: string, sessionId = 's1'): Promise<string> {
    const session: MfaPendingSessionContext = {
      sessionId,
      kind: 'MFA_PENDING',
      userId,
      intent: { kind: 'PLATFORM' },
      reason: 'ENROLLMENT_REQUIRED',
      auditRoleCodes: [],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    await sessions.create(session);
    return session.sessionId;
  }

  it('provisionne un nouveau facteur et audite le succes', async () => {
    const account = await registerAccount();
    const sessionId = await seedPendingEnrollmentSession(account.id.toString());

    const result = await handler.execute({ sessionId });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().provisioningUri).toContain('otpauth://');
    const enrollment = await mfaEnrollments.findByUserId(account.id);
    expect(enrollment?.status).toBe('PENDING_ACTIVATION');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_ENROLLMENT_STARTED', outcome: 'SUCCESS' });
  });

  it('SESSION_NOT_FOUND', async () => {
    const result = await handler.execute({ sessionId: 'inconnue' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('SESSION_NOT_FOUND');
    expect(auditTrail.records).toHaveLength(0);
  });

  it(
    'SESSION_NOT_PENDING_ENROLLMENT (F-2) : une session deja complete (TENANT) ne peut pas etre utilisee pour demarrer un enrolement au nom d_un autre compte',
    async () => {
      const victim = await registerAccount();
      const attackerSession: TenantSessionContext = {
        sessionId: 'attacker-session',
        kind: 'TENANT',
        userId: 'attacker-user-id-not-victim',
        tenantId: '00000000-0000-4000-8000-000000000001',
        membershipId: '00000000-0000-4000-8000-000000000002',
        roleCodes: [],
        permissionCodes: [],
        requiresMfa: false,
        mfaSatisfiedAt: null,
        issuedAt: clock.now().toISOString(),
        sensitivityCategory: 'TENANT_STANDARD',
        absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
      };
      await sessions.create(attackerSession);

      const result = await handler.execute({ sessionId: attackerSession.sessionId });

      expect(result.isFailure()).toBe(true);
      expect(result.getError()).toBe('SESSION_NOT_PENDING_ENROLLMENT');
      // Aucun enrolement n'a ete cree pour le compte victime : la session utilisee n'etait pas
      // la sienne (elle ne pointe meme pas vers son userId) — la preuve la plus directe que
      // `userAccountId` n'est plus une entree falsifiable par l'appelant (F-2).
      expect(await mfaEnrollments.findByUserId(victim.id)).toBeNull();
      expect(auditTrail.records).toHaveLength(0);
    },
  );

  it('ACCOUNT_NOT_FOUND : audite quand meme un echec', async () => {
    const sessionId = await seedPendingEnrollmentSession('00000000-0000-4000-8000-000000000fff');
    const result = await handler.execute({ sessionId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('ACCOUNT_NOT_FOUND');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({ eventType: 'MFA_ENROLLMENT_STARTED', outcome: 'FAILURE' });
  });

  it('refuse de remplacer un facteur deja ACTIVE (ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE)', async () => {
    const account = await registerAccount();
    const firstSessionId = await seedPendingEnrollmentSession(account.id.toString(), 's1');
    const first = await handler.execute({ sessionId: firstSessionId });
    const enrollment = await mfaEnrollments.findByUserId(account.id);
    expect(enrollment).not.toBeNull();
    const confirmResult = enrollment?.confirmEnrollment({
      timeStep: 1,
      recoveryCodes: [],
      clock,
      idGenerator,
    });
    expect(confirmResult?.isSuccess()).toBe(true);
    if (enrollment !== null && enrollment !== undefined) {
      await mfaEnrollments.save(enrollment);
    }
    expect(first.isSuccess()).toBe(true);

    const secondSessionId = await seedPendingEnrollmentSession(account.id.toString(), 's2');
    const second = await handler.execute({ sessionId: secondSessionId });
    expect(second.isFailure()).toBe(true);
    expect(second.getError()).toBe('ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'MFA_ENROLLMENT_STARTED', outcome: 'FAILURE' });
  });

  it('course concurrente sur le TOUT PREMIER enrolement (MfaEnrollmentConcurrencyConflictError depuis save()) -> ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE, audite en FAILURE, jamais une exception non geree (BLOQUANT-2b)', async () => {
    const conflictingRepository = new ConflictOnFirstSaveMfaEnrollmentRepository();
    const conflictHandler = new StartMfaEnrollmentHandler(
      sessions,
      accounts,
      conflictingRepository,
      totpService,
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
    const account = await registerAccount();
    const sessionId = await seedPendingEnrollmentSession(account.id.toString());

    const result = await conflictHandler.execute({ sessionId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE');
    expect(auditTrail.records.at(-1)).toMatchObject({ eventType: 'MFA_ENROLLMENT_STARTED', outcome: 'FAILURE' });
  });

  it('rejette une session MFA_PENDING corrompue (userId invalide) en levant une exception (bug infra, pas un Result.failure)', async () => {
    const session: MfaPendingSessionContext = {
      sessionId: 's-corrompue',
      kind: 'MFA_PENDING',
      userId: 'pas-un-uuid',
      intent: { kind: 'PLATFORM' },
      reason: 'ENROLLMENT_REQUIRED',
      auditRoleCodes: [],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    await sessions.create(session);

    await expect(handler.execute({ sessionId: session.sessionId })).rejects.toThrow();
  });
});
