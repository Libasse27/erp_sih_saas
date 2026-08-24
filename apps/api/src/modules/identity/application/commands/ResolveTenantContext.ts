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
import type { TenantExistenceChecker } from '../ports/TenantExistenceChecker.js';

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
  | 'TENANT_NOT_FOUND'
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
    private readonly tenantExistenceChecker: TenantExistenceChecker,
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

      // Verification d'existence du tenant AVANT le membership (ajoutee avec le module Tenant,
      // Phase 0 etape 3) : un membership ne prouve pas a lui seul que l'etablissement existe
      // encore (ex. tenant supprime par une voie hors perimetre de ce module) — defense en
      // profondeur supplementaire, distincte du RLS qui isole mais ne verifie pas l'existence.
      // Cette etape ne verifie que l'EXISTENCE, jamais le statut ACTIVE/SUSPENDED de
      // l'etablissement : lier le statut du tenant a la resolution de session serait une regle
      // metier non specifiee (aucun comportement de suspension d'acces n'est invente ici, voir
      // rapport de l'etape — a valider par l'architecte si un jour necessaire).
      const resolved = await this.unitOfWork.withTransaction(async () => {
        const tenantExists = await this.tenantExistenceChecker.exists(tenantId);
        if (!tenantExists) {
          return { kind: 'TENANT_NOT_FOUND' as const };
        }
        const membership = await this.membershipRepository.findActiveByUserAndTenant(userId, tenantId);
        if (membership === null) {
          return { kind: 'MEMBERSHIP_NOT_FOUND' as const };
        }
        const roles = await this.roleRepository.findByIds(tenantId, membership.roleIds);
        return { kind: 'OK' as const, membership, roles };
      }, { tenantId });

      if (resolved.kind === 'TENANT_NOT_FOUND') {
        return Result.failure('TENANT_NOT_FOUND');
      }
      if (resolved.kind === 'MEMBERSHIP_NOT_FOUND') {
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
