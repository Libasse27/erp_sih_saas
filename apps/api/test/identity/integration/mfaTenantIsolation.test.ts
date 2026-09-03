import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { MfaEnrollment } from '../../../src/modules/identity/domain/MfaEnrollment.js';
import { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import { UserTenantMembership } from '../../../src/modules/identity/domain/UserTenantMembership.js';
import { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { EncryptedTotpSecret } from '../../../src/modules/identity/domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../../src/modules/identity/domain/value-objects/RecoveryCodeHash.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { PrismaMfaEnrollmentRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaMfaEnrollmentRepository.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { PrismaUserTenantMembershipRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserTenantMembershipRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueEmail } from './dbTestHelpers.js';

/**
 * Isolation — `platform.MfaEnrollment` / `platform.MfaRecoveryCode` (lacune B de l'audit de
 * securite, Phase 0, etape 12/13).
 *
 * ECART DELIBERE ET DOCUMENTE par rapport au gabarit `paymentRepositoryTenantIsolation.test.ts` /
 * `subscriptionRepositoryTenantIsolation.test.ts` / `notificationTenantIsolation.test.ts` :
 * contrairement a `Payment`/`Subscription`/`Notification`, `platform.MfaEnrollment` et
 * `platform.MfaRecoveryCode` NE PORTENT AUCUNE COLONNE `tenant_id` — voir le commentaire de tete
 * de `PrismaMfaEnrollmentRepository.ts` ("le MFA est un concept d'identite globale, pas
 * tenant-scoped") et `schema.prisma` (modeles `MfaEnrollment`/`MfaRecoveryCode`, aucun champ
 * `tenantId`). Un `UserAccount` (et donc son MFA) peut appartenir simultanement a plusieurs
 * `UserTenantMembership` (O-05, multi-etablissement) : il n'existe structurellement aucun
 * `tenantId` a filtrer ici, et en ajouter un a ce test reviendrait a INVENTER une regle metier
 * absente du code (interdit — voir mandat, §14 Escalade).
 *
 * La barriere d'isolation REELLEMENT applicable, et non testee jusqu'ici au niveau REPOSITORY
 * (le niveau APPLICATION est deja couvert par `ForceMfaReEnrollment.test.ts`, cas F-1 : un acteur
 * TENANT ne peut pas forcer le MFA d'un sujet d'un AUTRE tenant), est donc : `findByUserId`/
 * `findByUserIdForUpdate` ne renvoient JAMAIS l'enrolement — ni les codes de recuperation — d'un
 * AUTRE utilisateur, meme quand deux enrolements distincts, appartenant a des utilisateurs
 * membres de tenants DIFFERENTS, coexistent en base. C'est l'equivalent, pour une ressource
 * globale (userId comme seule cle d'isolation), de ce que `tenantId` est pour une ressource
 * tenant-scopee — meme esprit que le bloc "REPOSITORY" des gabarits Payment/Subscription.
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('MfaEnrollment / MfaRecoveryCode — isolation par utilisateur (schema platform, sans tenant_id, sans RLS)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let userAccounts: PrismaUserAccountRepository;
  let memberships: PrismaUserTenantMembershipRepository;
  let mfaEnrollments: PrismaMfaEnrollmentRepository;

  const tenantAId = randomUUID();
  const tenantBId = randomUUID();
  const userIdsToCleanup: string[] = [];
  let userA: UserAccountId;
  let userB: UserAccountId;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    const clock = new SystemClock();
    const idGenerator = new UuidGenerator();
    userAccounts = new PrismaUserAccountRepository(prisma);
    memberships = new PrismaUserTenantMembershipRepository(prisma, clock, idGenerator);
    mfaEnrollments = new PrismaMfaEnrollmentRepository(prisma);

    async function createEnrolledUser(emailPrefix: string, tenantId: string): Promise<UserAccountId> {
      const account = UserAccount.register({
        email: Email.create(uniqueEmail(emailPrefix)).getValue(),
        passwordHash: PasswordHash.fromHash('hash').getValue(),
        platformRole: 'NONE',
        clock,
        idGenerator,
      });
      await userAccounts.save(account);
      userIdsToCleanup.push(account.id.toString());

      const tenant = TenantId.create(tenantId).getValue();
      const membership = UserTenantMembership.grant({
        userId: account.id,
        tenantId: tenant,
        createdBy: account.id,
        initialRoleIds: [],
        clock,
        idGenerator,
      });
      // `UserTenantMembership` (schema public) est RLS FORCE : l'ecriture doit passer par
      // `UnitOfWork.withTransaction(..., { tenantId })` pour que `app.tenant_id` soit positionne
      // (meme discipline que subscriptionCreateConcurrency.test.ts/paymentProviderTransactionIdConcurrency.test.ts).
      const uow = new PgUnitOfWork(prisma);
      await uow.withTransaction(() => memberships.save(membership, tenant), { tenantId: tenant });

      const enrollment = MfaEnrollment.start({
        userId: account.id,
        pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
        clock,
        idGenerator,
      });
      enrollment.confirmEnrollment({
        timeStep: 1,
        recoveryCodes: [
          RecoveryCodeHash.create(`v1.p1.code-${emailPrefix}-1`).getValue(),
          RecoveryCodeHash.create(`v1.p1.code-${emailPrefix}-2`).getValue(),
        ],
        clock,
        idGenerator,
      });
      await mfaEnrollments.save(enrollment);
      return account.id;
    }

    userA = await createEnrolledUser('mfa-isolation-a', tenantAId);
    userB = await createEnrolledUser('mfa-isolation-b', tenantBId);
  });

  afterAll(async () => {
    if (userIdsToCleanup.length > 0) {
      // `onDelete: Cascade` (UserAccount -> MfaEnrollment -> MfaRecoveryCode,
      // UserTenantMembership -> MembershipRole) supprime le reste en cascade.
      await rawClient.query('DELETE FROM "platform"."UserAccount" WHERE id = ANY($1)', [userIdsToCleanup]);
    }
    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('REPOSITORY — PrismaMfaEnrollmentRepository ne renvoie jamais l_enrolement d_un AUTRE utilisateur', () => {
    it("findByUserId(userA) renvoie l'enrolement de A, jamais celui de B, meme si les deux existent simultanement", async () => {
      const result = await mfaEnrollments.findByUserId(userA);
      expect(result).not.toBeNull();
      expect(result?.userId.toString()).toBe(userA.toString());
      expect(result?.userId.toString()).not.toBe(userB.toString());
    });

    it("findByUserId(userB) renvoie l'enrolement de B, jamais celui de A (symetrique)", async () => {
      const result = await mfaEnrollments.findByUserId(userB);
      expect(result).not.toBeNull();
      expect(result?.userId.toString()).toBe(userB.toString());
      expect(result?.userId.toString()).not.toBe(userA.toString());
    });

    it("les codes de recuperation de A ne fuitent jamais dans l'enrolement de B (et inversement)", async () => {
      const enrollmentA = await mfaEnrollments.findByUserId(userA);
      const enrollmentB = await mfaEnrollments.findByUserId(userB);
      expect(enrollmentA).not.toBeNull();
      expect(enrollmentB).not.toBeNull();

      const hashesA = enrollmentA?.recoveryCodes.map((code) => code.hash.value) ?? [];
      const hashesB = enrollmentB?.recoveryCodes.map((code) => code.hash.value) ?? [];
      expect(hashesA).toHaveLength(2);
      expect(hashesB).toHaveLength(2);
      expect(hashesA.some((hash) => hashesB.includes(hash))).toBe(false);
    });

    it('consommer un code de recuperation de A ne consomme ni ne modifie AUCUN code de B', async () => {
      const clock = new SystemClock();
      const idGenerator = new UuidGenerator();
      const enrollmentA = await mfaEnrollments.findByUserId(userA);
      expect(enrollmentA).not.toBeNull();
      const codeToConsume = enrollmentA?.recoveryCodes[0];
      expect(codeToConsume).toBeDefined();
      if (enrollmentA === null || codeToConsume === undefined) {
        throw new Error('Etat de test inattendu (bug de test).');
      }

      const consumeResult = enrollmentA.consumeRecoveryCode({ hash: codeToConsume.hash, clock, idGenerator });
      expect(consumeResult.isSuccess()).toBe(true);
      await mfaEnrollments.save(enrollmentA);

      const reloadedA = await mfaEnrollments.findByUserId(userA);
      expect(reloadedA?.recoveryCodes.filter((code) => code.isConsumed())).toHaveLength(1);

      const reloadedB = await mfaEnrollments.findByUserId(userB);
      expect(reloadedB?.recoveryCodes.filter((code) => code.isConsumed())).toHaveLength(0);
    });

    it('findByUserIdForUpdate(userA), la variante verrouillante, respecte la meme isolation par utilisateur', async () => {
      const uow = new PgUnitOfWork(prisma);
      await uow.withTransaction(async () => {
        const result = await mfaEnrollments.findByUserIdForUpdate(userA);
        expect(result?.userId.toString()).toBe(userA.toString());
        expect(result?.userId.toString()).not.toBe(userB.toString());
      });
    });
  });

  describe('SCHEMA — absence deliberee de tenant_id, contraste avec les tables tenant-scopees (Notification/Subscription/Payment)', () => {
    it('platform.MfaEnrollment ne porte AUCUNE colonne tenant_id (design assume, pas un oubli)', async () => {
      const result = await rawClient.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'MfaEnrollment'`,
      );
      const columns = result.rows.map((row: { column_name: string }) => row.column_name);
      expect(columns).not.toContain('tenant_id');
    });

    it('platform.MfaRecoveryCode ne porte AUCUNE colonne tenant_id (design assume, pas un oubli)', async () => {
      const result = await rawClient.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'MfaRecoveryCode'`,
      );
      const columns = result.rows.map((row: { column_name: string }) => row.column_name);
      expect(columns).not.toContain('tenant_id');
    });

    it('une requete SQL brute confirme que A et B sont bien deux enrolements distincts, chacun avec ses propres codes', async () => {
      const result = await rawClient.query(
        `SELECT e.user_id, count(r.id) AS recovery_code_count
         FROM "platform"."MfaEnrollment" e
         LEFT JOIN "platform"."MfaRecoveryCode" r ON r.enrollment_id = e.id
         WHERE e.user_id = ANY($1)
         GROUP BY e.user_id`,
        [[userA.toString(), userB.toString()]],
      );
      const rows = result.rows as Array<{ user_id: string; recovery_code_count: string }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Number(row.recovery_code_count)).toBe(2);
      }
    });
  });
});
