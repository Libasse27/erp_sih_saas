import type { ListTenantMembershipsResult, MembershipListItem } from '../../application/queries/ListTenantMemberships.js';
import type { MembershipStatus } from '../../domain/value-objects/MembershipStatus.js';

/**
 * DTO explicite (jamais l'agregat `UserTenantMembership` ni une ligne Prisma brute exposee —
 * regle 6 du system prompt) — reponse de `GET /api/v1/memberships` (Phase 1, deuxieme increment
 * vertical, permission `membership:administer`).
 */
export interface MembershipDto {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly roleCodes: readonly string[];
  readonly status: MembershipStatus;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

export interface MembershipListResponse {
  readonly memberships: readonly MembershipDto[];
  /** Curseur opaque (base64url) de la page suivante — `null` si la page courante est la derniere (meme convention qu'`AuditEntryListResponse.nextCursor`, module `audit`). */
  readonly nextCursor: string | null;
}

function toDto(item: MembershipListItem): MembershipDto {
  return {
    membershipId: item.membershipId,
    userId: item.userId,
    email: item.email,
    roleCodes: item.roleCodes,
    status: item.status,
    joinedAt: item.joinedAt.toISOString(),
    leftAt: item.leftAt === null ? null : item.leftAt.toISOString(),
  };
}

export function toMembershipListResponse(result: ListTenantMembershipsResult): MembershipListResponse {
  return { memberships: result.items.map(toDto), nextCursor: result.nextCursor };
}
