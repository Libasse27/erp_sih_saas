import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import type { TenantAdminRecoveryRequestRepository } from '../../domain/ports/TenantAdminRecoveryRequestRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { decodeMembershipCursor } from '../../domain/MembershipCursor.js';
import { MEMBERSHIP_PAGE_MAX_LIMIT } from '../../domain/MembershipPage.js';
import { TenantAdminRecoveryRequestId } from '../../domain/value-objects/TenantAdminRecoveryRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { MembershipAuditTrail } from '../ports/MembershipAuditTrail.js';
import type { TenantAccessChecker } from '../ports/TenantAccessChecker.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';

export interface ApproveTenantAdminRecoveryCommand {
  readonly requestId: string;
  readonly actorSessionId: string;
  readonly correlationId?: string;
}

export type ApproveTenantAdminRecoveryError =
  | 'INVALID_REQUEST_ID'
  | 'SESSION_NOT_FOUND'
  | 'FORBIDDEN'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_NOT_PENDING'
  | 'CANNOT_APPROVE_OWN_REQUEST'
  | 'TENANT_NOT_FOUND'
  | 'BENEFICIARY_NOT_FOUND'
  | 'TENANT_ALREADY_HAS_ADMIN'
  | 'ADMIN_ROLE_NOT_FOUND';

export interface ApproveTenantAdminRecoveryResult {
  readonly membershipId: string;
}

