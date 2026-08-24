import argon2 from 'argon2';
import type { PasswordHasher } from '../../domain/ports/PasswordHasher.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';

/** Argon2id, cout memoire eleve (regle 7.1) — jamais bcrypt/sha. */
export class Argon2PasswordHasher implements PasswordHasher {
  async hash(plainPassword: string): Promise<PasswordHash> {
    const hashed = await argon2.hash(plainPassword, { type: argon2.argon2id });
    return assertValid(PasswordHash.fromHash(hashed));
  }

  async verify(hash: PasswordHash, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(hash.value, plainPassword);
    } catch {
      // Hachage malforme ou incompatible : traite comme un echec de verification, jamais
      // comme une exception qui remonterait jusqu'a l'appelant (regle anti-enumeration 2.4).
      return false;
    }
  }
}
