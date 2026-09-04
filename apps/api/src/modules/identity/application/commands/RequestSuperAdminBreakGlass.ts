import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { SuperAdminBreakGlassRequest } from '../../domain/SuperAdminBreakGlassRequest.js';
import type { SuperAdminBreakGlassRequestRepository } from '../../domain/ports/SuperAdminBreakGlassRequestRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import { SuperAdminBreakGlassRequestId } from '../../domain/value-objects/SuperAdminBreakGlassRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { AuditTrail } from '../ports/AuditTrail.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';

export interface RequestSuperAdminBreakGlassCommand {
  readonly subjectUserAccountId: string;
  readonly actorSessionId: string;
  readonly reason: string;
  readonly correlationId?: string;
}

export type RequestSuperAdminBreakGlassError =
  | 'SESSION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'REASON_REQUIRED'
  | 'SUBJECT_NOT_FOUND'
  | 'SUBJECT_NOT_SUPER_ADMIN'
  | 'CANNOT_TARGET_SELF';

export interface RequestSuperAdminBreakGlassResult {
  readonly requestId: string;
}

/**
 * Premiere etape du break-glass `SUPER_ADMIN` (ADR-0005 Amendement 1, O-04 residu 4) : le
 * demandeur (B, JAMAIS le sujet A lui-meme) ouvre une demande `PENDING`. B ne peut PAS l'approuver
 * lui-meme (voir `ApproveSuperAdminBreakGlass.ts`) — cette commande ne fait qu'ouvrir la demande et
 * alerter, elle n'execute JAMAIS la recuperation.
 *
 * Autorisation : session `PLATFORM` avec `mfaSatisfiedAt` non nul (meme step-up qu'exige
 * `ForceMfaReEnrollmentHandler`) — un `SUPER_ADMIN` authentifie mais dont le second facteur de
 * CETTE session n'a jamais ete prouve ne peut pas initier un break-glass pour un tiers.
 */
export class RequestSuperAdminBreakGlassHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly userAccountRepository: UserAccountRepository,
    private readonly breakGlassRequestRepository: SuperAdminBreakGlassRequestRepository,
    private readonly auditTrail: AuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: RequestSuperAdminBreakGlassCommand,
  ): Promise<Result<RequestSuperAdminBreakGlassResult, RequestSuperAdminBreakGlassError>> {
    const actorSession = await this.sessionStore.get(command.actorSessionId);
    if (actorSession === null) {
      return Result.failure('SESSION_NOT_FOUND');
    }
    // Derives UNE FOIS (meme discipline que ForceMfaReEnrollmentHandler) : un acteur TENANT non
    // habilite doit etre attribue a SON tenant/ses roles reels dans l'audit, jamais a `null`/`[]`
    // en dur (correctif revue de securite independante de l'etape 12/13, MAJEUR-2).
    const actorTenantId = actorSession.kind === 'TENANT' ? actorSession.tenantId : null;
    const actorRoleCodes = actorSession.kind === 'TENANT' ? actorSession.roleCodes : [];

    const subjectIdResult = UserAccountId.create(command.subjectUserAccountId);
    if (subjectIdResult.isFailure()) {
      throw new Error(`RequestSuperAdminBreakGlass : subjectUserAccountId invalide ("${command.subjectUserAccountId}").`);
    }
    const subjectId = subjectIdResult.getValue();

    if (!this.isAuthorized(actorSession)) {
      await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, 'DENIED', null, command.correlationId ?? null);
      return Result.failure('FORBIDDEN');
    }

    const outcome = await this.unitOfWork.withTransaction(async () => {
      if (command.reason.trim().length === 0) {
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, 'FAILURE', null, command.correlationId ?? null);
        return Result.failure<RequestSuperAdminBreakGlassResult, RequestSuperAdminBreakGlassError>('REASON_REQUIRED');
      }

      const subject = await this.userAccountRepository.findById(subjectId);
      if (subject === null) {
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, 'FAILURE', command.reason, command.correlationId ?? null);
        return Result.failure<RequestSuperAdminBreakGlassResult, RequestSuperAdminBreakGlassError>('SUBJECT_NOT_FOUND');
      }
      if (!subject.isSuperAdmin()) {
        // Le break-glass est reserve a la recuperation d'un SUPER_ADMIN — cibler un compte tenant
        // ordinaire n'a aucun sens (ForceMfaReEnrollment existe deja pour ce cas, avec sa propre
        // autorisation par permission `mfa:reset`, voir ADR-0005 Amendement 1 residu 3).
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, 'DENIED', command.reason, command.correlationId ?? null);
        return Result.failure<RequestSuperAdminBreakGlassResult, RequestSuperAdminBreakGlassError>('SUBJECT_NOT_SUPER_ADMIN');
      }

      const requestIdResult = SuperAdminBreakGlassRequestId.create(this.idGenerator.generate());
      if (requestIdResult.isFailure()) {
        throw new Error('IdGenerator a produit un identifiant invalide pour SuperAdminBreakGlassRequest.');
      }
      const requesterIdResult = UserAccountId.create(actorSession.userId);
      if (requesterIdResult.isFailure()) {
        // Un SessionContext PLATFORM est toujours emis avec un UserAccountId deja valide (voir
        // SessionContextIssuer.ts) : une valeur corrompue ici trahit Redis, pas un echec metier.
        throw new Error(`RequestSuperAdminBreakGlass : userId de session acteur invalide ("${actorSession.userId}").`);
      }

      const requestResult = SuperAdminBreakGlassRequest.request({
        id: requestIdResult.getValue(),
        requestedByUserId: requesterIdResult.getValue(),
        subjectUserAccountId: subjectId,
        reason: command.reason,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      if (requestResult.isFailure()) {
        // `RequesterCannotTargetSelfError` : A a tente de demander sa propre recuperation en se
        // faisant passer pour B — devrait deja etre impossible (A est par hypothese verrouille hors
        // de toute session PLATFORM), mais le domaine ne fait jamais confiance a la seule couche
        // applicative pour cet invariant (defense en profondeur).
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, 'DENIED', command.reason, command.correlationId ?? null);
        return Result.failure<RequestSuperAdminBreakGlassResult, RequestSuperAdminBreakGlassError>('CANNOT_TARGET_SELF');
      }
      const request = requestResult.getValue();

      const applied = await this.breakGlassRequestRepository.save(request);
      if (!applied) {
        // Ne devrait jamais arriver sur le chemin de CREATION (identifiant fraichement genere,
        // aucune ligne prealable) : `false` ici trahirait une collision d'UUID ou un bug
        // d'infrastructure, jamais un echec metier attendu — ne JAMAIS l'avaler silencieusement en
        // repondant 201 avec un `requestId` qui ne correspond a rien de persiste (correctif revue
        // de securite independante de l'etape 12/13, MINEUR-3).
        throw new Error(`SuperAdminBreakGlassRequest ${request.id.toString()} : creation non appliquee (bug).`);
      }
      await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, 'SUCCESS', command.reason, command.correlationId ?? null);
      return Result.success<RequestSuperAdminBreakGlassResult, RequestSuperAdminBreakGlassError>({
        requestId: request.id.toString(),
      });
    });

    return outcome;
  }

  private isAuthorized(session: SessionContext): boolean {
    return session.kind === 'PLATFORM' && session.mfaSatisfiedAt !== null;
  }

  private async audit(
    subjectId: UserAccountId,
    actorSession: SessionContext,
    tenantId: string | null,
    actorRoleCodes: readonly string[],
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
    reason: string | null,
    correlationId: string | null,
  ): Promise<void> {
    await this.auditTrail.record({
      eventType: 'SUPER_ADMIN_BREAK_GLASS_REQUESTED',
      outcome,
      tenantId,
      subjectUserId: subjectId.toString(),
      actorUserId: actorSession.userId,
      actorRoleCodes,
      reason,
      sessionId: actorSession.sessionId,
      correlationId,
    });
  }
}
