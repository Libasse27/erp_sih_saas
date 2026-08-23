import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { UserTenantMembershipId } from '../../domain/value-objects/UserTenantMembershipId.js';
import type { SessionStore } from '../ports/SessionStore.js';

export interface RevokeMembershipCommand {
  readonly membershipId: string;
  readonly tenantId: string;
}

export type RevokeMembershipError =
  | 'INVALID_MEMBERSHIP_ID'
  | 'INVALID_TENANT_ID'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_ALREADY_REVOKED';

/**
 * Revocation d'un membership (O-05, regle derivee non optionnelle) : interdit immediatement
 * l'ouverture d'un nouveau contexte pour ce tenant (garanti par
 * `UserTenantMembershipRepository.findActiveByUserAndTenant`, filtre sur `status = ACTIVE`) et
 * invalide les contextes de session deja ouverts pour ce membership.
 */
export class RevokeMembershipHandler {
  constructor(
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly sessionStore: SessionStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: RevokeMembershipCommand): Promise<Result<void, RevokeMembershipError>> {
    const membershipIdResult = UserTenantMembershipId.create(command.membershipId);
    if (membershipIdResult.isFailure()) {
      return Result.failure('INVALID_MEMBERSHIP_ID');
    }
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const membershipId = membershipIdResult.getValue();
    const tenantId = tenantIdResult.getValue();

    const outcome = await this.unitOfWork.withTransaction(async () => {
      const membership = await this.membershipRepository.findById(membershipId, tenantId);
      if (membership === null) {
        return Result.failure<void, RevokeMembershipError>('MEMBERSHIP_NOT_FOUND');
      }
      const revokeResult = membership.revoke(this.clock, this.idGenerator);
      if (revokeResult.isFailure()) {
        return Result.failure<void, RevokeMembershipError>('MEMBERSHIP_ALREADY_REVOKED');
      }
      await this.membershipRepository.save(membership, tenantId);
      return Result.success<void, RevokeMembershipError>(undefined);
    }, { tenantId });

    if (outcome.isSuccess()) {
      await this.sessionStore.deleteAllForMembership(membershipId.toString());
    }
    return outcome;
  }
}
