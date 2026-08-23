/**
 * Statut plateforme d'un `UserAccount` : `SUPER_ADMIN` ou `NONE` (utilisateur d'etablissement
 * ordinaire, identifie par ses `UserTenantMembership`).
 *
 * Choix conservateur documente : le cahier des charges dit qu'un `UserAccount` "peut
 * representer un SUPER_ADMIN (sans membership)" sans preciser le mecanisme de distinction.
 * Deduire le statut SUPER_ADMIN de la simple absence de membership serait ambigu et dangereux
 * (un compte fraichement cree sans membership n'est pas necessairement un administrateur
 * plateforme) — un champ explicite, positionne uniquement par une operation d'administration
 * plateforme dediee, est le choix le plus sur. A confirmer par l'architecte.
 */
export const PLATFORM_ROLES = ['SUPER_ADMIN', 'NONE'] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
