import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { AuditTrail } from '../ports/AuditTrail.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';

export interface ForceMfaReEnrollmentCommand {
  readonly subjectUserAccountId: string;
  readonly actorSessionId: string;
  readonly reason: string;
  readonly correlationId?: string;
}

export type ForceMfaReEnrollmentError =
  | 'SESSION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'REASON_REQUIRED'
  | 'ENROLLMENT_NOT_FOUND'
  | 'SUBJECT_NOT_FOUND';

/**
 * Execution TECHNIQUE de la procedure de recuperation MFA administree (O-04, residu 3 : la
 * verification d'identite elle-meme reste un PROCESSUS HUMAIN, hors code). L'acteur doit :
 * 1. detenir une session avec `mfaSatisfiedAt` non nul (step-up, O-06.3) — jamais executable
 *    depuis une session dont le SECOND FACTEUR n'a pas ete lui-meme prouve ;
 * 2. etre habilite : soit une session `PLATFORM` (le `SUPER_ADMIN` est administrateur
 *    inconditionnel de l'identite, voir `SystemRoleCatalog.ts` — `user-account:administer`),
 *    soit une session `TENANT` porteuse de la permission `mfa:reset` ;
 * 3. (correctif securite, cf. revue independante F-1) — quand l'acteur est une session `TENANT`,
 *    le SUJET vise doit en outre detenir un membership ACTIF dans CE MEME tenant. Sans cette
 *    verification, un `ADMIN_ETABLISSEMENT` du tenant A pourrait reinitialiser le MFA de
 *    N'IMPORTE QUEL compte de la plateforme (tenant B, voire un `SUPER_ADMIN`), le chargement du
 *    sujet se faisant via `UserAccountRepository.findById()` qui est GLOBAL (hors RLS, ADR-0005
 *    §1). Une session `PLATFORM` reste, elle, un administrateur INCONDITIONNEL de l'identite : la
 *    portee "plateforme entiere" est le comportement voulu pour ce role, pas une omission.
 *
 * SEUL chemin de sortie d'un facteur `ACTIVE` (voir `MfaEnrollment.forceReEnrollment` — O-04.5) :
 * replace TOUJOURS le sujet en `RESET_REQUIRED`, jamais un etat "MFA non requis", et invalide
 * IMMEDIATEMENT toutes les sessions deja ouvertes du sujet (`deleteAllForUser`, APRES commit —
 * meme pattern que `RevokeMembershipHandler.deleteAllForMembership`, Redis n'etant pas transactionnel
 * avec Postgres).
 */
export class ForceMfaReEnrollmentHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly userAccountRepository: UserAccountRepository,
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly roleRepository: RoleRepository,
    private readonly mfaEnrollmentRepository: MfaEnrollmentRepository,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly auditTrail: AuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: ForceMfaReEnrollmentCommand): Promise<Result<void, ForceMfaReEnrollmentError>> {
    const actorSession = await this.sessionStore.get(command.actorSessionId);
    if (actorSession === null) {
      // Acteur non identifiable : aucun sujet fiable a associer a une entree d'audit (F-4).
      // Contrairement au refus FORBIDDEN ci-dessous, il n'existe ici ni acteur ni sujet valides —
      // journaliser forcerait une valeur sentinelle qui ne serait pas honnete. Le contournement
      // structurel des sessions inconnues/expirees est deja couvert en amont par
      // `ServerContextResolver`/`MFA_BYPASS_ATTEMPTED` pour les endpoints qui passent par lui.
      return Result.failure('SESSION_NOT_FOUND');
    }

    const subjectIdResult = UserAccountId.create(command.subjectUserAccountId);
    if (subjectIdResult.isFailure()) {
      throw new Error(`ForceMfaReEnrollment : subjectUserAccountId invalide ("${command.subjectUserAccountId}").`);
    }
    const subjectId = subjectIdResult.getValue();
    const actorTenantId = actorSession.kind === 'TENANT' ? actorSession.tenantId : null;
    const actorRoleCodes = actorSession.kind === 'TENANT' ? actorSession.roleCodes : [];

    if (!this.isAuthorized(actorSession)) {
      // Acteur authentifie et identifiable, mais non habilite (permission `mfa:reset` manquante
      // ou pas de step-up) : refus journalise (F-4), en dehors de toute transaction de mutation
      // (meme discipline que `MFA_BYPASS_ATTEMPTED` dans `ServerContextResolver` — un simple INSERT
      // autonome, sans mutation a proteger atomiquement).
      await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'DENIED', null);
      return Result.failure('FORBIDDEN');
    }

    const outcome = await this.unitOfWork.withTransaction(async () => {
      if (command.reason.trim().length === 0) {
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'FAILURE', null);
        return Result.failure<void, ForceMfaReEnrollmentError>('REASON_REQUIRED');
      }

      const subject = await this.userAccountRepository.findById(subjectId);
      if (subject === null) {
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'FAILURE', command.reason);
        return Result.failure<void, ForceMfaReEnrollmentError>('SUBJECT_NOT_FOUND');
      }

      if (actorSession.kind === 'TENANT') {
        const tenantIdResult = TenantId.create(actorSession.tenantId);
        if (tenantIdResult.isFailure()) {
          // Un SessionContext TENANT est toujours cree avec un TenantId deja valide (voir
          // ResolveTenantContext.ts) : une valeur corrompue ici trahit Redis, pas un echec metier.
          throw new Error(`ForceMfaReEnrollment : tenantId de session acteur invalide ("${actorSession.tenantId}").`);
        }
        const tenantId = tenantIdResult.getValue();
        const membership = await this.membershipRepository.findActiveByUserAndTenant(subjectId, tenantId);
        if (membership === null) {
          // F-1 : le sujet n'appartient pas (ou plus) au tenant de l'acteur — refus, JAMAIS un
          // acces implicite a un compte hors perimetre (tenant B, ou meme SUPER_ADMIN).
          await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'DENIED', null);
          return Result.failure<void, ForceMfaReEnrollmentError>('FORBIDDEN');
        }
        // ADR-0005 Amendement 1 (2026-09-03, O-04 residu 3) : un ADMIN_ETABLISSEMENT garde
        // `mfa:reset` pour le personnel non-admin de son tenant (aucun changement ci-dessus), mais
        // ne peut plus reinitialiser le MFA d'un AUTRE ADMIN_ETABLISSEMENT du meme tenant — seule
        // une session PLATFORM (SUPER_ADMIN) le peut desormais (branche `PLATFORM` d'`isAuthorized`,
        // qui ne passe jamais par ce bloc `TENANT`). Roles resolus depuis le membership DEJA charge
        // ci-dessus (meme lecture que le correctif F-1, aucune requete supplementaire de membership).
        const subjectRoles = await this.roleRepository.findByIds(tenantId, membership.roleIds);
        if (subjectRoles.some((role) => role.code === 'ADMIN_ETABLISSEMENT')) {
          await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'DENIED', null);
          return Result.failure<void, ForceMfaReEnrollmentError>('FORBIDDEN');
        }
      }

      const enrollment = await this.mfaEnrollmentRepository.findByUserId(subjectId);
      if (enrollment === null) {
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'FAILURE', command.reason);
        return Result.failure<void, ForceMfaReEnrollmentError>('ENROLLMENT_NOT_FOUND');
      }

      const forceResult = enrollment.forceReEnrollment({
        requestedByUserId: actorSession.userId,
        reason: command.reason,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      if (forceResult.isFailure()) {
        // Deja verifie plus haut (reason non vide) — defensif uniquement.
        await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'FAILURE', command.reason);
        return Result.failure<void, ForceMfaReEnrollmentError>('REASON_REQUIRED');
      }

      await this.mfaEnrollmentRepository.save(enrollment);
      await this.audit(subjectId, actorSession, actorTenantId, actorRoleCodes, command, 'SUCCESS', command.reason);
      return Result.success<void, ForceMfaReEnrollmentError>(undefined);
    });

    if (outcome.isSuccess()) {
      // ORDRE DELIBERE (correctif securite, revue independante) : voir CloseSessionHandler.
      await this.refreshTokenIssuer.revokeAllForUser(subjectId.toString(), 'MFA_RE_ENROLLMENT_FORCED');
      await this.sessionStore.deleteAllForUser(subjectId.toString());
    }
    return outcome;
  }

  private isAuthorized(session: SessionContext): boolean {
    if (session.kind === 'MFA_PENDING') {
      return false;
    }
    if (session.mfaSatisfiedAt === null) {
      return false;
    }
    if (session.kind === 'PLATFORM') {
      return true;
    }
    return session.permissionCodes.includes('mfa:reset');
  }

  private async audit(
    subjectId: UserAccountId,
    actorSession: SessionContext,
    tenantId: string | null,
    actorRoleCodes: readonly string[],
    command: ForceMfaReEnrollmentCommand,
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
    reason: string | null,
  ): Promise<void> {
    await this.auditTrail.record({
      eventType: 'MFA_RE_ENROLLMENT_FORCED',
      outcome,
      tenantId,
      subjectUserId: subjectId.toString(),
      actorUserId: actorSession.userId,
      actorRoleCodes,
      reason,
      sessionId: actorSession.sessionId,
      correlationId: command.correlationId ?? null,
    });
  }
}
