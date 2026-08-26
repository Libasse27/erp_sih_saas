import { createHmac } from 'node:crypto';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import type { RecoveryCodeHasher } from '../../domain/ports/RecoveryCodeHasher.js';
import { RecoveryCodeHash } from '../../domain/value-objects/RecoveryCodeHash.js';

/** Majuscules + suppression tirets/espaces — insensibilise la comparaison a la mise en forme d'affichage (`XXXXX-XXXXX-...`). */
function normalize(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Implementation `RecoveryCodeHasher` (ADR-0005 §3) : `HMAC-SHA-256(pepper, code_normalise)`,
 * enveloppe `v1.<pepperId>.<hmac base64url>`. Le poivre est une cle secrete (variable
 * d'environnement, JAMAIS en base) — une compromission de la base seule ne permet aucune attaque
 * hors ligne sur les codes de recuperation.
 */
export class HmacRecoveryCodeHasher implements RecoveryCodeHasher {
  constructor(
    private readonly pepper: string,
    private readonly pepperId: string,
  ) {}

  hash(plainCode: string): RecoveryCodeHash {
    const digest = createHmac('sha256', this.pepper).update(normalize(plainCode), 'utf8').digest('base64url');
    return assertValid(RecoveryCodeHash.create(`v1.${this.pepperId}.${digest}`));
  }
}
