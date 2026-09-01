import type { Role } from '../Role.js';
import type { SessionSensitivityCategory } from '../value-objects/SessionSensitivityCategory.js';

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
 *
 * `mfa` ajoutee a l'etape 7/13 (ADR-0005, "Consequences" : "sa seule evolution est l'ajout de la
 * ressource `mfa` a TENANT_ADMIN_RESOURCES") — quiconque detient `mfa:reset` (peut forcer le
 * ré-enrolement d'un tiers) est lui-meme soumis au MFA, application directe de l'escalade que ce
 * fichier documentait deja lui-meme.
 *
 * `audit` ajoutee a l'etape 11/13 (ADR-0009 §9) : quiconque detient `audit:read` — y compris via
 * un role personnalise d'etablissement — est lui-meme soumis au MFA, meme application directe de
 * l'escalade documentee ci-dessus ("a faire valider par l'architecte des qu'un module ulterieur
 * introduit une nouvelle ressource sensible ; en cas de doute, le choix retenu est d'inclure").
 * `ADMIN_ETABLISSEMENT` y etait deja soumis (via `membership`/`role`/`tenant-config`) ; cet ajout
 * couvre les futurs roles personnalises qui ne porteraient QUE `audit:read`.
 */
const TENANT_ADMIN_RESOURCES: ReadonlySet<string> = new Set(['membership', 'role', 'tenant-config', 'mfa', 'audit']);

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

/**
 * Categorie de sensibilite d'une session (O-06.1/O-06.2, ADR-0006 §1) — ajoutee a l'etape 8/13,
 * REUTILISE la meme classification que `requiresMfaForMembership`/`requiresMfaForPlatformContext`
 * ci-dessus (jamais une taxonomie plus fine : O-06.1 interdit explicitement une "troisieme
 * taxonomie de risque" distincte de celle d'O-04.1). N'introduit aucune nouvelle regle metier :
 * lit les memes ensembles de ressources/permissions, purement additif, les deux fonctions
 * ci-dessus restent inchangees et continuent de determiner le declenchement du MFA.
 */
export function resolveSessionSensitivityCategory(
  roles: readonly Role[],
): Extract<SessionSensitivityCategory, 'TENANT_MFA_REQUIRED' | 'TENANT_STANDARD'> {
  return requiresMfaForMembership(roles) ? 'TENANT_MFA_REQUIRED' : 'TENANT_STANDARD';
}
