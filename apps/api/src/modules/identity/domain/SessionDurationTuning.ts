import type { SessionSensitivityCategory } from './value-objects/SessionSensitivityCategory.js';

/**
 * Politique de duree de session par categorie (O-06.1 plafond absolu / O-06.2 expiration
 * d'inactivite, ADR-0006 §3). Meme esprit que `MfaTuning.ts` : constantes nommees, groupees,
 * triviales a ajuster.
 *
 * DIFFERENCE ASSUMEE avec `MfaTuning.ts` : ces valeurs ne sont PAS confirmees par le responsable
 * technique. O-06.1/O-06.2 (docs/architecture/03-open-decisions.md) sont explicites : "Aucune
 * valeur par defaut n'a ete inventee." Les constantes ci-dessous sont des PLACEHOLDERS d'ordre de
 * grandeur conservateur, necessaires uniquement pour que le mecanisme de rotation (O-06.5, clos)
 * soit executable et testable — elles n'engagent AUCUNE decision de Direction medicale et ne
 * doivent JAMAIS etre citees comme une politique opposable en production avant arbitrage. Le
 * residu reste ouvert dans docs/architecture/03-open-decisions.md (O-06.1/O-06.2), inchange par
 * cette etape.
 *
 * A VALIDER METIER — NON DEFINITIF : remplacer ces valeurs par les valeurs arbitrees sera une
 * evolution purement additive (aucune migration de schema, aucune reecriture du mecanisme).
 */
export interface SessionDurationPolicy {
  /** Duree de vie maximale d'une chaine depuis sa creation, quelle que soit l'activite (O-06.1). */
  readonly absoluteCeilingSeconds: number;
  /** Duree d'inactivite tolerable avant expiration, recalculee a chaque renouvellement (O-06.2). */
  readonly inactivitySeconds: number;
}

const SESSION_DURATION_POLICY_BY_CATEGORY: Readonly<Record<SessionSensitivityCategory, SessionDurationPolicy>> = {
  // SUPER_ADMIN : rayon inter-tenant, "obligation quasi structurelle" (O-04.1) — plafond le plus court.
  PLATFORM_SUPER_ADMIN: { absoluteCeilingSeconds: 8 * 60 * 60, inactivitySeconds: 15 * 60 },
  // Admin tenant + finance a fort impact (fusionnes, voir SessionSensitivityCategory.ts).
  TENANT_MFA_REQUIRED: { absoluteCeilingSeconds: 12 * 60 * 60, inactivitySeconds: 30 * 60 },
  // Role standard, MFA non exige par le plancher plateforme.
  TENANT_STANDARD: { absoluteCeilingSeconds: 24 * 60 * 60, inactivitySeconds: 60 * 60 },
};

export function resolveSessionDurationPolicy(category: SessionSensitivityCategory): SessionDurationPolicy {
  return SESSION_DURATION_POLICY_BY_CATEGORY[category];
}
