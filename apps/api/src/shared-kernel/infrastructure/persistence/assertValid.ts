import type { Result } from '../../domain/Result.js';

/**
 * Une valeur invalide relue depuis la base est une corruption de donnees ou un bug, pas un
 * echec metier attendu — elle doit lancer, pas retourner un `Result` (regle §2 du system
 * prompt sur Result vs exceptions).
 *
 * Vit dans shared-kernel/infrastructure/ (et non plus dans modules/identity/) depuis l'ajout du
 * module Tenant (Phase 0, etape 3) : fonction generique sans aucune dependance de domaine,
 * reutilisee par tous les repositories Prisma, quel que soit leur module.
 */
export function assertValid<T, E extends Error>(result: Result<T, E>): T {
  if (result.isFailure()) {
    throw result.getError();
  }
  return result.getValue();
}
