import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { TenantAdminRecoveryRequest } from '../../domain/TenantAdminRecoveryRequest.js';
import type { TenantAdminRecoveryRequestRepository } from '../../domain/ports/TenantAdminRecoveryRequestRepository.js';
import type { TenantAccessChecker } from '../ports/TenantAccessChecker.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import { TenantAdminRecoveryRequestId } from '../../domain/value-objects/TenantAdminRecoveryRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { MembershipAuditTrail } from '../ports/MembershipAuditTrail.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';

export interface RequestTenantAdminRecoveryCommand {
  readonly tenantId: string;
  readonly beneficiaryUserId: string;
  readonly actorSessionId: string;
  readonly reason: string;
  readonly correlationId?: string;
}

export type RequestTenantAdminRecoveryError =
  | 'INVALID_TENANT_ID'
  | 'INVALID_BENEFICIARY_ID'
  | 'SESSION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'REASON_REQUIRED'
  | 'TENANT_NOT_FOUND'
  | 'BENEFICIARY_NOT_FOUND';

export interface RequestTenantAdminRecoveryResult {
  readonly requestId: string;
}

/** Ouvre une demande : seule une session PLATFORM avec MFA satisfaite peut la créer. */
export class RequestTenantAdminRecoveryHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly userAccounts: UserAccountRepository,
    private readonly tenantAccessChecker: TenantAccessChecker,
    private readonly requests: TenantAdminRecoveryRequestRepository,
    private readonly membershipAuditTrail: MembershipAuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: RequestTenantAdminRecoveryCommand): Promise<Result<RequestTenantAdminRecoveryResult, RequestTenantAdminRecoveryError>> {
    const tenantResult = TenantId.create(command.tenantId);
    if (tenantResult.isFailure()) return Result.failure('INVALID_TENANT_ID');
    const beneficiaryResult = UserAccountId.create(command.beneficiaryUserId);
    if (beneficiaryResult.isFailure()) return Result.failure('INVALID_BENEFICIARY_ID');
    const session = await this.sessionStore.get(command.actorSessionId);
    if (session === null) return Result.failure('SESSION_NOT_FOUND');
    const tenantId = tenantResult.getValue();
    const beneficiaryId = beneficiaryResult.getValue();

    return this.unitOfWork.withTransaction(async () => {
      if (!isAuthorized(session)) {
        await this.recordAudit(
          beneficiaryId.toString(),
          auditTenantId(session),
          tenantId.toString(),
          session,
          'DENIED',
          command.reason,
          command.correlationId,
        );
        return Result.failure<RequestTenantAdminRecoveryResult, RequestTenantAdminRecoveryError>('FORBIDDEN');
      }
      const tenantStatus = await this.tenantAccessChecker.checkAccess(tenantId);
      if (tenantStatus === 'NOT_FOUND') {
        await this.recordAudit(beneficiaryId.toString(), tenantId.toString(), tenantId.toString(), session, 'FAILURE', command.reason, command.correlationId);
        return Result.failure<RequestTenantAdminRecoveryResult, RequestTenantAdminRecoveryError>('TENANT_NOT_FOUND');
      }
      const beneficiary = await this.userAccounts.findById(beneficiaryId);
      if (beneficiary === null) {
        await this.recordAudit(beneficiaryId.toString(), tenantId.toString(), tenantId.toString(), session, 'FAILURE', command.reason, command.correlationId);
        return Result.failure<RequestTenantAdminRecoveryResult, RequestTenantAdminRecoveryError>('BENEFICIARY_NOT_FOUND');
      }
      const requesterId = requireSessionUserId(session);
      const requestId = TenantAdminRecoveryRequestId.create(this.idGenerator.generate());
      if (requestId.isFailure()) throw new Error('IdGenerator a produit un identifiant invalide pour TenantAdminRecoveryRequest.');
      const request = TenantAdminRecoveryRequest.request({
        id: requestId.getValue(),
        tenantId,
        beneficiaryUserId: beneficiaryId,
        requestedByUserId: requesterId,
        reason: command.reason,
        clock: this.clock,
      });
      if (request.isFailure()) {
        await this.recordAudit(beneficiaryId.toString(), tenantId.toString(), tenantId.toString(), session, 'FAILURE', command.reason, command.correlationId);
        return Result.failure<RequestTenantAdminRecoveryResult, RequestTenantAdminRecoveryError>('REASON_REQUIRED');
      }
      const recoveryRequest = request.getValue();
      if (!(await this.requests.save(recoveryRequest))) throw new Error('Création de demande de récupération non appliquée.');
      await this.membershipAuditTrail.record({
        eventType: 'TENANT_ADMIN_RECOVERY_REQUESTED',
        outcome: 'SUCCESS',
        tenantId: tenantId.toString(),
        actorKind: 'USER_PLATFORM',
        actorUserId: requesterId.toString(),
        actorRoleCodes: [],
        subjectUserId: beneficiaryId.toString(),
        targetId: tenantId.toString(),
        targetType: 'HEALTH_FACILITY',
        reason: recoveryRequest.reason,
        sessionId: session.sessionId,
        correlationId: command.correlationId ?? null,
      });
      return Result.success({ requestId: recoveryRequest.id.toString() });
    }, { tenantId });
  }

  private async recordAudit(
    subjectUserId: string,
    auditTenantId: string | null,
    targetTenantId: string,
    session: SessionContext,
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
    reason: string | null,
    correlationId: string | undefined,
  ): Promise<void> {
    const actor = auditActor(session);
    await this.membershipAuditTrail.record({
      eventType: 'TENANT_ADMIN_RECOVERY_REQUESTED',
      outcome,
      tenantId: auditTenantId,
      actorKind: actor.kind,
      actorUserId: actor.userId,
      actorRoleCodes: actor.roles,
      subjectUserId,
      targetId: targetTenantId,
      targetType: 'HEALTH_FACILITY',
      reason,
      sessionId: session.sessionId,
      correlationId: correlationId ?? null,
    });
  }
}

function auditTenantId(session: SessionContext): string | null {
  if (session.kind === 'TENANT') return session.tenantId;
  if (session.kind === 'MFA_PENDING' && session.intent.kind === 'TENANT') return session.intent.tenantId;
  return null;
}

function isAuthorized(session: SessionContext): boolean {
  return session.kind === 'PLATFORM' && session.mfaSatisfiedAt !== null;
}

function requireSessionUserId(session: SessionContext): UserAccountId {
  const result = UserAccountId.create(session.userId);
  if (result.isFailure()) throw new Error(`Identifiant d'acteur invalide dans la session (${session.userId}).`);
  return result.getValue();
}

function auditActor(session: SessionContext): { kind: 'USER_PLATFORM' | 'USER_TENANT'; userId: string; roles: readonly string[] } {
  if (session.kind === 'TENANT') return { kind: 'USER_TENANT', userId: session.userId, roles: session.roleCodes };
  if (session.kind === 'MFA_PENDING' && session.intent.kind === 'TENANT') {
    return { kind: 'USER_TENANT', userId: session.userId, roles: session.auditRoleCodes };
  }
  return { kind: 'USER_PLATFORM', userId: session.userId, roles: [] };
}
