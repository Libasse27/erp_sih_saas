import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { MfaEnrollment } from '../../domain/MfaEnrollment.js';
import { MfaEnrollmentConcurrencyConflictError, type MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import type { TotpService } from '../../domain/ports/TotpService.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { AuditTrail } from '../ports/AuditTrail.js';
import type { SessionStore } from '../ports/SessionStore.js';

export interface StartMfaEnrollmentCommand {
  readonly sessionId: string;
  readonly correlationId?: string;
}

export type StartMfaEnrollmentError =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_PENDING_ENROLLMENT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE';

export interface StartMfaEnrollmentResult {
  readonly enrollmentId: string;
  readonly provisioningUri: string;
}

/**
 * Provisionne un nouveau facteur TOTP (premier enrolement OU redemarrage apres
 * `RESET_REQUIRED`). Refuse silencieusement de remplacer un facteur DEJA `ACTIVE` (O-04.5 :
 * seul `ForceMfaReEnrollment`, execute par un tiers habilite, sort d'un etat `ACTIVE`).
 *
 * `userAccountId` N'EST PLUS un champ de la commande (correctif securite, revue independante
 * F-2) : ce champ permettait a n'importe quel appelant capable de le choisir d'obtenir le
 * `provisioningUri` (secret TOTP en clair dans l'URI `otpauth://`) d'un compte tiers, sans aucune
 * verification que ce compte correspondait a l'appelant reel. `sessionId` est desormais la SEULE
 * source de l'identite du sujet : la session DOIT etre `MFA_PENDING` avec
 * `reason === 'ENROLLMENT_REQUIRED'` — toute autre variante est refusee avant toute lecture de
 * compte ou d'enrolement.
 */
export class StartMfaEnrollmentHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly userAccountRepository: UserAccountRepository,
    private readonly mfaEnrollmentRepository: MfaEnrollmentRepository,
    private readonly totpService: TotpService,
    private readonly auditTrail: AuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: StartMfaEnrollmentCommand): Promise<Result<StartMfaEnrollmentResult, StartMfaEnrollmentError>> {
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
      // valeur corrompue ici trahit Redis, pas un echec metier attendu.
      throw new Error(`StartMfaEnrollment : userId de session invalide ("${session.userId}").`);
    }
    const userId = userIdResult.getValue();

    return this.unitOfWork.withTransaction(async () => {
      const account = await this.userAccountRepository.findById(userId);
      if (account === null) {
        await this.auditTrail.record({
          eventType: 'MFA_ENROLLMENT_STARTED',
          outcome: 'FAILURE',
          tenantId: null,
          subjectUserId: userId.toString(),
          actorUserId: userId.toString(),
          actorRoleCodes: [],
          reason: null,
          sessionId: command.sessionId,
          correlationId: command.correlationId ?? null,
        });
        return Result.failure('ACCOUNT_NOT_FOUND');
      }

      // Verrouillage pessimiste (`FOR UPDATE`, correctif F-3, meme discipline que
      // `ConfirmMfaEnrollment`/`VerifyMfaChallenge`) : serialise les re-enrolements CONCURRENTS
      // sur une ligne EXISTANTE. Ne protege PAS a lui seul le TOUT PREMIER enrolement d'un compte
      // (rien a verrouiller avant que la ligne existe) — voir la capture de
      // `MfaEnrollmentConcurrencyConflictError` autour de `save()` plus bas (revue de securite
      // independante de l'etape 12/13, BLOQUANT-2b).
      const existing = await this.mfaEnrollmentRepository.findByUserIdForUpdate(userId);
      if (existing !== null && existing.isActive()) {
        await this.auditTrail.record({
          eventType: 'MFA_ENROLLMENT_STARTED',
          outcome: 'FAILURE',
          tenantId: null,
          subjectUserId: userId.toString(),
          actorUserId: userId.toString(),
          actorRoleCodes: [],
          reason: null,
          sessionId: command.sessionId,
          correlationId: command.correlationId ?? null,
        });
        return Result.failure('ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE');
      }

      const provisioning = await this.totpService.generateSecret({
        userAccountId: userId.toString(),
        accountLabel: account.email.value,
      });

      const enrollment =
        existing === null
          ? MfaEnrollment.start({
              userId,
              pendingSecret: provisioning.encryptedSecret,
              clock: this.clock,
              idGenerator: this.idGenerator,
            })
          : existing;

      if (existing !== null) {
        const beginResult = existing.beginReEnrollment({ pendingSecret: provisioning.encryptedSecret, clock: this.clock });
        if (beginResult.isFailure()) {
          // Deja verifie plus haut (existing.isActive()) — defensif uniquement.
          await this.auditTrail.record({
            eventType: 'MFA_ENROLLMENT_STARTED',
            outcome: 'FAILURE',
            tenantId: null,
            subjectUserId: userId.toString(),
            actorUserId: userId.toString(),
            actorRoleCodes: [],
            reason: null,
            sessionId: command.sessionId,
            correlationId: command.correlationId ?? null,
          });
          return Result.failure('ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE');
        }
      }

      try {
        await this.mfaEnrollmentRepository.save(enrollment);
      } catch (error) {
        if (existing === null && error instanceof MfaEnrollmentConcurrencyConflictError) {
          // Course benigne sur le TOUT PREMIER enrolement : un AUTRE writer vient de creer
          // l'agregat pour ce MEME utilisateur entre notre lecture et notre ecriture (aucune
          // ligne a verrouiller par FOR UPDATE avant qu'elle existe). Le secret genere ci-dessus
          // est jete, jamais persiste. Traduit en la MEME erreur que le cas "deja actif" : un
          // nouvel appel a cette route relira desormais la ligne fraichement creee et suivra le
          // chemin de re-enrolement normal, verrouille cette fois (revue de securite independante
          // de l'etape 12/13, BLOQUANT-2b).
          await this.auditTrail.record({
            eventType: 'MFA_ENROLLMENT_STARTED',
            outcome: 'FAILURE',
            tenantId: null,
            subjectUserId: userId.toString(),
            actorUserId: userId.toString(),
            actorRoleCodes: [],
            reason: null,
            sessionId: command.sessionId,
            correlationId: command.correlationId ?? null,
          });
          return Result.failure('ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE');
        }
        throw error;
      }
      await this.auditTrail.record({
        eventType: 'MFA_ENROLLMENT_STARTED',
        outcome: 'SUCCESS',
        tenantId: null,
        subjectUserId: userId.toString(),
        actorUserId: userId.toString(),
        actorRoleCodes: [],
        reason: null,
        sessionId: command.sessionId,
        correlationId: command.correlationId ?? null,
      });

      return Result.success({ enrollmentId: enrollment.id.toString(), provisioningUri: provisioning.provisioningUri });
    });
  }
}
