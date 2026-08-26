import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS, MFA_RECOVERY_CODE_COUNT } from '../../domain/MfaTuning.js';
import type { MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import type { RecoveryCodeGenerator } from '../../domain/ports/RecoveryCodeGenerator.js';
import type { TotpService } from '../../domain/ports/TotpService.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { AuditTrail, MfaAuditEventType } from '../ports/AuditTrail.js';
import type { SessionStore } from '../ports/SessionStore.js';

export interface RegenerateMfaRecoveryCodesCommand {
  readonly sessionId: string;
  readonly totpCode: string;
  readonly correlationId?: string;
}

export type RegenerateMfaRecoveryCodesError =
  | 'SESSION_NOT_FOUND'
  | 'STEP_UP_REQUIRED'
  | 'ENROLLMENT_NOT_FOUND'
  | 'ENROLLMENT_NOT_ACTIVE'
  | 'INVALID_CODE'
  | 'TOO_MANY_ATTEMPTS';

export interface RegenerateMfaRecoveryCodesResult {
  readonly recoveryCodes: readonly string[];
}

/**
 * Remplace L'INTEGRALITE du jeu de codes de recuperation (ADR-0005 §3 : jamais un ajout
 * partiel). Exige une preuve TOTP FRAICHE (step-up, O-06.3) — jamais un code de recuperation
 * lui-meme (ce serait circulaire : regenerer le filet de securite avec le filet de securite).
 *
 * `userId` n'est PLUS un champ de la commande (correctif securite, revue independante F-2) : ce
 * champ permettait a n'importe quel appelant capable de le choisir de regenerer (et donc de
 * recevoir en clair) le jeu de codes de recuperation d'un compte tiers. `sessionId` est desormais
 * la SEULE source de l'identite du sujet : la session DOIT etre PLEINEMENT RESOLUE (`PLATFORM`
 * ou `TENANT`, jamais `MFA_PENDING`) ET porter un `mfaSatisfiedAt` non nul (step-up deja exige
 * par le design, cf. commentaire ci-dessus) — toute autre situation est refusee AVANT toute
 * lecture de `MfaEnrollment`.
 */
export class RegenerateMfaRecoveryCodesHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly mfaEnrollmentRepository: MfaEnrollmentRepository,
    private readonly totpService: TotpService,
    private readonly recoveryCodeGenerator: RecoveryCodeGenerator,
    private readonly auditTrail: AuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: RegenerateMfaRecoveryCodesCommand,
  ): Promise<Result<RegenerateMfaRecoveryCodesResult, RegenerateMfaRecoveryCodesError>> {
    const session = await this.sessionStore.get(command.sessionId);
    if (session === null) {
      return Result.failure('SESSION_NOT_FOUND');
    }
    if (session.kind === 'MFA_PENDING' || session.mfaSatisfiedAt === null) {
      return Result.failure('STEP_UP_REQUIRED');
    }
    const userIdResult = UserAccountId.create(session.userId);
    if (userIdResult.isFailure()) {
      // Un SessionContext PLATFORM/TENANT est toujours cree avec un UserAccountId deja valide —
      // une valeur corrompue ici trahit Redis, pas un echec metier attendu.
      throw new Error(`RegenerateMfaRecoveryCodes : userId de session invalide ("${session.userId}").`);
    }
    const userId = userIdResult.getValue();

    return this.unitOfWork.withTransaction(async () => {
      // F-3 : verrou de ligne (FOR UPDATE), meme raisonnement que ConfirmMfaEnrollment/VerifyMfaChallenge.
      const enrollment = await this.mfaEnrollmentRepository.findByUserIdForUpdate(userId);
      if (enrollment === null) {
        await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'FAILURE');
        return Result.failure('ENROLLMENT_NOT_FOUND');
      }
      if (!enrollment.isActive()) {
        await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'FAILURE');
        return Result.failure('ENROLLMENT_NOT_ACTIVE');
      }

      const now = this.clock.now();
      if (enrollment.isLocked(now)) {
        await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'FAILURE');
        return Result.failure('TOO_MANY_ATTEMPTS');
      }

      const activeSecret = enrollment.activeSecret;
      if (activeSecret === null) {
        throw new Error('MfaEnrollment ACTIF sans activeSecret (invariant viole).');
      }

      const verification = await this.totpService.verify({
        secret: activeSecret,
        userAccountId: userId.toString(),
        code: command.totpCode,
        at: now,
      });
      if (!verification.valid || verification.timeStep === null) {
        enrollment.registerFailedChallenge(this.clock, this.idGenerator);
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'FAILURE');
        if (enrollment.consecutiveFailedAttempts >= MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS) {
          await this.audit(userId, command, 'MFA_FACTOR_LOCKED_OUT', 'FAILURE');
        }
        return Result.failure('INVALID_CODE');
      }

      const registerResult = enrollment.registerSuccessfulChallenge({ timeStep: verification.timeStep, clock: this.clock });
      if (registerResult.isFailure()) {
        enrollment.registerFailedChallenge(this.clock, this.idGenerator);
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'FAILURE');
        if (enrollment.consecutiveFailedAttempts >= MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS) {
          await this.audit(userId, command, 'MFA_FACTOR_LOCKED_OUT', 'FAILURE');
        }
        return Result.failure('INVALID_CODE');
      }

      const generated = this.recoveryCodeGenerator.generate(MFA_RECOVERY_CODE_COUNT);
      const regenResult = enrollment.regenerateRecoveryCodes({
        hashes: generated.hashes,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      if (regenResult.isFailure()) {
        // Deja verifie plus haut (enrollment.isActive()) — defensif uniquement.
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'FAILURE');
        return Result.failure('ENROLLMENT_NOT_ACTIVE');
      }

      await this.mfaEnrollmentRepository.save(enrollment);
      await this.audit(userId, command, 'MFA_RECOVERY_CODES_REGENERATED', 'SUCCESS');
      return Result.success({ recoveryCodes: generated.plainCodes });
    });
  }

  private async audit(
    userId: UserAccountId,
    command: RegenerateMfaRecoveryCodesCommand,
    eventType: MfaAuditEventType,
    outcome: 'SUCCESS' | 'FAILURE',
  ): Promise<void> {
    await this.auditTrail.record({
      eventType,
      outcome,
      tenantId: null,
      subjectUserId: userId.toString(),
      actorUserId: userId.toString(),
      actorRoleCodes: [],
      reason: null,
      sessionId: command.sessionId,
      correlationId: command.correlationId ?? null,
    });
  }
}