/** Approuve et exécute la récupération dans une transaction tenant-scoped. */
export class ApproveTenantAdminRecoveryHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly requests: TenantAdminRecoveryRequestRepository,
    private readonly userAccounts: UserAccountRepository,
    private readonly tenantAccessChecker: TenantAccessChecker,
    private readonly memberships: UserTenantMembershipRepository,
    private readonly roles: RoleRepository,
    private readonly membershipAuditTrail: MembershipAuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: ApproveTenantAdminRecoveryCommand): Promise<Result<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>> {
    const requestId = TenantAdminRecoveryRequestId.create(command.requestId);
    if (requestId.isFailure()) return Result.failure('INVALID_REQUEST_ID');
    const session = await this.sessionStore.get(command.actorSessionId);
    if (session === null) return Result.failure('SESSION_NOT_FOUND');
    if (!isAuthorized(session)) {
      await this.unitOfWork.withTransaction(async () => {
        await this.recordAudit(session.userId, auditTenantId(session), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'DENIED', null, command.correlationId);
      });
      return Result.failure('FORBIDDEN');
    }
    const approverId = requireSessionUserId(session);

    // La demande est une donnée platform hors RLS. La lecture préalable sert uniquement à obtenir
    // le tenant du contexte ; elle est relue après verrouillage dans la transaction autoritative.
    const preliminary = await this.unitOfWork.withTransaction(() => this.requests.findById(requestId.getValue()));
    if (preliminary === null) return Result.failure('REQUEST_NOT_FOUND');
    const tenantId = preliminary.tenantId;

    return this.unitOfWork.withTransaction(async () => {
      await this.memberships.lockTenantForAdminRecovery(tenantId);
      if ((await this.tenantAccessChecker.checkAccess(tenantId)) === 'NOT_FOUND') {
        await this.recordAudit(preliminary.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'FAILURE', preliminary.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('TENANT_NOT_FOUND');
      }
      const request = await this.requests.findById(requestId.getValue());
      if (request === null) return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('REQUEST_NOT_FOUND');
      if (request.status !== 'PENDING') {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'DENIED', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('REQUEST_NOT_PENDING');
      }
      if (request.requestedByUserId.equals(approverId)) {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'DENIED', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('CANNOT_APPROVE_OWN_REQUEST');
      }
      if ((await this.userAccounts.findById(request.beneficiaryUserId)) === null) {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'FAILURE', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('BENEFICIARY_NOT_FOUND');
      }
      const adminRole = await this.roles.findSystemRoleByCode('ADMIN_ETABLISSEMENT');
      if (adminRole === null || !adminRole.permissions.some((permission) => permission.code === 'membership:administer')) {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'FAILURE', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('ADMIN_ROLE_NOT_FOUND');
      }
      if (await this.hasActiveMembershipWithPermission(tenantId, 'membership:administer')) {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'DENIED', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('TENANT_ALREADY_HAS_ADMIN');
      }

      const approval = request.approve({ approverUserId: approverId, clock: this.clock });
      if (approval.isFailure()) {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'DENIED', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('REQUEST_NOT_PENDING');
      }
      if (!(await this.requests.save(request))) {
        await this.recordAudit(request.beneficiaryUserId.toString(), tenantId.toString(), session, 'TENANT_ADMIN_RECOVERY_APPROVED', 'DENIED', request.reason, command.correlationId);
        return Result.failure<ApproveTenantAdminRecoveryResult, ApproveTenantAdminRecoveryError>('REQUEST_NOT_PENDING');
      }

      const existingMembership = await this.memberships.findActiveByUserAndTenant(request.beneficiaryUserId, tenantId);
      let membership: UserTenantMembership;
      let membershipEvent: 'MEMBERSHIP_GRANTED' | 'MEMBERSHIP_ROLE_ASSIGNED';
      if (existingMembership !== null) {
        const assigned = existingMembership.assignRole(adminRole.id, this.clock, this.idGenerator);
        if (assigned.isFailure()) throw new Error('Membership actif devenu inactif dans la transaction de récupération.');
        membership = existingMembership;
        membershipEvent = 'MEMBERSHIP_ROLE_ASSIGNED';
      } else {
        membership = UserTenantMembership.grant({
          userId: request.beneficiaryUserId,
          tenantId,
          createdBy: approverId,
          initialRoleIds: [adminRole.id],
          clock: this.clock,
          idGenerator: this.idGenerator,
        });
        membershipEvent = 'MEMBERSHIP_GRANTED';
      }
      await this.memberships.save(membership, tenantId);
      await this.membershipAuditTrail.record({
        eventType: 'TENANT_ADMIN_RECOVERY_APPROVED',
        outcome: 'SUCCESS',
        tenantId: tenantId.toString(),
        actorKind: 'USER_PLATFORM',
        actorUserId: approverId.toString(),
        actorRoleCodes: [],
        subjectUserId: request.beneficiaryUserId.toString(),
        targetId: tenantId.toString(),
        targetType: 'HEALTH_FACILITY',
        reason: request.reason,
        sessionId: session.sessionId,
        correlationId: command.correlationId ?? null,
      });
      await this.membershipAuditTrail.record({
        eventType: membershipEvent,
        outcome: 'SUCCESS',
        tenantId: tenantId.toString(),
        actorKind: 'USER_PLATFORM',
        actorUserId: approverId.toString(),
        actorRoleCodes: [],
        subjectUserId: request.beneficiaryUserId.toString(),
        targetId: membership.id.toString(),
        reason: request.reason,
        sessionId: session.sessionId,
        correlationId: command.correlationId ?? null,
      });
      return Result.success({ membershipId: membership.id.toString() });
    }, { tenantId });
  }

  private async hasActiveMembershipWithPermission(tenantId: TenantId, permissionCode: string): Promise<boolean> {
    let cursor: { joinedAt: Date; id: string } | null = null;
    do {
      const page = await this.memberships.listByTenant(tenantId, { status: 'ACTIVE' }, { cursor, limit: MEMBERSHIP_PAGE_MAX_LIMIT });
      const roleIds = [...new Map(page.memberships.flatMap((membership) => membership.roleIds.map((id) => [id.toString(), id] as const))).values()];
      const roles = await this.roles.findByIds(tenantId, roleIds);
      if (roles.some((role) => role.permissions.some((permission) => permission.code === permissionCode))) return true;
      if (page.nextCursor === null) return false;
      const decoded = decodeMembershipCursor(page.nextCursor);
      if (decoded === null) throw new Error('Le repository a retourné un curseur de membership invalide.');
      cursor = { joinedAt: new Date(decoded.joinedAt), id: decoded.id };
    } while (true);
  }

  private async recordAudit(
    subjectUserId: string,
    tenantId: string | null,
    session: SessionContext,
    eventType: 'TENANT_ADMIN_RECOVERY_APPROVED',
    outcome: 'FAILURE' | 'DENIED',
    reason: string | null,
    correlationId: string | undefined,
  ): Promise<void> {
    await this.membershipAuditTrail.record({
      eventType,
      outcome,
      tenantId,
      actorKind: session.kind === 'TENANT' || (session.kind === 'MFA_PENDING' && session.intent.kind === 'TENANT') ? 'USER_TENANT' : 'USER_PLATFORM',
      actorUserId: session.userId,
      actorRoleCodes: session.kind === 'TENANT' ? session.roleCodes : session.kind === 'MFA_PENDING' ? session.auditRoleCodes : [],
      subjectUserId,
      targetId: tenantId ?? subjectUserId,
      ...(tenantId !== null ? { targetType: 'HEALTH_FACILITY' as const } : {}),
      reason,
      sessionId: session.sessionId,
      correlationId: correlationId ?? null,
    });
  }
}

function isAuthorized(session: SessionContext): boolean {
  return session.kind === 'PLATFORM' && session.mfaSatisfiedAt !== null;
}

function auditTenantId(session: SessionContext): string | null {
  if (session.kind === 'TENANT') return session.tenantId;
  if (session.kind === 'MFA_PENDING' && session.intent.kind === 'TENANT') return session.intent.tenantId;
  return null;
}

function requireSessionUserId(session: SessionContext): UserAccountId {
  const result = UserAccountId.create(session.userId);
  if (result.isFailure()) throw new Error(`Identifiant d'acteur invalide dans la session (${session.userId}).`);
  return result.getValue();
}
