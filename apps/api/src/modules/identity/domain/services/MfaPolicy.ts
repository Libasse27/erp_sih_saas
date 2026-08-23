import type { Role } from '../Role.js';

/**
 * Plancher MFA obligatoire (O-04.1/O-04.2, 01-target-architecture.md §7.1) : declenchement par
 * **categorie de permission**, jamais par nom de role en dur, pour rester valide face aux
 * roles personnalises par etablissement.
 *
 * Deux categories composent le plancher plateforme non desactivable :
 *   - administration du tenant (gestion des comptes/roles/parametrage de l'etablissement) ;
 *   - operations financieres a fort impact ou irreversibles (annulation de facture,
 *     remboursement, cloture de caisse, validation d'ecriture comptable).
 *
 * Choix conservateur documente : le cahier des charges (§30/O-04.1) ne fournit pas la liste
 * exhaustive des permissions couvertes par ces deux categories — cette liste est deduite des
 * ressources explicitement citees en O-04.1 et 01-target-architecture.md §6.8/§7.1. A faire
 * valider par l'architecte des qu'un module ulterieur introduit une nouvelle ressource
 * sensible ; en cas de doute, le choix retenu est d'inclure (sur-couverture du MFA) plutot que
 * d'exclure.
 */
const TENANT_ADMIN_RESOURCES: ReadonlySet<string> = new Set(['membership', 'role', 'tenant-config']);

const HIGH_IMPACT_FINANCE_PERMISSION_CODES: ReadonlySet<string> = new Set([
  'invoice:cancel',
  'invoice:refund',
  'payment:refund',
  'cash-register:close',
  'journal-entry:validate',
  'journal-entry:extourne',
]);

/**
 * Les comptes `SUPER_ADMIN` sont soumis au MFA de maniere structurelle et inconditionnelle
 * (O-04.1 : "obligation quasi structurelle") — ce n'est pas une resolution de permissions,
 * c'est une regle fixe du contexte `PLATFORM`.
 */
export function requiresMfaForPlatformContext(): true {
  return true;
}

/**
 * Le plus restrictif l'emporte (O-05, regle derivee non optionnelle) : un membership est
 * soumis au MFA des qu'**un seul** de ses roles porte une permission d'une des deux
 * categories ci-dessus. Un cumul de roles ne peut jamais servir a contourner l'obligation
 * attachee a l'un d'eux.
 */
export function requiresMfaForMembership(roles: readonly Role[]): boolean {
  return roles.some((role) =>
    role.permissions.some(
      (permission) =>
        TENANT_ADMIN_RESOURCES.has(permission.resource) ||
        HIGH_IMPACT_FINANCE_PERMISSION_CODES.has(permission.code),
    ),
  );
}
