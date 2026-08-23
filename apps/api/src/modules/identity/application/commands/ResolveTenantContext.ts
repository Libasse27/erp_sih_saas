import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { requiresMfaForMembership, requiresMfaForPlatformContext } from '../../domain/services/MfaPolicy.js';
import { resolveEffectivePermissions } from '../../domain/services/PermissionResolver.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';

export type ContextIntent = { readonly kind: 'PLATFORM' } | { readonly kind: 'TENANT'; readonly tenantId: string };

export interface ResolveTenantContextCommand {
  /** Identite deja verifiee par AuthenticateUser (2.4) — cette commande ne re-verifie pas le mot de passe. */
  readonly userId: string;
  /**
   * Selection d'intention soumise par le client. Jamais une preuve : le serveur la valide
   * systematiquement contre les memberships reels avant d'ouvrir un contexte (O-05).
   */
  readonly intent: ContextIntent;
  /**
   * Session actuellement ouverte, le cas echeant. Le changement de contexte ferme celle-ci et
   * en ouvre une nouvelle — jamais une mutation en place (O-05 §7.1).
   */
  readonly previousSessionId?: string;
}

export type ResolveTenantContextError =
  | 'INVALID_USER_ID'
  | 'INVALID_TENANT_ID'
  | 'ACCOUNT_NOT_FOUND'
  | 'NOT_SUPER_ADMIN'
  | 'MEMBERSHIP_NOT_FOUND_OR_INACTIVE';

export interface ResolveTenantContextResult {
  readonly session: SessionContext;
}

export class ResolveTenantContextHandler {
  constructor(
    private readonly userAccountRepository: UserAccountRepository,
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly roleRepository: RoleRepository,
    private readonly sessionStore: SessionStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: ResolveTenantContextCommand,
  ): Promise<Result<ResolveTenantContextResult, ResolveTenantContextError>> {
    const userIdResult = UserAccountId.create(command.userId);
    if (userIdResult.isFailure()) {
      return Result.failure('INVALID_USER_ID');
    }
    const userId = userIdResult.getValue();

    const account = await this.unitOfWork.withTransaction(() => this.userAccountRepository.findById(userId));
    if (account === null) {
      return Result.failure('ACCOUNT_NOT_FOUND');
    }

    let session: SessionContext;

    if (command.intent.kind === 'PLATFORM') {
      if (!account.isSuperAdmin()) {
        return Result.failure('NOT_SUPER_ADMIN');
      }
      session = {
        sessionId: this.idGenerator.generate(),
        kind: 'PLATFORM',
        userId: userId.toString(),
        requiresMfa: requiresMfaForPlatformContext(),
        issuedAt: this.clock.now().toISOString(),
      };
    } else {
      const tenantIdResult = TenantId.create(command.intent.tenantId);
      if (tenantIdResult.isFailure()) {
        return Result.failure('INVALID_TENANT_ID');
      }
      const tenantId = tenantIdResult.getValue();

      const resolved = await this.unitOfWork.withTransaction(async () => {
        const membership = await this.membershipRepository.findActiveByUserAndTenant(userId, tenantId);
        if (membership === null) {
          return null;
        }
        const roles = await this.roleRepository.findByIds(tenantId, membership.roleIds);
        return { membership, roles };
      }, { tenantId });

      if (resolved === null) {
        return Result.failure('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
      }

      const permissions = resolveEffectivePermissions(resolved.roles);
      session = {
        sessionId: this.idGenerator.generate(),
        kind: 'TENANT',
        userId: userId.toString(),
        tenantId: tenantId.toString(),
        membershipId: resolved.membership.id.toString(),
        roleCodes: resolved.roles.map((role) => role.code),
        permissionCodes: permissions.map((permission) => permission.code),
        requiresMfa: requiresMfaForMembership(resolved.roles),
        issuedAt: this.clock.now().toISOString(),
      };
    }

    // Changement de contexte = fermeture puis emission (jamais une mutation en place) : le
    // nouvel objet `session` ci-dessus ne partage aucun etat mutable avec l'ancien.
    if (command.previousSessionId !== undefined) {
      await this.sessionStore.delete(command.previousSessionId);
    }
    await this.sessionStore.create(session);

    return Result.success({ session });
  }
}
