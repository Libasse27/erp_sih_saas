import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { MFA_PENDING_SESSION_WINDOW_SECONDS } from '../../domain/MfaTuning.js';
import { requiresMfaForMembership, requiresMfaForPlatformContext } from '../../domain/services/MfaPolicy.js';
import { resolveEffectivePermissions } from '../../domain/services/PermissionResolver.js';
import type { MfaEnrollmentRepository } from '../../domain/ports/MfaEnrollmentRepository.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import type { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { MfaPendingSessionContext, SessionContext } from '../ports/SessionStore.js';
import type { TenantAccessChecker } from '../ports/TenantAccessChecker.js';

export type ContextIntent = { readonly kind: 'PLATFORM' } | { readonly kind: 'TENANT'; readonly tenantId: string };

export type SessionIssuanceError =
  | 'ACCOUNT_NOT_FOUND'
  | 'NOT_SUPER_ADMIN'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'MEMBERSHIP_NOT_FOUND_OR_INACTIVE';

/**
 * Erreurs de re-emission APRES un challenge MFA reussi (`VerifyMfaChallenge`). Volontairement
 * plus etroit que `SessionIssuanceError` : un membership revoque ou un tenant suspendu PENDANT
 * la fenetre de challenge est rapporte comme `CONTEXT_NO_LONGER_AVAILABLE` (ADR-0005 §4, dernier
 * paragraphe), jamais avec le detail granulaire qui n'a plus lieu d'etre a ce stade (le facteur
 * a deja ete prouve, le client n'a plus a "corriger" une intention deja validee cote serveur).
 */
export type PostChallengeIssuanceError = 'ACCOUNT_NOT_FOUND' | 'NOT_SUPER_ADMIN' | 'CONTEXT_NO_LONGER_AVAILABLE';

interface ResolvedMaterialsPlatform {
  readonly kind: 'PLATFORM';
  readonly requiresMfa: true;
}

interface ResolvedMaterialsTenant {
  readonly kind: 'TENANT';
  readonly tenantId: TenantId;
  readonly membershipId: string;
  readonly roleCodes: readonly string[];
  readonly permissionCodes: readonly string[];
  readonly requiresMfa: boolean;
}

type ResolvedMaterials = ResolvedMaterialsPlatform | ResolvedMaterialsTenant;

/**
 * Service applicatif UNIQUE appliquant la table de decision MFA (ADR-0005 §4) — utilise a la
 * fois par `ResolveTenantContext` (nouvelle ouverture de contexte) et par `VerifyMfaChallenge`
 * (re-emission apres preuve du second facteur). Extrait de `ResolveTenantContext.ts` (etape
 * 3/13) pour ne jamais dupliquer "comment resoudre roles/permissions depuis un userId + une
 * intention".
 *
 * | requiresMfa | enrolement actif | session emise                              |
 * |-------------|------------------|---------------------------------------------|
 * | true        | oui              | MFA_PENDING · CHALLENGE_REQUIRED             |
 * | true        | non              | MFA_PENDING · ENROLLMENT_REQUIRED            |
 * | false       | oui              | MFA_PENDING · CHALLENGE_REQUIRED             |
 * | false       | non              | session complete (comportement inchange)     |
 *
 * La troisieme ligne est un choix conservateur explicite (ADR-0005 §4) : un facteur une fois
 * active est TOUJOURS exigu, meme si le role courant ne l'impose plus.
 */
