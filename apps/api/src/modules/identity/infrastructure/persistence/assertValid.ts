import type { Result } from '../../../../shared-kernel/domain/Result.js';

/**
 * Une valeur invalide relue depuis la base est une corruption de donnees ou un bug, pas un
 * echec metier attendu — elle doit lancer, pas retourner un `Result` (regle §2 du system
 * prompt sur Result vs exceptions).
 */
export function assertValid<T, E extends Error>(result: Result<T, E>): T {
  if (result.isFailure()) {
    throw result.getError();
  }
  return result.getValue();
}
