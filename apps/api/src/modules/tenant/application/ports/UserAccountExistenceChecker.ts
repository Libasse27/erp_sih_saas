/**
 * Port explicite (01-target-architecture.md §5 : "un module n'importe jamais le domain/ d'un
 * autre module ; les echanges passent par des evenements ou des ports explicites") — meme
 * raisonnement que `modules/identity/application/ports/TenantAccessChecker.ts`, en sens INVERSE :
 * ici c'est Tenant qui a besoin de verifier une donnee d'Identity (existence d'un `UserAccount`),
 * sans jamais importer `modules/identity/domain/`.
 *
 * Permet a `CreateHealthFacilityHandler` de valider `ownerUserId` (ADR-0008 §9, amendement 1)
 * comme un `UserAccount` REELLEMENT EXISTANT avant de provisionner un tenant — jamais une simple
 * verification de FORME (un UUID syntaxiquement valide qui ne correspond a aucun compte reste un
 * echec, voir CreateHealthFacility.ts).
 *
 * L'implementation reelle (qui delegue au `UserAccountRepository` du module Identity) n'est
 * cablee ni dans Tenant ni dans Identity : elle vit dans `composition-root.ts`, seul endroit du
 * code autorise a connaitre les deux modules a la fois (meme regle que `TenantAccessChecker`).
 */
export interface UserAccountExistenceChecker {
  exists(userId: string): Promise<boolean>;
}
