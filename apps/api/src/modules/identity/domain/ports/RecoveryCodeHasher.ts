import type { RecoveryCodeHash } from '../value-objects/RecoveryCodeHash.js';

/**
 * Port de hachage des codes de recuperation (ADR-0005 §3 : HMAC-SHA-256 avec poivre serveur,
 * PAS Argon2id — un code aleatoire de 100 bits d'entropie n'est pas attaquable hors ligne, et un
 * HMAC deterministe permet la consommation a usage unique via un UPDATE conditionnel indexe).
 */
export interface RecoveryCodeHasher {
  hash(plainCode: string): RecoveryCodeHash;
}
