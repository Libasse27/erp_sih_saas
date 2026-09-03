import type { UserAccount } from '../UserAccount.js';
import type { Email } from '../value-objects/Email.js';
import type { UserAccountId } from '../value-objects/UserAccountId.js';

/**
 * Levee par `save()` (implementation infrastructure) quand la contrainte UNIQUE `email` est
 * violee a l'ecriture — deux inscriptions CONCURRENTES avec le meme email peuvent toutes deux
 * lire `findByEmail() === null` avant que l'une des deux ne commite (revue de securite
 * independante de l'etape 12/13, BLOQUANT-2a). Declaree ICI (port, domaine) plutot que dans
 * l'implementation infrastructure : c'est le seul moyen pour `CreateUserAccountHandler`
 * (application) de la rattraper sans importer `infrastructure/` (regle de dependance des
 * couches, 01-target-architecture.md §5).
 */
export class UserAccountEmailAlreadyRegisteredError extends Error {
  constructor(email: string) {
    super(`UserAccount : email deja enregistre ("${email}") — course concurrente detectee.`);
    this.name = 'UserAccountEmailAlreadyRegisteredError';
  }
}

/**
 * Port de persistance pour `UserAccount` — niveau plateforme, hors RLS tenant (schema
 * `platform`). Aucune methode n'accepte de `tenantId` : ce n'est structurellement pas une
 * notion applicable a cet agregat (regle non negociable, voir UserAccount.ts).
 */
export interface UserAccountRepository {
  findById(id: UserAccountId): Promise<UserAccount | null>;
  findByEmail(email: Email): Promise<UserAccount | null>;
  save(account: UserAccount): Promise<void>;
}
