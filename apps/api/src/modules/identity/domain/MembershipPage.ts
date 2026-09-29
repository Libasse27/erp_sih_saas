import type { UserTenantMembership } from './UserTenantMembership.js';

/**
 * Plafond de page pour `UserTenantMembershipRepository.listByTenant` (Phase 1, deuxieme
 * increment vertical — permission `membership:administer`) — MEME CONVENTION que
 * `modules/audit/domain/AuditPage.ts` (defaut 50, plafond 200), reprise ICI plutot qu'importee
 * (§5.1 du system prompt : "Aucun import direct entre modules"). Un depassement du plafond est
 * un REJET explicite (`INVALID_QUERY` -> 400 cote HTTP), jamais un plafonnement silencieux (§6).
 */
export const MEMBERSHIP_PAGE_DEFAULT_LIMIT = 50;
export const MEMBERSHIP_PAGE_MAX_LIMIT = 200;

export interface MembershipPageRequest {
  /** Curseur opaque DEJA DECODE par l'appelant (le port ne connait jamais la representation base64url) — `null` = premiere page. */
  readonly cursor: { readonly joinedAt: Date; readonly id: string } | null;
  readonly limit: number;
}

export interface UserTenantMembershipPage {
  readonly memberships: readonly UserTenantMembership[];
  /** Curseur opaque (base64url) de la page suivante — `null` si la page courante est la derniere. */
  readonly nextCursor: string | null;
}
