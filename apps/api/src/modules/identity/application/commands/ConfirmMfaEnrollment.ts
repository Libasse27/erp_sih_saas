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

export interface ConfirmMfaEnrollmentCommand {
  readonly totpCode: string;
  readonly sessionId: string;
  readonly correlationId?: string;
}

export type ConfirmMfaEnrollmentError =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_PENDING_ENROLLMENT'
  | 'ENROLLMENT_NOT_FOUND'
  | 'NO_PENDING_FACTOR'
  | 'INVALID_CODE'
  | 'TOO_MANY_ATTEMPTS';

export interface ConfirmMfaEnrollmentResult {
  /** Codes en clair — exposes UNE SEULE FOIS a l'appelant (ADR-0005 §3), jamais journalises ni relus. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Confirme le facteur `pendingSecret` provisionne par `StartMfaEnrollment` avec un premier code
 * TOTP valide, et genere le jeu initial de codes de recuperation. Chaque chemin (succes ET
 * echec) enregistre une entree d'audit DANS LA MEME TRANSACTION (ADR-0005 §5) : un echec de
 * confirmation incremente aussi le compteur d'echecs consecutifs de l'agregat (verrouillage
 * anti-brute-force partage avec `VerifyMfaChallenge`).
 *
 * `userId` n'est PLUS un champ de la commande (correctif securite, revue independante F-2) : un
 * appelant capable de choisir librement un `userAccountId` pourrait confirmer/consulter le
 * secret TOTP OU les codes de recuperation en clair d'un compte tiers. `sessionId` est desormais
 * la SEULE source de l'identite du sujet : la session DOIT etre `MFA_PENDING` avec
 * `reason === 'ENROLLMENT_REQUIRED'` (l'intention "je termine mon enrolement" deja validee
 * serveur, voir `SessionContextIssuer`/`VerifyMfaChallenge` pour l'emission de ce type de
 * session) — toute autre variante est refusee AVANT toute lecture de `MfaEnrollment`.
 */
export class ConfirmMfaEnrollmentHandler {
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
    command: ConfirmMfaEnrollmentCommand,
  ): Promise<Result<ConfirmMfaEnrollmentResult, ConfirmMfaEnrollmentError>> {
    const session = await this.sessionStore.get(command.sessionId);
    if (session === null) {
      return Result.failure('SESSION_NOT_FOUND');
    }
    if (session.kind !== 'MFA_PENDING' || session.reason !== 'ENROLLMENT_REQUIRED') {
      return Result.failure('SESSION_NOT_PENDING_ENROLLMENT');
    }
    const userIdResult = UserAccountId.create(session.userId);
    if (userIdResult.isFailure()) {
      // Un SessionContext MFA_PENDING est toujours cree avec un UserAccountId deja valide — une
      // valeur corrompue ici trahit Redis, pas un echec metier attendu (meme discipline que
      // VerifyMfaChallenge.ts).
      throw new Error(`ConfirmMfaEnrollment : userId de session invalide ("${session.userId}").`);
    }
    const userId = userIdResult.getValue();

    return this.unitOfWork.withTransaction(async () => {
      // F-3 : verrou de ligne (FOR UPDATE) — serialise les evaluations de code concurrentes sur
      // le MEME compte au lieu de les laisser entrer en conflit de version optimiste (qui aurait
      // perdu silencieusement le compteur d'echecs ET l'audit des tentatives non gagnantes).
      const enrollment = await this.mfaEnrollmentRepository.findByUserIdForUpdate(userId);
      if (enrollment === null) {
        await this.audit(userId, command, 'MFA_ENROLLMENT_CONFIRMED', 'FAILURE');
        return Result.failure('ENROLLMENT_NOT_FOUND');
      }

      const now = this.clock.now();
      if (enrollment.isLocked(now)) {
        await this.audit(userId, command, 'MFA_ENROLLMENT_CONFIRMED', 'FAILURE');
        return Result.failure('TOO_MANY_ATTEMPTS');
      }

      const pendingSecret = enrollment.pendingSecret;
      if (pendingSecret === null) {
        await this.audit(userId, command, 'MFA_ENROLLMENT_CONFIRMED', 'FAILURE');
        return Result.failure('NO_PENDING_FACTOR');
      }

      const verification = await this.totpService.verify({
        secret: pendingSecret,
        userAccountId: userId.toString(),
        code: command.totpCode,
        at: now,
      });
      if (!verification.valid || verification.timeStep === null) {
        enrollment.registerFailedChallenge(this.clock, this.idGenerator);
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(userId, command, 'MFA_ENROLLMENT_CONFIRMED', 'FAILURE');
        if (enrollment.consecutiveFailedAttempts >= MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS) {
          // F-5 : le verrouillage anti-brute-force est lui-meme un evenement d'audit distinct de
          // l'echec qui l'a declenche — jamais ecrit avant ce seuil (sinon une entree par echec).
          await this.audit(userId, command, 'MFA_FACTOR_LOCKED_OUT', 'FAILURE');
        }
        return Result.failure('INVALID_CODE');
      }

      // F-5 : capture AVANT mutation — `MfaEnrollment.confirmEnrollment()` calcule cette meme
      // valeur en interne (`wasReplacement`) pour choisir l'evenement de DOMAINE
      // (`MfaEnrollmentConfirmed` vs `MfaFactorReplaced`) mais ne l'expose pas : on la
      // recalcule ici a l'identique pour choisir l'evenement d'AUDIT correspondant.
      const wasReplacement = enrollment.activatedAt !== null;

      const generated = this.recoveryCodeGenerator.generate(MFA_RECOVERY_CODE_COUNT);
      const confirmResult = enrollment.confirmEnrollment({
        timeStep: verification.timeStep,
        recoveryCodes: generated.hashes,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      if (confirmResult.isFailure()) {
        // Deja verifie plus haut (pendingSecret !== null) — defensif uniquement (course concurrente).
        await this.mfaEnrollmentRepository.save(enrollment);
        await this.audit(userId, command, 'MFA_ENROLLMENT_CONFIRMED', 'FAILURE');
        return Result.failure('NO_PENDING_FACTOR');
      }

      await this.mfaEnrollmentRepository.save(enrollment);
      await this.audit(userId, command, wasReplacement ? 'MFA_FACTOR_REPLACED' : 'MFA_ENROLLMENT_CONFIRMED', 'SUCCESS');
      return Result.success({ recoveryCodes: generated.plainCodes });
    });
  }

  private async audit(
    userId: UserAccountId,
    command: ConfirmMfaEnrollmentCommand,
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
