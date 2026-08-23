import type { PasswordHash } from '../value-objects/PasswordHash.js';

/**
 * Port de hachage de mot de passe. L'implementation (infrastructure/, Argon2id — regle 7.1)
 * est injectee, jamais appelee directement depuis le domaine : le domaine ne voit jamais un
 * mot de passe en clair au-dela de la frontiere de ce port, et n'importe aucune bibliotheque
 * de cryptographie (regle CI domain-no-framework).
 */
export interface PasswordHasher {
  hash(plainPassword: string): Promise<PasswordHash>;
  verify(hash: PasswordHash, plainPassword: string): Promise<boolean>;
}
