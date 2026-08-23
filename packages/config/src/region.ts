/**
 * Conventions regionales de la plateforme (docs/architecture/01-target-architecture.md §4).
 * Valeurs figees par le gel d'architecture Phase 0 : toute evolution (multi-devise,
 * multi-locale) passe par un nouvel ADR, pas par une modification silencieuse ici.
 */
export const REGION = {
  locale: 'fr-SN',
  timezone: 'Africa/Dakar',
  currency: 'XOF',
  countryCallingCode: '+221',
} as const;

export type Region = typeof REGION;