export class SessionContextIssuer {
  constructor(
    private readonly userAccountRepository: UserAccountRepository,
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly roleRepository: RoleRepository,
    private readonly tenantAccessChecker: TenantAccessChecker,
    private readonly mfaEnrollmentRepository: MfaEnrollmentRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  /** Utilise par `ResolveTenantContext` — peut produire `MFA_PENDING` ou une session complete. */
  async issueForNewContext(params: {
    userId: UserAccountId;
    intent: ContextIntent;
  }): Promise<Result<SessionContext, SessionIssuanceError>> {
    const materialsResult = await this.resolveMaterials(params.userId, params.intent);
    if (materialsResult.isFailure()) {
      return Result.failure(materialsResult.getError());
    }
    const materials = materialsResult.getValue();
    const enrollment = await this.unitOfWork.withTransaction(() =>
      this.mfaEnrollmentRepository.findByUserId(params.userId),
    );
    const hasActiveEnrollment = enrollment !== null && enrollment.isActive();
    return Result.success(this.buildSession(params.userId, materials, hasActiveEnrollment, null));
  }

  /**
   * Utilise par `VerifyMfaChallenge` APRES succes du second facteur — les roles/permissions sont
   * re-resolus depuis la base (jamais relus depuis la session en attente, ADR-0005 §4) et le
   * gate MFA n'est PAS re-applique (le facteur vient d'etre prouve dans cette meme requete).
   */
  async issueAfterChallenge(params: {
    userId: UserAccountId;
    intent: ContextIntent;
  }): Promise<Result<SessionContext, PostChallengeIssuanceError>> {
    const materialsResult = await this.resolveMaterials(params.userId, params.intent);
    if (materialsResult.isFailure()) {
      const error = materialsResult.getError();
      if (error === 'ACCOUNT_NOT_FOUND' || error === 'NOT_SUPER_ADMIN') {
        return Result.failure(error);
      }
      // TENANT_NOT_FOUND / TENANT_SUSPENDED / MEMBERSHIP_NOT_FOUND_OR_INACTIVE : le contexte
      // n'est plus disponible APRES la validation du facteur.
      return Result.failure('CONTEXT_NO_LONGER_AVAILABLE');
    }
    const materials = materialsResult.getValue();
    return Result.success(this.buildSession(params.userId, materials, true, this.clock.now().toISOString()));
  }

  private buildSession(
    userId: UserAccountId,
    materials: ResolvedMaterials,
    hasActiveEnrollment: boolean,
    mfaSatisfiedAt: string | null,
  ): SessionContext {
    const issuedAt = this.clock.now().toISOString();
    const sessionId = this.idGenerator.generate();

    if (mfaSatisfiedAt === null && (materials.requiresMfa || hasActiveEnrollment)) {
      const pending: MfaPendingSessionContext = {
        sessionId,
        kind: 'MFA_PENDING',
        userId: userId.toString(),
        intent:
          materials.kind === 'PLATFORM' ? { kind: 'PLATFORM' } : { kind: 'TENANT', tenantId: materials.tenantId.toString() },
        reason: hasActiveEnrollment ? 'CHALLENGE_REQUIRED' : 'ENROLLMENT_REQUIRED',
        auditRoleCodes: materials.kind === 'TENANT' ? materials.roleCodes : [],
        issuedAt,
        expiresAt: new Date(this.clock.now().getTime() + MFA_PENDING_SESSION_WINDOW_SECONDS * 1000).toISOString(),
      };
      return pending;
    }

    if (materials.kind === 'PLATFORM') {
      return {
        sessionId,
        kind: 'PLATFORM',
        userId: userId.toString(),
        requiresMfa: true,
        mfaSatisfiedAt,
        issuedAt,
      };
    }

    return {
      sessionId,
      kind: 'TENANT',
      userId: userId.toString(),
      tenantId: materials.tenantId.toString(),
      membershipId: materials.membershipId,
      roleCodes: materials.roleCodes,
      permissionCodes: materials.permissionCodes,
      requiresMfa: materials.requiresMfa,
      mfaSatisfiedAt,
      issuedAt,
    };
  }

  private async resolveMaterials(
    userId: UserAccountId,
    intent: ContextIntent,
  ): Promise<Result<ResolvedMaterials, SessionIssuanceError>> {
    const account = await this.unitOfWork.withTransaction(() => this.userAccountRepository.findById(userId));
    if (account === null) {
      return Result.failure('ACCOUNT_NOT_FOUND');
    }

    if (intent.kind === 'PLATFORM') {
      if (!account.isSuperAdmin()) {
        return Result.failure('NOT_SUPER_ADMIN');
      }
      return Result.success({ kind: 'PLATFORM', requiresMfa: requiresMfaForPlatformContext() });
    }

    const tenantIdResult = TenantId.create(intent.tenantId);
    if (tenantIdResult.isFailure()) {
      // Un ContextIntent TENANT porte toujours un tenantId deja valide a ce stade (verifie par
      // l'appelant AVANT d'invoquer ce service, voir ResolveTenantContext.ts) — une valeur
      // invalide ici trahirait un bug appelant, jamais un echec metier attendu.
      throw new Error(`SessionContextIssuer : ContextIntent TENANT invalide ("${intent.tenantId}").`);
    }
    const tenantId = tenantIdResult.getValue();

    const resolved = await this.unitOfWork.withTransaction(
      async () => {
        const access = await this.tenantAccessChecker.checkAccess(tenantId);
        if (access === 'NOT_FOUND') {
          return { kind: 'TENANT_NOT_FOUND' as const };
        }
        if (access === 'SUSPENDED') {
          return { kind: 'TENANT_SUSPENDED' as const };
        }
        const membership = await this.membershipRepository.findActiveByUserAndTenant(userId, tenantId);
        if (membership === null) {
          return { kind: 'MEMBERSHIP_NOT_FOUND' as const };
        }
        const roles = await this.roleRepository.findByIds(tenantId, membership.roleIds);
        return { kind: 'OK' as const, membership, roles };
      },
      { tenantId },
    );

    if (resolved.kind === 'TENANT_NOT_FOUND') {
      return Result.failure('TENANT_NOT_FOUND');
    }
    if (resolved.kind === 'TENANT_SUSPENDED') {
      return Result.failure('TENANT_SUSPENDED');
    }
    if (resolved.kind === 'MEMBERSHIP_NOT_FOUND') {
      return Result.failure('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
    }

    const permissions = resolveEffectivePermissions(resolved.roles);
    return Result.success({
      kind: 'TENANT',
      tenantId,
      membershipId: resolved.membership.id.toString(),
      roleCodes: resolved.roles.map((role) => role.code),
      permissionCodes: permissions.map((permission) => permission.code),
      requiresMfa: requiresMfaForMembership(resolved.roles),
    });
  }
}
