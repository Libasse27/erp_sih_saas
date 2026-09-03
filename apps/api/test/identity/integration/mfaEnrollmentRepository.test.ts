import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { MfaEnrollment } from '../../../src/modules/identity/domain/MfaEnrollment.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { EncryptedTotpSecret } from '../../../src/modules/identity/domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../../src/modules/identity/domain/value-objects/RecoveryCodeHash.js';
import { MfaEnrollmentConcurrencyConflictError } from '../../../src/modules/identity/domain/ports/MfaEnrollmentRepository.js';
import { PrismaMfaEnrollmentRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaMfaEnrollmentRepository.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueEmail } from './dbTestHelpers.js';

/**
 * Integration reelle (PostgreSQL) de `PrismaMfaEnrollmentRepository` : verrouillage optimiste
 * (`version`) et consommation CONCURRENTE d'un meme code de recuperation (ADR-0005 §3).
 * Necessite `docker compose up -d` et les migrations appliquees.
 */
describe('PrismaMfaEnrollmentRepository — integration Postgres reelle', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let userAccounts: PrismaUserAccountRepository;
  let mfaEnrollments: PrismaMfaEnrollmentRepository;
  const userIdsToCleanup: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    userAccounts = new PrismaUserAccountRepository(prisma);
    mfaEnrollments = new PrismaMfaEnrollmentRepository(prisma);
  });

  afterAll(async () => {
    if (userIdsToCleanup.length > 0) {
      await rawClient.query('DELETE FROM "platform"."UserAccount" WHERE id = ANY($1)', [userIdsToCleanup]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  async function createAccount(): Promise<UserAccount> {
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const account = UserAccount.register({
      email: Email.create(uniqueEmail('mfa-repo')).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await userAccounts.save(account);
    userIdsToCleanup.push(account.id.toString());
    return account;
  }

  it('save() puis findByUserId() relit un enrolement PENDING_ACTIVATION fidele', async () => {
    const account = await createAccount();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const enrollment = MfaEnrollment.start({
      userId: account.id,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });

    await mfaEnrollments.save(enrollment);

    const reloaded = await mfaEnrollments.findByUserId(account.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.status).toBe('PENDING_ACTIVATION');
    expect(reloaded?.pendingSecret?.value).toBe(enrollment.pendingSecret?.value);
  });

  it('verrouillage optimiste : une ecriture basee sur une version PERIMEE echoue explicitement', async () => {
    const account = await createAccount();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const enrollment = MfaEnrollment.start({
      userId: account.id,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    await mfaEnrollments.save(enrollment);

    // Deux relectures INDEPENDANTES du meme enrolement (deux instances distinctes, chacune
    // retenant SA version lue) — exactement le scenario que le verrouillage optimiste doit couvrir.
    const staleCopy = await mfaEnrollments.findByUserId(account.id);
    const freshCopy = await mfaEnrollments.findByUserId(account.id);
    expect(staleCopy).not.toBeNull();
    expect(freshCopy).not.toBeNull();

    freshCopy?.forceReEnrollment({ requestedByUserId: account.id.toString(), reason: 'premiere ecriture', clock, idGenerator });
    if (freshCopy !== null) {
      await mfaEnrollments.save(freshCopy);
    }

    staleCopy?.forceReEnrollment({ requestedByUserId: account.id.toString(), reason: 'ecriture perimee', clock, idGenerator });
    await expect(async () => {
      if (staleCopy !== null) {
        await mfaEnrollments.save(staleCopy);
      }
    }).rejects.toThrow(MfaEnrollmentConcurrencyConflictError);
  });

  it('consommation CONCURRENTE du MEME code de recuperation : un seul succes, l_autre echoue proprement', async () => {
    const account = await createAccount();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    const enrollment = MfaEnrollment.start({
      userId: account.id,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    const codeHash = RecoveryCodeHash.create('v1.p1.concurrent-code').getValue();
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [codeHash], clock, idGenerator });
    await mfaEnrollments.save(enrollment);

    // Deux "requetes" concurrentes independantes : chacune relit sa propre instance, tente de
    // consommer le MEME code, et sauvegarde sous sa PROPRE transaction Postgres — exactement le
    // pattern deja etabli par paymentProviderTransactionIdConcurrency.test.ts.
    const attempt = async (): Promise<'OK' | 'ERROR'> => {
      const uow = new PgUnitOfWork(prisma);
      try {
        await uow.withTransaction(async () => {
          const copy = await mfaEnrollments.findByUserId(account.id);
          if (copy === null) {
            throw new Error('Enrolement introuvable (bug de test).');
          }
          const consumeResult = copy.consumeRecoveryCode({ hash: codeHash, clock, idGenerator });
          if (consumeResult.isFailure()) {
            throw new Error(`Consommation refusee au niveau domaine : ${consumeResult.getError()}`);
          }
          await mfaEnrollments.save(copy);
        });
        return 'OK';
      } catch {
        return 'ERROR';
      }
    };

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o === 'OK')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ERROR')).toHaveLength(1);

    const finalState = await mfaEnrollments.findByUserId(account.id);
    expect(finalState?.recoveryCodes.filter((c) => c.isConsumed())).toHaveLength(1);
  });

  it('deux PREMIERS enrolements CONCURRENTS du MEME utilisateur (aucune ligne prealable, rien a verrouiller par FOR UPDATE) : un seul succes, l_autre echoue proprement (MfaEnrollmentConcurrencyConflictError), jamais une exception non geree (revue de securite independante de l_etape 12/13, BLOQUANT-2b)', async () => {
    const account = await createAccount();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();

    // Deux instances DISTINCTES (id d'agregat different) pour le MEME `userId` — exactement le
    // scenario de `StartMfaEnrollmentHandler` quand `findByUserIdForUpdate` ne trouve encore
    // AUCUNE ligne (rien a verrouiller avant qu'elle existe) : les deux "requetes" voient toutes
    // deux `existing === null` et construisent chacune un `MfaEnrollment.start()` frais.
    const attempt = async (): Promise<'OK' | 'CONFLICT'> => {
      const uow = new PgUnitOfWork(prisma);
      const enrollment = MfaEnrollment.start({
        userId: account.id,
        pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
        clock,
        idGenerator,
      });
      try {
        await uow.withTransaction(async () => {
          await mfaEnrollments.save(enrollment);
        });
        return 'OK';
      } catch (error) {
        if (error instanceof MfaEnrollmentConcurrencyConflictError) {
          return 'CONFLICT';
        }
        throw error;
      }
    };

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o === 'OK')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'CONFLICT')).toHaveLength(1);

    const finalState = await mfaEnrollments.findByUserId(account.id);
    expect(finalState).not.toBeNull();
  });
});
