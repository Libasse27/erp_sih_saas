import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS } from '../../domain/MfaTuning.js';
import type { MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import type { RecoveryCodeHasher } from '../../domain/ports/RecoveryCodeHasher.js';
import type { TotpService } from '../../domain/ports/TotpService.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { AuditTrail, MfaAuditEventType } from '../ports/AuditTrail.js';
import type { MfaPendingSessionContext, SessionContext, SessionStore } from '../ports/SessionStore.js';
import type { SessionContextIssuer } from '../services/SessionContextIssuer.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';

export type MfaChallengeFactorInput = { readonly kind: 'TOTP'; readonly code: string } | { readonly kind: 'RECOVERY_CODE'; readonly code: string };

export interface VerifyMfaChallengeCommand {
  readonly pendingSessionId: string;
  readonly factor: MfaChallengeFactorInput;
  readonly correlationId?: string;
}

export type VerifyMfaChallengeError =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_PENDING_MFA'
  | 'ENROLLMENT_REQUIRED'
  | 'INVALID_CODE'
  | 'TOO_MANY_ATTEMPTS'
  | 'CONTEXT_NO_LONGER_AVAILABLE';

export interface VerifyMfaChallengeResult {
  readonly session: SessionContext;
  /** Voir `ResolveTenantContextResult.refreshToken` (ADR-0006 §9) — meme contrat, meme raison. */
  readonly refreshToken: string | null;
}

type TransactionOutcome = { readonly kind: 'OK' } | { readonly kind: 'ERROR'; readonly error: VerifyMfaChallengeError };

/**
 * Verifie le second facteur (TOTP ou code de recuperation) presente pour une session
 * `MFA_PENDING` et, en cas de succes, re-emet une session COMPLETE (roles/permissions RE-RESOLUS
 * depuis la base, jamais relus depuis la session en attente — ADR-0005 §4). Chaque tentative,
 * succes ou echec, est auditee DANS LA MEME TRANSACTION que la mutation de l'agregat
 * `MfaEnrollment` (compteur d'echecs, verrou, consommation de code).
 */
export class VerifyMfaChallengeHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly mfaEnrollmentRepository: MfaEnrollmentRepository,
    private readonly totpService: TotpService,
    private readonly recoveryCodeHasher: RecoveryCodeHasher,
    private readonly sessionContextIssuer: SessionContextIssuer,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly auditTrail: AuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: VerifyMfaChallengeCommand): Promise<Result<VerifyMfaChallengeResult, VerifyMfaChallengeError>> {
    const pending = await this.sessionStore.get(command.pendingSessionId);
    if (pending === null) {
      return Result.failure('SESSION_NOT_FOUND');
    }
    if (pending.kind !== 'MFA_PENDING') {
      return Result.failure('SESSION_NOT_PENDING_MFA');
    }
    if (pending.reason === 'ENROLLMENT_REQUIRED') {
      return Result.failure('ENROLLMENT_REQUIRED');
    }

    const userIdResult = UserAccountId.create(pending.userId);
    if (userIdResult.isFailure()) {
      throw new Error(`SessionContext MFA_PENDING corrompu : userId invalide ("${pending.userId}").`);
    }
    const userId = userIdResult.getValue();

    const outcome = await this.unitOfWork.withTransaction<TransactionOutcome>(async () => {
      // F-3 : verrou de ligne (FOR UPDATE) — serialise les evaluations de code concurrentes sur
      // le MEME compte (voir MfaEnrollmentRepository.ts pour la justification complete).
      const enrollment = await this.mfaEnrollmentRepository.findByUserIdForUpdate(userId);
      if (enrollment === null || !enrollment.isActive()) {
        await this.audit(pending, command, 'MFA_CHALLENGE_FAILED', 'FAILURE');
        return { kind: 'ERROR', error: 'ENROLLMENT_REQUIRED' };
      }

      const now = this.clock.now();
      if (enrollment.isLocked(now)) {
        await this.audit(pending, command, 'MFA_CHALLENGE_BLOCKED', 'DENIED');
        return { kind: 'ERROR', error: 'TOO_MANY_ATTEMPTS' };
      }

      if (command.factor.kind === 'TOTP') {
        const activeSecret = enrollment.activeSecret;
        if (activeSecret === null) {
          throw new Error('MfaEnrollment ACTIF sans activeSecret (invariant viole).');
        }
        const verification = await this.totpService.verify({
          secret: activeSecret,
          userAccountId: userId.toString(),
          code: command.factor.code,
          at: now,
        });
        if (!verification.valid || verification.timeStep === null) {
          enrollment.registerFailedChallenge(this.clock, this.idGenerator);
          await this.mfaEnrollmentRepository.save(enrollment);
          await this.audit(pending, command, 'MFA_CHALLENGE_FAILED', 'FAILURE');
          await this.auditIfJustLockedOut(pending, command, enrollment);
          return { kind: 'ERROR', error: 'INVALID_CODE' };
        }
        const registerResult = enrollment.registerSuccessfulChallenge({ timeStep: verification.timeStep, clock: this.clock });
        if (registerResult.isFailure()) {
          enrollment.registerFailedChallenge(this.clock, this.idGenerator);
          await this.mfaEnrollmentRepository.save(enrollment);
          await this.audit(pending, command, 'MFA_CHALLENGE_FAILED', 'FAILURE');
          await this.auditIfJustLockedOut(pending, command, enrollment);
          return { kind: 'ERROR', error: 'INVALID_CODE' };
        }
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(pending, command, 'MFA_CHALLENGE_SUCCEEDED', 'SUCCESS');
        return { kind: 'OK' };
      }

      const hash = this.recoveryCodeHasher.hash(command.factor.code);
      const consumeResult = enrollment.consumeRecoveryCode({ hash, clock: this.clock, idGenerator: this.idGenerator });
      if (consumeResult.isFailure()) {
        enrollment.registerFailedChallenge(this.clock, this.idGenerator);
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(pending, command, 'MFA_CHALLENGE_FAILED', 'FAILURE');
        await this.auditIfJustLockedOut(pending, command, enrollment);
        return { kind: 'ERROR', error: 'INVALID_CODE' };
      }
      await this.mfaEnrollmentRepository.save(enrollment);
      await this.audit(pending, command, 'MFA_RECOVERY_CODE_CONSUMED', 'SUCCESS');
      if (enrollment.recoveryCodes.every((candidate) => candidate.isConsumed())) {
        await this.audit(pending, command, 'MFA_RECOVERY_CODES_EXHAUSTED', 'SUCCESS');
      }
      return { kind: 'OK' };
    });

    if (outcome.kind === 'ERROR') {
      return Result.failure(outcome.error);
    }

    const sessionResult = await this.sessionContextIssuer.issueAfterChallenge({ userId, intent: pending.intent });
    if (sessionResult.isFailure()) {
      // `ACCOUNT_NOT_FOUND`/`NOT_SUPER_ADMIN` sont des anomalies pathologiques a ce stade (le
      // compte et son intention ont deja ete valides a l'ouverture de la session MFA_PENDING) —
      // `VerifyMfaChallengeError` ne les distingue pas de CONTEXT_NO_LONGER_AVAILABLE : dans les
      // deux cas, le contexte precedemment valide ne l'est structurellement plus.
      return Result.failure('CONTEXT_NO_LONGER_AVAILABLE');
    }
    const session = sessionResult.getValue();
    await this.sessionStore.delete(pending.sessionId);
    await this.sessionStore.create(session);
    // Etape 8/13 (ADR-0006 §9) : une chaine de refresh n'est jamais issue d'une session
    // `MFA_PENDING` (ADR-0006 §7) — elle ne peut demarrer qu'ICI, une fois le second facteur
    // prouve et la session COMPLETE emise.
    const issuedChain = await this.refreshTokenIssuer.issueChain(session);
    return Result.success({ session, refreshToken: issuedChain?.raw ?? null });
  }

  /**
   * F-5 : le verrouillage anti-brute-force declenche par `registerFailedChallenge()` (ci-dessus)
   * est lui-meme un evenement d'audit distinct de l'echec qui l'a declenche. L'agregat n'expose
   * pas directement "ce dernier appel a-t-il declenche le verrou" : `consecutiveFailedAttempts`
   * atteint EXACTEMENT le seuil au moment ou il se produit (les tentatives suivantes sont
   * arretees plus haut par `enrollment.isLocked(now)`, avant meme d'appeler
   * `registerFailedChallenge` de nouveau) — la comparaison au seuil est donc suffisante pour ne
   * jamais ecrire cet evenement plus d'une fois par episode de verrouillage.
   */
  private async auditIfJustLockedOut(
    pending: MfaPendingSessionContext,
    command: VerifyMfaChallengeCommand,
    enrollment: MfaEnrollment,
  ): Promise<void> {
    if (enrollment.consecutiveFailedAttempts >= MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS) {
      await this.audit(pending, command, 'MFA_FACTOR_LOCKED_OUT', 'FAILURE');
    }
  }

  private async audit(
    pending: MfaPendingSessionContext,
    command: VerifyMfaChallengeCommand,
    eventType: MfaAuditEventType,
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
  ): Promise<void> {
    await this.auditTrail.record({
      eventType,
      outcome,
      tenantId: pending.intent.kind === 'TENANT' ? pending.intent.tenantId : null,
      subjectUserId: pending.userId,
      actorUserId: pending.userId,
      actorRoleCodes: pending.auditRoleCodes,
      reason: null,
      sessionId: pending.sessionId,
      correlationId: command.correlationId ?? null,
    });
  }
}
