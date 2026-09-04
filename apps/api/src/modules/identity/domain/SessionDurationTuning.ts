import type { SessionSensitivityCategory } from './value-objects/SessionSensitivityCategory.js';

/**
 * Politique de duree de session par categorie (O-06.1 plafond absolu / O-06.2 expiration
 * d'inactivite, ADR-0006 §3). Meme esprit que `MfaTuning.ts` : constantes nommees, groupees,
 * triviales a ajuster.
 *
 * VALEURS DEFINITIVES (Direction, 2026-09-03, ADR-0006 Amendement 1) — ne sont plus des
 * placeholders. O-06.1/O-06.2 sont clos dans docs/architecture/03-open-decisions.md.
 */
export interface SessionDurationPolicy {
  /** Duree de vie maximale d'une chaine depuis sa creation, quelle que soit l'activite (O-06.1). */
  readonly absoluteCeilingSeconds: number;
  /** Duree d'inactivite tolerable avant expiration, recalculee a chaque renouvellement (O-06.2). */
  readonly inactivitySeconds: number;
}

const SESSION_DURATION_POLICY_BY_CATEGORY: Readonly<Record<SessionSensitivityCategory, SessionDurationPolicy>> = {
  // SUPER_ADMIN : rayon inter-tenant, "obligation quasi structurelle" (O-04.1) — plafond le plus court.
  PLATFORM_SUPER_ADMIN: { absoluteCeilingSeconds: 4 * 60 * 60, inactivitySeconds: 15 * 60 },
  // Admin tenant + finance a fort impact (fusionnes, voir SessionSensitivityCategory.ts) — meme
  // regime que PLATFORM_SUPER_ADMIN (Amendement 1 : les deux categories "risque eleve" partagent
  // exactement les memes valeurs).
  TENANT_MFA_REQUIRED: { absoluteCeilingSeconds: 4 * 60 * 60, inactivitySeconds: 15 * 60 },
  // Role standard, MFA non exige par le plancher plateforme. S'applique aussi par defaut aux
  // postes partages/accueil (O-06.4) : aucun signal serveur ne distingue un poste partage, voir
  // ADR-0006 Amendement 1.
  TENANT_STANDARD: { absoluteCeilingSeconds: 12 * 60 * 60, inactivitySeconds: 30 * 60 },
};

export function resolveSessionDurationPolicy(category: SessionSensitivityCategory): SessionDurationPolicy {
  return SESSION_DURATION_POLICY_BY_CATEGORY[category];
}
