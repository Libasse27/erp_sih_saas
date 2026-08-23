/**
 * Statut d'un `UserTenantMembership` (decision d'etape geler : ACTIVE/SUSPENDED/REVOKED).
 * Simple enumeration litterale (pas de VO complet) : aucun invariant au-dela de l'appartenance
 * a cet ensemble ferme, les transitions autorisees sont protegees par l'agregat lui-meme.
 */
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isMembershipStatus(value: string): value is MembershipStatus {
  return (MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}
