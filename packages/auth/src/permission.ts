/**
 * Contrat de permission cote client (docs/architecture/01-target-architecture.md §7.2).
 * Format : `<ressource>:<action>` (ex. "patient:read", "invoice:cancel").
 * Le catalogue de permissions est de niveau plateforme ; ce type ne fait que representer
 * la forme du contrat, il ne definit aucune regle d'autorisation (verifiee exclusivement
 * cote serveur, cf D5 : le client ne fournit jamais tenantId/role/permissions comme preuve).
 */
export type Permission = `${string}:${string}`;
