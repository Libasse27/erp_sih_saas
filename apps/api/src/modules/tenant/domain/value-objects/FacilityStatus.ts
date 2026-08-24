/**
 * Statut de cycle de vie minimal du tenant (01-target-architecture.md §6.4 : cette etape ne
 * modelise que le strict necessaire pour que l'agregat existe, soit cree et porte un cycle de
 * vie minimal — pas les etats pilotes par la facturation/abonnement, type "mode degrade"
 * (O-03), qui appartiennent au futur module Subscription, hors perimetre ici). Simple
 * enumeration litterale (pas de VO complet), meme choix que `MembershipStatus` : aucun
 * invariant au-dela de l'appartenance a cet ensemble ferme.
 */
export const FACILITY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

export function isFacilityStatus(value: string): value is FacilityStatus {
  return (FACILITY_STATUSES as readonly string[]).includes(value);
}
