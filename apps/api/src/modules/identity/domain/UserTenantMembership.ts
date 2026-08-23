import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { MembershipGranted } from './events/MembershipGranted.js';
import { MembershipRevoked } from './events/MembershipRevoked.js';
import { MembershipRoleAssigned } from './events/MembershipRoleAssigned.js';
import { MembershipRoleUnassigned } from './events/MembershipRoleUnassigned.js';
import type { MembershipStatus } from './value-objects/MembershipStatus.js';
import type { RoleId } from './value-objects/RoleId.js';
import type { UserAccountId } from './value-objects/UserAccountId.js';
import { UserTenantMembershipId } from './value-objects/UserTenantMembershipId.js';

export class MembershipAlreadyRevokedError extends Error {
  constructor() {
    super('Ce membership est deja revoque.');
    this.name = 'MembershipAlreadyRevokedError';
  }
}

export class MembershipNotActiveError extends Error {
  constructor() {
    super("Ce membership n'est pas actif : aucun role ne peut lui etre attribue.");
    this.name = 'MembershipNotActiveError';
  }
}

interface UserTenantMembershipProps {
  readonly userId: UserAccountId;
  readonly tenantId: TenantId;
  status: MembershipStatus;
  readonly joinedAt: Date;
  leftAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: UserAccountId;
  roleIds: RoleId[];
}

/**
 * Appartenance d'un `UserAccount` a **un** etablissement (01-target-architecture.md §6.3, O-05).
 *
 * Le role est porte ici, pas par l'identite : `roleIds` peut contenir plusieurs roles
 * simultanes (union additive des permissions, voir services/PermissionResolver.ts). Table
 * tenant-scoped protegee par RLS FORCE (infrastructure/) — ce n'est PAS la seule barriere,
 * chaque repository filtre explicitement par `tenantId` en plus du RLS (defense en profondeur,
 * ADR-0001 §3.2).
 */
export class UserTenantMembership extends AggregateRoot<UserTenantMembershipId> {
  private props: UserTenantMembershipProps;

  private constructor(id: UserTenantMembershipId, props: UserTenantMembershipProps) {
    super(id);
    this.props = props;
  }

  static grant(params: {
    userId: UserAccountId;
    tenantId: TenantId;
    createdBy: UserAccountId;
    initialRoleIds: readonly RoleId[];
    clock: Clock;
    idGenerator: IdGenerator;
  }): UserTenantMembership {
    const idResult = UserTenantMembershipId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour UserTenantMembership.');
    }
    const id = idResult.getValue();
    const now = params.clock.now();
    const membership = new UserTenantMembership(id, {
      userId: params.userId,
      tenantId: params.tenantId,
      status: 'ACTIVE',
      joinedAt: now,
      leftAt: null,
      createdAt: now,
      createdBy: params.createdBy,
      roleIds: [...params.initialRoleIds],
    });
    membership.addDomainEvent(
      MembershipGranted.create({
        membershipId: id.toString(),
        tenantId: params.tenantId.toString(),
        userId: params.userId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    for (const roleId of params.initialRoleIds) {
      membership.addDomainEvent(
        MembershipRoleAssigned.create({
          membershipId: id.toString(),
          tenantId: params.tenantId.toString(),
          roleId: roleId.toString(),
          clock: params.clock,
          idGenerator: params.idGenerator,
        }),
      );
    }
    return membership;
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: UserTenantMembershipId, props: UserTenantMembershipProps): UserTenantMembership {
    return new UserTenantMembership(id, props);
  }

  get userId(): UserAccountId {
    return this.props.userId;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get status(): MembershipStatus {
    return this.props.status;
  }

  get joinedAt(): Date {
    return this.props.joinedAt;
  }

  get leftAt(): Date | null {
    return this.props.leftAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get createdBy(): UserAccountId {
    return this.props.createdBy;
  }

  get roleIds(): readonly RoleId[] {
    return this.props.roleIds;
  }

  isActive(): boolean {
    return this.props.status === 'ACTIVE';
  }

  assignRole(roleId: RoleId, clock: Clock, idGenerator: IdGenerator): Result<void, MembershipNotActiveError> {
    if (!this.isActive()) {
      return Result.failure(new MembershipNotActiveError());
    }
    if (this.props.roleIds.some((existing) => existing.equals(roleId))) {
      return Result.success(undefined);
    }
    this.props.roleIds.push(roleId);
    this.addDomainEvent(
      MembershipRoleAssigned.create({
        membershipId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        roleId: roleId.toString(),
        clock,
        idGenerator,
      }),
    );
    return Result.success(undefined);
  }

  removeRole(roleId: RoleId, clock: Clock, idGenerator: IdGenerator): void {
    const before = this.props.roleIds.length;
    this.props.roleIds = this.props.roleIds.filter((existing) => !existing.equals(roleId));
    if (this.props.roleIds.length === before) {
      return;
    }
    this.addDomainEvent(
      MembershipRoleUnassigned.create({
        membershipId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        roleId: roleId.toString(),
        clock,
        idGenerator,
      }),
    );
  }

  suspend(): void {
    this.props.status = 'SUSPENDED';
  }

  reactivate(): void {
    this.props.status = 'ACTIVE';
  }

  revoke(clock: Clock, idGenerator: IdGenerator): Result<void, MembershipAlreadyRevokedError> {
    if (this.props.status === 'REVOKED') {
      return Result.failure(new MembershipAlreadyRevokedError());
    }
    this.props.status = 'REVOKED';
    this.props.leftAt = clock.now();
    this.addDomainEvent(
      MembershipRevoked.create({
        membershipId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        userId: this.props.userId.toString(),
        clock,
        idGenerator,
      }),
    );
    return Result.success(undefined);
  }
}
