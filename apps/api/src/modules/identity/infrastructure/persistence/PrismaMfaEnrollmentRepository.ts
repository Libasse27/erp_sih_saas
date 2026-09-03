import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient, type PrismaClientOrTx } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { MfaRecoveryCode } from '../../domain/MfaRecoveryCode.js';
import { MfaEnrollmentConcurrencyConflictError, type MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import { MfaEnrollmentId } from '../../domain/value-objects/MfaEnrollmentId.js';
import type { MfaEnrollmentStatus } from '../../domain/value-objects/MfaEnrollmentStatus.js';
import type { MfaFactorType } from '../../domain/value-objects/MfaFactorType.js';
import { MfaRecoveryCodeId } from '../../domain/value-objects/MfaRecoveryCodeId.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';

interface RecoveryCodeRow {
  id: string;
  codeHash: string;
  createdAt: Date;
  consumedAt: Date | null;
}

interface EnrollmentRow {
  id: string;
  userId: string;
  status: string;
  factorType: string;
  activeSecret: string | null;
  pendingSecret: string | null;
  lastAcceptedTimeStep: number | null;
  lastAcceptedChallengeTimeStep: number | null;
  consecutiveFailedAttempts: number;
  lockedUntil: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  recoveryCodes: RecoveryCodeRow[];
}

/** Ligne brute renvoyee par la requete SQL verrouillante (`findByUserIdForUpdate`) — sans `recoveryCodes`, rechargees separement. */
interface RawEnrollmentRow {
  id: string;
  userId: string;
  status: string;
  factorType: string;
  activeSecret: string | null;
  pendingSecret: string | null;
  lastAcceptedTimeStep: number | null;
  lastAcceptedChallengeTimeStep: number | null;
  consecutiveFailedAttempts: number;
  lockedUntil: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/**
 * Repository `MfaEnrollment` — table `platform.MfaEnrollment` (+ `platform.MfaRecoveryCode`),
 * schema `platform`, HORS RLS (ADR-0005 §1, meme regime que `UserAccount` : aucune methode ne
 * prend de `tenantId`, le MFA est un concept d'identite globale, pas tenant-scoped).
 *
 * Verrouillage optimiste via colonne `version` (PUREMENT technique — absente de
 * `MfaEnrollmentProps`, connue uniquement de ce repository), meme pattern que
 * `PrismaPaymentRepository.ts` : `updateMany({ where: { id, version } })`, `count === 0` =>
 * `MfaEnrollmentConcurrencyConflictError`.
 *
 * Consommation d'un code de recuperation : `UPDATE ... WHERE id = ? AND consumed_at IS NULL`
 * (ADR-0005 §3 : "un seul UPDATE conditionnel indexe, atomique par construction") — `count === 0`
 * signale qu'un AUTRE writer a deja consomme ce code entre notre lecture et notre ecriture.
 */
export class PrismaMfaEnrollmentRepository implements MfaEnrollmentRepository {
  private readonly versionsByInstance = new WeakMap<MfaEnrollment, number>();

  constructor(private readonly prisma: PrismaClient) {}

  async findByUserId(userId: UserAccountId): Promise<MfaEnrollment | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.mfaEnrollment.findUnique({
      where: { userId: userId.toString() },
      include: { recoveryCodes: true },
    });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * Verrouillage PESSIMISTE (`SELECT ... FOR UPDATE`) — voir `MfaEnrollmentRepository.ts` (F-3)
   * pour la justification complete. `$queryRaw` est le SEUL moyen d'exprimer `FOR UPDATE` avec
   * l'API Prisma installee ici (6.19.3) : le query builder (`findUnique`/`findFirst`) n'expose
   * aucune option de verrouillage de ligne. Parametre par tag template (jamais par interpolation
   * de chaine) — meme discipline que `PgUnitOfWork.withTransaction` pour `set_config`.
   *
   * `resolvePrismaClient` DOIT renvoyer le client TRANSACTIONNEL actif (jamais le client de base)
   * pour que `FOR UPDATE` ait un sens : ce n'est garanti que si cette methode est appelee depuis
   * l'interieur de `UnitOfWork.withTransaction` (contrat documente sur le port).
   */
  async findByUserIdForUpdate(userId: UserAccountId): Promise<MfaEnrollment | null> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.$queryRaw<RawEnrollmentRow[]>`
      SELECT
        "id" AS "id",
        "user_id" AS "userId",
        "status" AS "status",
        "factor_type" AS "factorType",
        "active_secret" AS "activeSecret",
        "pending_secret" AS "pendingSecret",
        "last_accepted_time_step" AS "lastAcceptedTimeStep",
        "last_accepted_challenge_time_step" AS "lastAcceptedChallengeTimeStep",
        "consecutive_failed_attempts" AS "consecutiveFailedAttempts",
        "locked_until" AS "lockedUntil",
        "activated_at" AS "activatedAt",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt",
        "version" AS "version"
      FROM "platform"."MfaEnrollment"
      WHERE "user_id" = ${userId.toString()}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const recoveryCodes = await client.mfaRecoveryCode.findMany({ where: { enrollmentId: row.id } });
    return this.toDomain({ ...row, recoveryCodes });
  }

  async save(enrollment: MfaEnrollment): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    const idStr = enrollment.id.toString();

    const existingRow = await client.mfaEnrollment.findUnique({ where: { id: idStr }, select: { id: true } });

    if (existingRow === null) {
      // `createMany({ skipDuplicates: true })` PLUTOT qu'un `create()` dont on rattraperait un
      // `P2002` — meme idiome que `PrismaUserAccountRepository.save()`/`PrismaSubscriptionRepository.save()` :
      // cette methode est appelee DANS une transaction deja ouverte, et en PostgreSQL une
      // violation de contrainte AVORTE la transaction entiere. `count === 0` signifie qu'un AUTRE
      // writer vient de creer un `MfaEnrollment` pour ce MEME `userId` (contrainte UNIQUE) entre
      // notre lecture (`findByUserId`/`findByUserIdForUpdate`, qui ne verrouille RIEN tant
      // qu'aucune ligne n'existe) et notre ecriture — le tout premier enrolement d'un compte n'a
      // structurellement aucune ligne a verrouiller par `FOR UPDATE` avant qu'elle existe (revue
      // de securite independante de l'etape 12/13, BLOQUANT-2b).
      const insertResult = await client.mfaEnrollment.createMany({
        data: [
          {
            id: idStr,
            userId: enrollment.userId.toString(),
            status: enrollment.status,
            factorType: enrollment.factorType,
            activeSecret: enrollment.activeSecret?.value ?? null,
            pendingSecret: enrollment.pendingSecret?.value ?? null,
            lastAcceptedTimeStep: enrollment.lastAcceptedTimeStep,
            lastAcceptedChallengeTimeStep: enrollment.lastAcceptedChallengeTimeStep,
            consecutiveFailedAttempts: enrollment.consecutiveFailedAttempts,
            lockedUntil: enrollment.lockedUntil,
            activatedAt: enrollment.activatedAt,
            createdAt: enrollment.createdAt,
            updatedAt: enrollment.updatedAt,
            version: 0,
          },
        ],
        skipDuplicates: true,
      });
      if (insertResult.count === 0) {
        throw new MfaEnrollmentConcurrencyConflictError(
          `Un MfaEnrollment existe deja pour l'utilisateur ${enrollment.userId.toString()} (course concurrente sur le premier enrolement).`,
        );
      }
      this.versionsByInstance.set(enrollment, 0);
    } else {
      const expectedVersion = this.versionsByInstance.get(enrollment) ?? 0;
      const updateResult = await client.mfaEnrollment.updateMany({
        where: { id: idStr, version: expectedVersion },
        data: {
          status: enrollment.status,
          activeSecret: enrollment.activeSecret?.value ?? null,
          pendingSecret: enrollment.pendingSecret?.value ?? null,
          lastAcceptedTimeStep: enrollment.lastAcceptedTimeStep,
          lastAcceptedChallengeTimeStep: enrollment.lastAcceptedChallengeTimeStep,
          consecutiveFailedAttempts: enrollment.consecutiveFailedAttempts,
          lockedUntil: enrollment.lockedUntil,
          activatedAt: enrollment.activatedAt,
          updatedAt: enrollment.updatedAt,
          version: { increment: 1 },
        },
      });
      if (updateResult.count === 0) {
        throw new MfaEnrollmentConcurrencyConflictError(
          `Ecriture concurrente perdue sur MfaEnrollment ${idStr} : version attendue ${expectedVersion} deja depassee par un autre writer.`,
        );
      }
      this.versionsByInstance.set(enrollment, expectedVersion + 1);
    }

    await this.reconcileRecoveryCodes(client, idStr, enrollment.recoveryCodes);
    await writeDomainEventsToOutbox(client, enrollment.pullDomainEvents());
  }

  private async reconcileRecoveryCodes(
    client: PrismaClientOrTx,
    enrollmentId: string,
    codes: readonly MfaRecoveryCode[],
  ): Promise<void> {
    const desiredIds = new Set(codes.map((code) => code.id.toString()));
    const existingRows = await client.mfaRecoveryCode.findMany({
      where: { enrollmentId },
      select: { id: true },
    });
    const existingIds = new Set(existingRows.map((row) => row.id));

    const toDelete = [...existingIds].filter((id) => !desiredIds.has(id));
    if (toDelete.length > 0) {
      await client.mfaRecoveryCode.deleteMany({ where: { id: { in: toDelete } } });
    }

    for (const code of codes) {
      const idStr = code.id.toString();
      if (!existingIds.has(idStr)) {
        await client.mfaRecoveryCode.create({
          data: {
            id: idStr,
            enrollmentId,
            codeHash: code.hash.value,
            createdAt: code.createdAt,
            consumedAt: code.consumedAt,
          },
        });
        continue;
      }
      // Seul `consumedAt` peut changer apres creation (usage unique) — UPDATE conditionnel
      // indexe (ADR-0005 §3) : `count === 0` signale SOIT un AUTRE writer qui a deja consomme ce
      // code entre notre lecture et notre ecriture (course concurrente REELLE), SOIT — cas trouve
      // par execution reelle lors de la revue de l'etape 12/13 — un REJEU sequentiel (pas de
      // concurrence) d'un code DEJA consomme AVANT le debut de cette transaction : l'agregat est
      // alors charge avec ce code deja `isConsumed() === true`, `consumeRecoveryCode()` refuse au
      // niveau domaine (`RECOVERY_CODE_ALREADY_CONSUMED`) SANS muter `consumedAt`, mais `save()`
      // est quand meme appele (pour persister le compteur `registerFailedChallenge`) et retente
      // inconditionnellement cette meme ecriture, qui ne peut plus matcher `consumedAt: null`.
      //
      // Distinction faite via `wasConsumedInThisInstance()` (drapeau TRANSIENT sur
      // `MfaRecoveryCode`, jamais une comparaison d'horodatage — revue de securite independante
      // de l'etape 12/13, AC-A) : comparer `current.consumedAt === code.consumedAt` masquerait a
      // tort une VRAIE course entre deux writers dont les horloges tomberaient sur la MEME
      // milliseconde (resolution `timestamp(3)`). Si CETTE instance n'a jamais mute ce code
      // (rejeu sequentiel), `count === 0` est attendu et beninProof — rien a ecrire, rien a lever.
      // Si CETTE instance vient de le consommer et que l'ecriture echoue quand meme, c'est qu'un
      // AUTRE writer l'a fait avant nous : conflit reel, toujours leve.
      if (code.isConsumed()) {
        if (!code.wasConsumedInThisInstance()) {
          continue;
        }
        const result = await client.mfaRecoveryCode.updateMany({
          where: { id: idStr, consumedAt: null },
          data: { consumedAt: code.consumedAt },
        });
        if (result.count === 0) {
          throw new MfaEnrollmentConcurrencyConflictError(
            `Code de recuperation ${idStr} deja consomme par un autre writer (course concurrente detectee).`,
          );
        }
      }
    }
  }

  private toDomain(row: EnrollmentRow): MfaEnrollment {
    const id = assertValid(MfaEnrollmentId.create(row.id));
    const userId = assertValid(UserAccountId.create(row.userId));
    const enrollment = MfaEnrollment.reconstitute(id, {
      userId,
      status: row.status as MfaEnrollmentStatus,
      factorType: row.factorType as MfaFactorType,
      activeSecret: row.activeSecret === null ? null : assertValid(EncryptedTotpSecret.create(row.activeSecret)),
      pendingSecret: row.pendingSecret === null ? null : assertValid(EncryptedTotpSecret.create(row.pendingSecret)),
      recoveryCodes: row.recoveryCodes.map((codeRow) =>
        MfaRecoveryCode.reconstitute(assertValid(MfaRecoveryCodeId.create(codeRow.id)), {
          hash: assertValid(RecoveryCodeHash.create(codeRow.codeHash)),
          createdAt: codeRow.createdAt,
          consumedAt: codeRow.consumedAt,
        }),
      ),
      lastAcceptedTimeStep: row.lastAcceptedTimeStep,
      lastAcceptedChallengeTimeStep: row.lastAcceptedChallengeTimeStep,
      consecutiveFailedAttempts: row.consecutiveFailedAttempts,
      lockedUntil: row.lockedUntil,
      activatedAt: row.activatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    this.versionsByInstance.set(enrollment, row.version);
    return enrollment;
  }
}
