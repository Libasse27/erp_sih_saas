import { randomBytes } from 'node:crypto';
import type { GeneratedRecoveryCodes, RecoveryCodeGenerator } from '../../domain/ports/RecoveryCodeGenerator.js';
import type { RecoveryCodeHasher } from '../../domain/ports/RecoveryCodeHasher.js';

/** Base32 Crockford — sans I/L/O/U (non ambigu a la transcription manuelle), 32 symboles (ADR-0005 §3). */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH_CHARS = 20;
const GROUP_SIZE = 5;
/** Plus grand multiple de 32 <= 256 : rejette les octets au-dela pour un tirage UNIFORME (ADR-0005 §3 : "pas un simple % 32"). */
const REJECTION_CEILING = 256 - (256 % CROCKFORD_ALPHABET.length);

function randomAlphabetChar(): string {
  let byte: number;
  do {
    byte = randomBytes(1)[0] as number;
  } while (byte >= REJECTION_CEILING);
  return CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length] as string;
}

function generateOneCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH_CHARS; i += 1) {
    raw += randomAlphabetChar();
  }
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP_SIZE) {
    groups.push(raw.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Implementation `RecoveryCodeGenerator` (ADR-0005 §3) : codes de 20 caracteres (100 bits
 * d'entropie), formates `XXXXX-XXXXX-XXXXX-XXXXX`, tires d'un CSPRNG (`crypto.randomBytes`) par
 * echantillonnage sans biais de modulo.
 */
export class CryptoRecoveryCodeGenerator implements RecoveryCodeGenerator {
  constructor(private readonly hasher: RecoveryCodeHasher) {}

  generate(count: number): GeneratedRecoveryCodes {
    const plainCodes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      plainCodes.push(generateOneCode());
    }
    return { plainCodes, hashes: plainCodes.map((code) => this.hasher.hash(code)) };
  }
}
