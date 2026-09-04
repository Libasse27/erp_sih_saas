import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import {
  ApproverCannotBeRequesterError,
  ApproverCannotTargetSelfError,
  RequestNotPendingError,
} from '../../domain/SuperAdminBreakGlassRequest.js';
import type { SuperAdminBreakGlassRequestRepository } from '../../domain/ports/SuperAdminBreakGlassRequestRepository.js';
import type { MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import { SuperAdminBreakGlassRequestId } from '../../domain/value-objects/SuperAdminBreakGlassRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { AuditTrail } from '../ports/AuditTrail.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';

export interface ApproveSuperAdminBreakGlassCommand {
  readonly requestId: string;
  readonly actorSessionId: string;
  readonly correlationId?: string;
}

export type ApproveSuperAdminBreakGlassError =
  | 'SESSION_NOT_FOUND'
  | 'REQUEST_NOT_FOUND'
  | 'FORBIDDEN'
  | 'REQUEST_NOT_PENDING'
  | 'CANNOT_APPROVE_OWN_SUBJECT'
  | 'CANNOT_APPROVE_OWN_REQUEST'
  | 'ENROLLMENT_NOT_FOUND';

/**
 * Seconde etape du break-glass `SUPER_ADMIN` (ADR-0005 Amendement 1, O-04 residu 4) : un DEUXIEME
 * `SUPER_ADMIN` (C), distinct du demandeur (B) ET du sujet (A), approuve la demande. L'approbation
 * declenche IMMEDIATEMENT, dans LA MEME transaction, la reinitialisation MFA du sujet
 * (`MfaEnrollment.forceReEnrollment`, exactement le meme mecanisme que
 * `ForceMfaReEnrollmentHandler` — jamais une seconde implementation divergente) et la revocation de
 * toutes ses sessions/chaines de refresh token.
 *
 * QUORUM STRICT : aucun approbateur unique n'est possible, y compris quand seuls deux SUPER_ADMIN
 * existent sur la plateforme — ce cas reste un runbook operationnel hors bande (ADR-0005
 * Amendement 1), jamais une bascule applicative codee ici ou ailleurs.
 */
export class ApproveSuperAdminBreakGlassHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly breakGlassRequestRepository: SuperAdminBreakGlassRequestRepository,
    private readonly mfaEnrollmentRepository: MfaEnrollmentRepository,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly auditTrail: AuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: ApproveSuperAdminBreakGlassCommand): Promise<Result<void, ApproveSuperAdminBreakGlassError>> {
    const actorSession = await this.sessionStore.get(command.actorSessionId);
    if (actorSession === null) {
      return Result.failure('SESSION_NOT_FOUND');
    }
    // Derives UNE FOIS (meme discipline que ForceMfaReEnrollmentHandler) : un acteur TENANT non
    // habilite doit etre attribue a SON tenant/ses roles reels dans l'audit, jamais a `null`/`[]`
    // en dur (correctif revue de securite independante de l'etape 12/13, MAJEUR-2 — sinon une
    // tentative illegitime depuis un tenant est journalisee comme si elle venait de la plateforme,
    // sans tenant ni role, cassant l'attribution dans un journal APPEND-ONLY).
    const actorTenantId = actorSession.kind === 'TENANT' ? actorSession.tenantId : null;
    const actorRoleCodes = actorSession.kind === 'TENANT' ? actorSession.roleCodes : [];

    const requestIdResult = SuperAdminBreakGlassRequestId.create(command.requestId);
    if (requestIdResult.isFailure()) {
      throw new Error(`ApproveSuperAdminBreakGlass : requestId invalide ("${command.requestId}").`);
    }
    const requestId = requestIdResult.getValue();

    // Retourne le `UserAccountId` du sujet APPROUVE sur le chemin de succes (jamais `void`) :
    // c'est le SEUL moyen fiable de recuperer cette valeur apres la transaction — capturer une
    // variable `let` externe depuis cette fermeture `async` n'est PAS narrowable par TypeScript
    // en dehors de la fermeture (le flux de controle ne peut pas prouver qu'elle a ete executee),
    // ce qui degeneraait `approvedSubjectId` en `never` a l'usage ci-dessous.
    const transactionResult = await this.unitOfWork.withTransaction(async (): Promise<Result<UserAccountId, ApproveSuperAdminBreakGlassError>> => {
      // Autorisation verifiee AVANT toute lecture de la demande (correctif revue de securite
      // independante de l'etape 12/13, MAJEUR-1) : un acteur non habilite qui balaie des
      // `requestId` inexistants doit rester audite (DENIED, sujet = l'acteur lui-meme, seul sujet
      // honnete a ce stade) — l'ordre inverse laissait cette reconnaissance totalement invisible
      // (retour REQUEST_NOT_FOUND avant meme la verification d'habilitation, jamais journalise).
      if (!this.isAuthorized(actorSession)) {
        await this.audit(actorSession.userId, actorSession, actorTenantId, actorRoleCodes, 'DENIED', command.correlationId ?? null);
        return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('FORBIDDEN');
      }

      const request = await this.breakGlassRequestRepository.findById(requestId);
      if (request === null) {
        // Aucun sujet identifiable a associer a une entree d'audit fiable (meme discipline que
        // SESSION_NOT_FOUND dans ForceMfaReEnrollment, F-4) : requestId inconnu, rien a journaliser
        // de faux.
        return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('REQUEST_NOT_FOUND');
      }

      const approverIdResult = UserAccountId.create(actorSession.userId);
      if (approverIdResult.isFailure()) {
        // Un SessionContext PLATFORM est toujours emis avec un UserAccountId deja valide (voir
        // SessionContextIssuer.ts) : une valeur corrompue ici trahit Redis, pas un echec metier.
        throw new Error(`ApproveSuperAdminBreakGlass : userId de session acteur invalide ("${actorSession.userId}").`);
      }

      const approveResult = request.approve({ approverUserId: approverIdResult.getValue(), clock: this.clock, idGenerator: this.idGenerator });
      if (approveResult.isFailure()) {
        await this.audit(request.subjectUserAccountId.toString(), actorSession, actorTenantId, actorRoleCodes, 'DENIED', command.correlationId ?? null);
        const error = approveResult.getError();
        if (error instanceof RequestNotPendingError) {
          return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('REQUEST_NOT_PENDING');
        }
        if (error instanceof ApproverCannotTargetSelfError) {
          return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('CANNOT_APPROVE_OWN_SUBJECT');
        }
        if (error instanceof ApproverCannotBeRequesterError) {
          return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('CANNOT_APPROVE_OWN_REQUEST');
        }
        throw error;
      }

      const enrollment = await this.mfaEnrollmentRepository.findByUserId(request.subjectUserAccountId);
      if (enrollment === null) {
        await this.audit(request.subjectUserAccountId.toString(), actorSession, actorTenantId, actorRoleCodes, 'FAILURE', command.correlationId ?? null);
        return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('ENROLLMENT_NOT_FOUND');
      }
      const forceResult = enrollment.forceReEnrollment({
        requestedByUserId: actorSession.userId,
        reason: `Break-glass approuve (requete ${requestId.toString()}), demandeur ${request.requestedByUserId.toString()}`,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      if (forceResult.isFailure()) {
        // Deja verifie : le motif construit ci-dessus n'est jamais vide. Defensif uniquement.
        throw new Error('ApproveSuperAdminBreakGlass : motif genere vide (bug).');
      }

      const applied = await this.breakGlassRequestRepository.save(request);
      if (!applied) {
        // Course REELLE (jamais reproduite par un test mono-thread) : un AUTRE approbateur a
        // gagne le quorum entre notre lecture et notre ecriture — refus metier propre, audite,
        // JAMAIS une exception qui romprait cette transaction (voir le commentaire de tete de
        // `SuperAdminBreakGlassRequestRepository.save()`). Le `MfaEnrollment` n'est PAS sauvegarde :
        // aucun second re-enrolement force redondant.
        await this.audit(request.subjectUserAccountId.toString(), actorSession, actorTenantId, actorRoleCodes, 'DENIED', command.correlationId ?? null);
        return Result.failure<UserAccountId, ApproveSuperAdminBreakGlassError>('REQUEST_NOT_PENDING');
      }
      await this.mfaEnrollmentRepository.save(enrollment);
      await this.audit(request.subjectUserAccountId.toString(), actorSession, actorTenantId, actorRoleCodes, 'SUCCESS', command.correlationId ?? null);
      return Result.success<UserAccountId, ApproveSuperAdminBreakGlassError>(request.subjectUserAccountId);
    });

    if (transactionResult.isSuccess()) {
      // ORDRE DELIBERE (meme discipline que ForceMfaReEnrollmentHandler/CloseSessionHandler) :
      // Postgres (source de verite) d'abord, nettoyage Redis ensuite — fail-closed.
      const approvedSubjectId = transactionResult.getValue();
      await this.refreshTokenIssuer.revokeAllForUser(approvedSubjectId.toString(), 'MFA_RE_ENROLLMENT_FORCED');
      await this.sessionStore.deleteAllForUser(approvedSubjectId.toString());
    }
    return transactionResult.map(() => undefined);
  }

  private isAuthorized(session: SessionContext): boolean {
    return session.kind === 'PLATFORM' && session.mfaSatisfiedAt !== null;
  }

  private async audit(
    subjectUserId: string,
    actorSession: SessionContext,
    tenantId: string | null,
    actorRoleCodes: readonly string[],
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
    correlationId: string | null,
  ): Promise<void> {
    await this.auditTrail.record({
      eventType: 'SUPER_ADMIN_BREAK_GLASS_APPROVED',
      outcome,
      tenantId,
      subjectUserId,
      actorUserId: actorSession.userId,
      actorRoleCodes,
      reason: null,
      sessionId: actorSession.sessionId,
      correlationId,
    });
  }
}
