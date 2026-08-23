import type { UserAccount } from '../UserAccount.js';
import type { Email } from '../value-objects/Email.js';
import type { UserAccountId } from '../value-objects/UserAccountId.js';

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
