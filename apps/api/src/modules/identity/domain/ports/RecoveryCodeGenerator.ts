import type { RecoveryCodeHash } from '../value-objects/RecoveryCodeHash.js';

export interface GeneratedRecoveryCodes {
  /** Codes EN CLAIR — exposes une seule fois a l'appelant (ADR-0005 §3), jamais persistes. */
  readonly plainCodes: readonly string[];
  readonly hashes: readonly RecoveryCodeHash[];
}

/**
 * Port de generation des codes de recuperation (ADR-0005 §3 : 10 codes de 20 caracteres, base32
 * Crockford, tires d'un CSPRNG par echantillonnage sans biais de modulo).
 */
export interface RecoveryCodeGenerator {
  generate(count: number): GeneratedRecoveryCodes;
}
