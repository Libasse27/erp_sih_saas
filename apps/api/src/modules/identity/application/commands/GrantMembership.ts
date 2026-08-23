import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';

export interface GrantMembershipCommand {
  readonly userId: string;
  readonly tenantId: string;
  readonly createdBy: string;
  /**
   * Codes de roles systeme initiaux (18 roles du catalogue). Les roles personnalises de tenant
   * ne sont pas composables par ce use case a cette etape (hors perimetre, voir rapport de
   * cette etape) — un membership peut toujours en recevoir via une commande dediee ulterieure.
   */
  readonly initialRoleCodes: readonly string[];
}

export type GrantMembershipError =
  | 'INVALID_USER_ID'
  | 'INVALID_TENANT_ID'
  | 'USER_NOT_FOUND'
  | 'MEMBERSHIP_ALREADY_EXISTS'
  | 'ROLE_NOT_FOUND';

export interface GrantMembershipResult {
  readonly membershipId: string;
}

export class GrantMembershipHandler {
  constructor(
    private readonly userAccountRepository: UserAccountRepository,
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly roleRepository: RoleRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: GrantMembershipCommand,
  ): Promise<Result<GrantMembershipResult, GrantMembershipError>> {
    const userIdResult = UserAccountId.create(command.userId);
    if (userIdResult.isFailure()) {
      return Result.failure('INVALID_USER_ID');
    }
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const createdByResult = UserAccountId.create(command.createdBy);
    if (createdByResult.isFailure()) {
      return Result.failure('INVALID_USER_ID');
    }
    const userId = userIdResult.getValue();
    const tenantId = tenantIdResult.getValue();
    const createdBy = createdByResult.getValue();

    const account = await this.unitOfWork.withTransaction(() =>
      this.userAccountRepository.findById(userId),
    );
    if (account === null) {
      return Result.failure('USER_NOT_FOUND');
    }

    return this.unitOfWork.withTransaction(async () => {
      const existing = await this.membershipRepository.findActiveByUserAndTenant(userId, tenantId);
      if (existing !== null) {
        return Result.failure('MEMBERSHIP_ALREADY_EXISTS');
      }

      const roleIds = [];
      for (const code of command.initialRoleCodes) {
        const role = await this.roleRepository.findSystemRoleByCode(code);
        if (role === null) {
          return Result.failure('ROLE_NOT_FOUND');
        }
        roleIds.push(role.id);
      }

      const membership = UserTenantMembership.grant({
        userId,
        tenantId,
        createdBy,
        initialRoleIds: roleIds,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      await this.membershipRepository.save(membership, tenantId);

      return Result.success({ membershipId: membership.id.toString() });
    }, { tenantId });
  }
}
