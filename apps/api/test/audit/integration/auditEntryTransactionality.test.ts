import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { ConfirmMfaEnrollmentHandler } from '../../../src/modules/identity/application/commands/ConfirmMfaEnrollment.js';
import type { AuditRecordInput, AuditTrail } from '../../../src/modules/identity/application/ports/AuditTrail.js';
import { MfaEnrollment } from '../../../src/modules/identity/domain/MfaEnrollment.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { EncryptedTotpSecret } from '../../../src/modules/identity/domain/value-objects/EncryptedTotpSecret.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { PrismaMfaEnrollmentRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaMfaEnrollmentRepository.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import type { MfaPendingSessionContext } from '../../../src/modules/identity/application/ports/SessionStore.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import { InMemorySessionStore } from '../../identity/builders/testKit.js';
import { uniqueEmail } from '../../identity/integration/dbTestHelpers.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/** Traduit vers le module `audit` — calque minimal de `AuditModuleBackedAuditTrail` (composition-root.ts). */
class AuditModuleBackedAuditTrail implements AuditTrail {
  constructor(private readonly audit: AuditModule) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.audit.services.recordEntry({
      category: 'MFA',
      eventType: input.eventType,
      outcome: input.outcome,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      actorUserId: input.actorUserId,
      actorRoleCodes: input.actorRoleCodes,
      reason: input.reason,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    });
  }
}

/**
 * Preuve d'integration reelle (ADR-0005 §5) que l'entree d'audit est ecrite DANS LA TRANSACTION
 * de l'action MFA : une EXCEPTION TECHNIQUE annule tout (l'audit ET la mutation), un
 * `Result.failure` METIER (pas d'exception) commite les deux.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('AuditEntry — atomicite transactionnelle avec l_action MFA (ADR-0005 §5)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let audit: AuditModule;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    audit = buildAuditModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator() });
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
  });

  it('une exception TECHNIQUE apres auditTrail.record() annule TOUT (rollback complet, aucune ligne AuditEntry committee)', async () => {
    const unitOfWork = new PgUnitOfWork(prisma);
    const subjectUserId = uniqueId();

    await expect(
      unitOfWork.withTransaction(async () => {
        await audit.services.recordEntry({
          category: 'MFA',
          eventType: 'MFA_CHALLENGE_SUCCEEDED',
          outcome: 'SUCCESS',
          tenantId: null,
          subjectUserId,
          actorUserId: subjectUserId,
          actorRoleCodes: [],
          reason: null,
          sessionId: null,
          correlationId: null,
        });
        throw new Error('panne technique simulee APRES ecriture de l_audit');
      }),
    ).rejects.toThrow(/panne technique simulee/);

    const rows = await prisma.auditEntry.findMany({ where: { subjectUserId } });
    expect(rows).toHaveLength(0);
  });

  it("un Result.failure METIER (code TOTP invalide) COMMIT l'entree d'audit ET le compteur d'echecs incremente, ensemble", async () => {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const userAccounts = new PrismaUserAccountRepository(prisma);
    const mfaEnrollments = new PrismaMfaEnrollmentRepository(prisma);
    const unitOfWork = new PgUnitOfWork(prisma);

    const account = UserAccount.register({
      email: Email.create(uniqueEmail('audit-tx')).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await userAccounts.save(account);

    const enrollment = MfaEnrollment.start({
      userId: account.id,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    await mfaEnrollments.save(enrollment);

    const totpService = {
      generateSecret: async () => {
        throw new Error('non utilise dans ce test');
      },
      verify: async () => ({ valid: false, timeStep: null }),
    };
    const recoveryCodeGenerator = { generate: () => ({ plainCodes: [], hashes: [] }) };
    const auditTrail = new AuditModuleBackedAuditTrail(audit);
    const sessions = new InMemorySessionStore();
    const pendingSession: MfaPendingSessionContext = {
      sessionId: 's1',
      kind: 'MFA_PENDING',
      userId: account.id.toString(),
      intent: { kind: 'PLATFORM' },
      reason: 'ENROLLMENT_REQUIRED',
      auditRoleCodes: [],
      issuedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
    };
    await sessions.create(pendingSession);

    const handler = new ConfirmMfaEnrollmentHandler(
      sessions,
      mfaEnrollments,
      totpService,
      recoveryCodeGenerator,
      auditTrail,
      unitOfWork,
      clock,
      idGenerator,
    );

    const result = await handler.execute({ totpCode: 'mauvais-code', sessionId: 's1' });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_CODE');

    const reloadedEnrollment = await mfaEnrollments.findByUserId(account.id);
    expect(reloadedEnrollment?.consecutiveFailedAttempts).toBe(1);

    const auditRows = await prisma.auditEntry.findMany({ where: { subjectUserId: account.id.toString() } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.outcome).toBe('FAILURE');
    expect(auditRows[0]?.eventType).toBe('MFA_ENROLLMENT_CONFIRMED');
  });
});
