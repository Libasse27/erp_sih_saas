import type { Prisma, PrismaClient } from '@prisma/client';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { encodeMembershipCursor } from '../../domain/MembershipCursor.js';
import { MEMBERSHIP_PAGE_MAX_LIMIT, type MembershipPageRequest, type UserTenantMembershipPage } from '../../domain/MembershipPage.js';
import type { MembershipStatus } from '../../domain/value-objects/MembershipStatus.js';
import { RoleId } from '../../domain/value-objects/RoleId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import { UserTenantMembershipId } from '../../domain/value-objects/UserTenantMembershipId.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';

interface MembershipRow {
  id: string;
  userId: string;
  tenantId: string;
  status: string;
  joinedAt: Date;
  leftAt: Date | null;
  createdAt: Date;
  createdBy: string;
  roles: readonly { roleId: string }[];
}

/**
 * Repository `UserTenantMembership` — table tenant-scoped, RLS FORCE (voir migration SQL).
 * Chaque methode filtre explicitement par `tenantId` (couche 3 de la defense en profondeur,
 * ADR-0001 §3.2) — le RLS Postgres est le filet de securite, jamais le seul filtre.
 */
export class PrismaUserTenantMembershipRepository implements UserTenantMembershipRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async findActiveByUserAndTenant(
    userId: UserAccountId,
    tenantId: TenantId,
  ): Promise<UserTenantMembership | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.userTenantMembership.findFirst({
      where: { userId: userId.toString(), tenantId: tenantId.toString(), status: 'ACTIVE' },
      include: { roles: true },
    });
    return row === null ? null : this.toDomain(row);
  }

  async findById(id: UserTenantMembershipId, tenantId: TenantId): Promise<UserTenantMembership | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.userTenantMembership.findFirst({
      where: { id: id.toString(), tenantId: tenantId.toString() },
      include: { roles: true },
    });
    return row === null ? null : this.toDomain(row);
  }

  async lockTenantForAdminRecovery(tenantId: TenantId): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    // Verrou advisory transactionnel namespace par la fonctionnalité, indépendant du schéma/table
    // du module Tenant. Les deux verrous int4 utilisent le même idiome que le chaînage d'audit ;
    // hashtext peut seulement sur-sérialiser en cas de collision, jamais laisser passer une course.
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tenant-admin-recovery'), hashtext(${tenantId.toString()}))`;
  }

  async listActiveTenantIdsForUser(userId: UserAccountId): Promise<readonly TenantId[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.userTenantMembership.findMany({
      where: { userId: userId.toString(), status: 'ACTIVE' },
      select: { tenantId: true },
    });
    return rows.map((row) => assertValid(TenantId.create(row.tenantId)));
  }

  async countActive(tenantId: TenantId): Promise<number> {
    const client = resolvePrismaClient(this.prisma);
    return client.userTenantMembership.count({
      where: { tenantId: tenantId.toString(), status: 'ACTIVE' },
    });
  }

  async listActiveByTenantAndRole(tenantId: TenantId, roleId: RoleId): Promise<readonly UserTenantMembership[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.userTenantMembership.findMany({
      where: {
        tenantId: tenantId.toString(),
        status: 'ACTIVE',
        roles: { some: { roleId: roleId.toString() } },
      },
      include: { roles: true },
    });
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Coeur de pagination `keyset` (meme convention que `PrismaAuditEntryRepository.listInternal`,
   * module `audit`) : tri `(joined_at DESC, id DESC)`, curseur OPAQUE deja decode par l'appelant
   * (query handler) — le filtre `tenantId` est TOUJOURS reapplique ICI, en plus du curseur, a
   * chaque page : "le curseur est une position, jamais une autorisation". `limit` est reborne
   * DEFENSIVEMENT ici (`Math.min`, couche 3 de la defense en profondeur, ADR-0001 §3.2) meme si
   * le query handler l'a deja valide — jamais une confiance aveugle dans l'appelant.
   */
  async listByTenant(
    tenantId: TenantId,
    filter: { readonly status?: MembershipStatus },
    page: MembershipPageRequest,
  ): Promise<UserTenantMembershipPage> {
    const client = resolvePrismaClient(this.prisma);
    const limit = Math.min(page.limit, MEMBERSHIP_PAGE_MAX_LIMIT);

    const where: Prisma.UserTenantMembershipWhereInput = { tenantId: tenantId.toString() };
    if (filter.status !== undefined) {
      where.status = filter.status;
    }
    if (page.cursor !== null) {
      where.OR = [
        { joinedAt: { lt: page.cursor.joinedAt } },
        { joinedAt: page.cursor.joinedAt, id: { lt: page.cursor.id } },
      ];
    }

    const rows = await client.userTenantMembership.findMany({
      where,
      include: { roles: true },
      orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeMembershipCursor({ joinedAt: lastRow.joinedAt.toISOString(), id: lastRow.id })
        : null;

    return { memberships: pageRows.map((row) => this.toDomain(row)), nextCursor };
  }

  async save(membership: UserTenantMembership, tenantId: TenantId): Promise<void> {
    if (!membership.tenantId.equals(tenantId)) {
      throw new Error(
        "Tentative de sauvegarde d'un UserTenantMembership hors du tenant du contexte courant.",
      );
    }
    const client = resolvePrismaClient(this.prisma);
    const membershipIdStr = membership.id.toString();
    const tenantIdStr = tenantId.toString();

    await client.userTenantMembership.upsert({
      where: { id: membershipIdStr },
      create: {
        id: membershipIdStr,
        userId: membership.userId.toString(),
        tenantId: tenantIdStr,
        status: membership.status,
        joinedAt: membership.joinedAt,
        leftAt: membership.leftAt,
        createdAt: membership.createdAt,
        createdBy: membership.createdBy.toString(),
      },
      update: {
        status: membership.status,
        leftAt: membership.leftAt,
      },
    });

    const existingRoleRows = await client.membershipRole.findMany({
      where: { membershipId: membershipIdStr, tenantId: tenantIdStr },
      select: { roleId: true },
    });
    const existingRoleIds = new Set(existingRoleRows.map((row) => row.roleId));
    const desiredRoleIds = new Set(membership.roleIds.map((roleId) => roleId.toString()));

    const toRemove = [...existingRoleIds].filter((roleId) => !desiredRoleIds.has(roleId));
    const toAdd = [...desiredRoleIds].filter((roleId) => !existingRoleIds.has(roleId));

    if (toRemove.length > 0) {
      await client.membershipRole.deleteMany({
        where: { membershipId: membershipIdStr, tenantId: tenantIdStr, roleId: { in: toRemove } },
      });
    }
    if (toAdd.length > 0) {
      const now = this.clock.now();
      await client.membershipRole.createMany({
        data: toAdd.map((roleId) => ({
          id: this.idGenerator.generate(),
          membershipId: membershipIdStr,
          roleId,
          tenantId: tenantIdStr,
          assignedAt: now,
        })),
      });
    }

    // Outbox (D9, etape 6/13) : ecrit DANS LA MEME TRANSACTION que les ecritures ci-dessus (meme
    // `client` resolu via `resolvePrismaClient`) — tous les appelants de `save()`
    // (GrantMembershipHandler, RevokeMembershipHandler...) executent deja sous
    // `unitOfWork.withTransaction`. Active ici le relais pour `MembershipGranted`/
    // `MembershipRevoked`/`MembershipRoleAssigned`/`MembershipRoleUnassigned`, jusqu'ici accumules
    // sur l'agregat mais jamais persistes nulle part.
    await writeDomainEventsToOutbox(client, membership.pullDomainEvents());
  }

  private toDomain(row: MembershipRow): UserTenantMembership {
    const id = assertValid(UserTenantMembershipId.create(row.id));
    const userId = assertValid(UserAccountId.create(row.userId));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const createdBy = assertValid(UserAccountId.create(row.createdBy));
    const roleIds = row.roles.map((role) => assertValid(RoleId.create(role.roleId)));
    return UserTenantMembership.reconstitute(id, {
      userId,
      tenantId,
      status: row.status as MembershipStatus,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
      createdAt: row.createdAt,
      createdBy,
      roleIds,
    });
  }
}
