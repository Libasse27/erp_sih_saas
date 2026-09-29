import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { RoleRepository } from '../../domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { decodeMembershipCursor } from '../../domain/MembershipCursor.js';
import { MEMBERSHIP_PAGE_MAX_LIMIT } from '../../domain/MembershipPage.js';
import type { MembershipStatus } from '../../domain/value-objects/MembershipStatus.js';
import { authorizeMembershipAdminister } from '../AuthorizeMembershipAdminister.js';
import type { MembershipAdminPrincipal } from '../MembershipAdminPrincipal.js';

export interface ListTenantMembershipsQuery {
  readonly principal: MembershipAdminPrincipal;
  readonly status?: MembershipStatus;
  readonly cursor: string | null;
  readonly limit: number;
}

export type ListTenantMembershipsError = 'FORBIDDEN' | 'INVALID_QUERY';

/** DTO applicatif explicite — jamais l'agregat `UserTenantMembership` ni une ligne Prisma brute exposee au-dela de cette couche (regle 6 du system prompt). */
export interface MembershipListItem {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly roleCodes: readonly string[];
  readonly status: MembershipStatus;
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
}

export interface ListTenantMembershipsResult {
  readonly items: readonly MembershipListItem[];
  readonly nextCursor: string | null;
}

/**
 * Consultation paginee des memberships du tenant courant (Phase 1, deuxieme increment vertical,
 * permission `membership:administer`) — TOUJOURS "mon propre etablissement", jamais un `tenantId`
 * fourni par l'appelant : derive EXCLUSIVEMENT de `principal` (deja resolu depuis le
 * `ServerContext` serveur, voir `MembershipAdminPrincipal.ts`/`composition-root.ts`).
 *
 * Query PURE (aucun effet de bord, aucune entree d'audit — convention deja en place dans ce
 * depot : seules les MUTATIONS produisent une `AuditEntry`, voir `GetHealthFacility.ts`, module
 * `tenant`, meme raisonnement).
 *
 * `unitOfWork.withTransaction(..., { tenantId })` est OBLIGATOIRE ici : `UserTenantMembership`
 * (et la table de jonction `MembershipRole`) sont sous RLS FORCE (schema `public`) — sans
 * transaction positionnant `app.tenant_id`, `PrismaUserTenantMembershipRepository` retombe sur le
 * client Prisma de base et ne verrait AUCUNE ligne (meme discipline que `GetHealthFacilityHandler`).
 * `UserAccountRepository.findByIds` (schema `platform`, hors RLS) est appele DANS LA MEME
 * transaction par simplicite — cela ne change rien a son comportement (aucune politique RLS ne
 * s'applique a ce schema), et evite une deuxieme transaction pour un gain nul.
 */
export class ListTenantMembershipsHandler {
  constructor(
    private readonly memberships: UserTenantMembershipRepository,
    private readonly userAccounts: UserAccountRepository,
    private readonly roles: RoleRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(query: ListTenantMembershipsQuery): Promise<Result<ListTenantMembershipsResult, ListTenantMembershipsError>> {
    if (query.limit < 1 || query.limit > MEMBERSHIP_PAGE_MAX_LIMIT) {
      return Result.failure('INVALID_QUERY');
    }

    let cursor: { joinedAt: Date; id: string } | null = null;
    if (query.cursor !== null) {
      const decoded = decodeMembershipCursor(query.cursor);
      if (decoded === null) {
        return Result.failure('INVALID_QUERY');
      }
      cursor = { joinedAt: new Date(decoded.joinedAt), id: decoded.id };
    }

    const authorization = authorizeMembershipAdminister(query.principal);
    if (authorization.isFailure()) {
      return Result.failure('FORBIDDEN');
    }
    const { tenantId } = authorization.getValue();

    const tenantIdResult = TenantId.create(tenantId);
    if (tenantIdResult.isFailure()) {
      // Un MembershipAdminPrincipal TENANT est toujours construit par composition-root.ts a
      // partir d'un ServerContext deja valide — un tenantId invalide ici trahit un bug appelant.
      throw new Error(`ListTenantMembershipsHandler : tenantId de principal invalide ("${tenantId}").`);
    }
    const tenantIdVo = tenantIdResult.getValue();

    const { items, nextCursor } = await this.unitOfWork.withTransaction(
      async () => {
        const page = await this.memberships.listByTenant(
          tenantIdVo,
          query.status !== undefined ? { status: query.status } : {},
          { cursor, limit: query.limit },
        );

        if (page.memberships.length === 0) {
          return { items: [] as readonly MembershipListItem[], nextCursor: page.nextCursor };
        }

        const userIds = dedupeById(page.memberships.map((membership) => membership.userId));
        const roleIds = dedupeById(page.memberships.flatMap((membership) => membership.roleIds));

        const [accounts, resolvedRoles] = await Promise.all([
          this.userAccounts.findByIds(userIds),
          this.roles.findByIds(tenantIdVo, roleIds),
        ]);

        const emailByUserId = new Map(accounts.map((account) => [account.id.toString(), account.email.value]));
        const roleCodeById = new Map(resolvedRoles.map((role) => [role.id.toString(), role.code]));

        const resolvedItems: MembershipListItem[] = page.memberships.map((membership) => {
          const userIdStr = membership.userId.toString();
          const email = emailByUserId.get(userIdStr);
          if (email === undefined) {
            // Invariant viole : `GrantMembershipHandler` verifie deja l'existence du UserAccount
            // AVANT d'octroyer un membership (voir GrantMembership.ts) — un membership sans
            // UserAccount correspondant est une corruption de donnees, jamais un cas metier
            // attendu. On ne degrade JAMAIS silencieusement un champ obligatoire du DTO (regle §6
            // du system prompt) : on leve, on ne renvoie pas une chaine vide.
            throw new Error(`ListTenantMembershipsHandler : aucun UserAccount pour membership.userId ("${userIdStr}").`);
          }
          return {
            membershipId: membership.id.toString(),
            userId: userIdStr,
            email,
            roleCodes: membership.roleIds
              .map((roleId) => roleCodeById.get(roleId.toString()))
              .filter((code): code is string => code !== undefined),
            status: membership.status,
            joinedAt: membership.joinedAt,
            leftAt: membership.leftAt,
          };
        });

        return { items: resolvedItems, nextCursor: page.nextCursor };
      },
      { tenantId: tenantIdVo },
    );

    return Result.success({ items, nextCursor });
  }
}

function dedupeById<T extends { toString(): string }>(values: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    byId.set(value.toString(), value);
  }
  return [...byId.values()];
}
