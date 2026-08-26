import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const IV_LENGTH_BYTES = 12; // 96 bits, RFC recommande pour GCM
const TAG_LENGTH_BYTES = 16; // 128 bits, tag d'authentification GCM standard
const KEY_LENGTH_BYTES = 32; // AES-256

export class TotpSecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpSecretDecryptionError';
  }
}

interface DecodedEnvelope {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

function aad(userAccountId: string): Buffer {
  return Buffer.from(`mfa-totp-secret:v1:${userAccountId}`, 'utf8');
}

/**
 * Chiffrement AES-256-GCM du secret TOTP (ADR-0005 §2) — SEUL composant du depot qui manipule le
 * secret TOTP en clair au repos. IV aleatoire 96 bits PAR chiffrement (jamais reutilise), tag
 * d'authentification 128 bits, AAD liant le chiffre a l'utilisateur
 * (`mfa-totp-secret:v1:<userAccountId>`) : un chiffre deplace d'une ligne a une autre par un
 * attaquant disposant d'un acces en ecriture a la base est REJETE au dechiffrement (tag
 * invalide), jamais accepte silencieusement.
 *
 * Format persiste : `v1.<keyId>.<iv>.<tag>.<ciphertext>` (chaque segment en base64url) — voir
 * `EncryptedTotpSecret` (domain/) pour la validation de FORME de cette enveloppe (ce fichier ne
 * fait QUE la produire/consommer, `node:crypto` n'est jamais importe dans `domain/`).
 */
export class AesGcmSecretCipher {
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(key: Buffer, keyId: string) {
    if (key.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        `AesGcmSecretCipher : la cle doit faire exactement ${KEY_LENGTH_BYTES} octets (AES-256), recu ${key.length}.`,
      );
    }
    this.key = key;
    this.keyId = keyId;
  }

  encrypt(plainSecret: string, userAccountId: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(userAccountId));
    const ciphertext = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      this.keyId,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(envelope: string, userAccountId: string): string {
    const decoded = this.parse(envelope);
    if (decoded.keyId !== this.keyId) {
      // Rotation de cle non implementee (dette assumee, ADR-0005 "Consequences") : une enveloppe
      // chiffree avec un keyId different de la cle courante ne peut pas etre dechiffree ici.
      throw new TotpSecretDecryptionError(
        `Enveloppe TOTP chiffree avec une cle inconnue ("${decoded.keyId}", cle courante "${this.keyId}").`,
      );
    }
    // F-9 : `createDecipheriv`/`setAuthTag` DEPLACES a l'interieur du bloc `try` — ces deux appels
    // peuvent eux-memes lever (ex. longueur d'IV/tag invalide non deja rejetee par `parse()`,
    // toute autre erreur `node:crypto` liee a l'enveloppe) ; les laisser hors du `try` laissait
    // echapper une exception BRUTE de `node:crypto` (ex. `RangeError`/`TypeError`) au lieu de la
    // `TotpSecretDecryptionError` EXPLICITE que ce composant s'engage a toujours lever (ADR-0005 §2).
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, decoded.iv);
      decipher.setAAD(aad(userAccountId));
      decipher.setAuthTag(decoded.tag);
      const plaintext = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch {
      // Tag invalide OU AAD ne correspondant pas (secret deplace d'une ligne a une autre) :
      // erreur EXPLICITE, jamais un booleen ambigu avec "code invalide" (ADR-0005 §2).
      throw new TotpSecretDecryptionError('Echec du dechiffrement du secret TOTP (tag ou AAD invalide).');
    }
  }

  private parse(envelope: string): DecodedEnvelope {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
      throw new TotpSecretDecryptionError(
        'Enveloppe TOTP malformee (format attendu "v1.<keyId>.<iv>.<tag>.<ciphertext>").',
      );
    }
    const [, keyId, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string, string];
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    // F-9 : longueurs d'IV/tag validees APRES decodage base64url — une enveloppe corrompue/tronquee
    // (IV != 96 bits ou tag != 128 bits) doit lever `TotpSecretDecryptionError`, jamais laisser
    // `node:crypto` lever une `RangeError`/`TypeError` brute et non documentee plus loin.
    if (iv.length !== IV_LENGTH_BYTES) {
      throw new TotpSecretDecryptionError(
        `Enveloppe TOTP malformee : IV de ${iv.length} octet(s), ${IV_LENGTH_BYTES} attendus.`,
      );
    }
    if (tag.length !== TAG_LENGTH_BYTES) {
      throw new TotpSecretDecryptionError(
        `Enveloppe TOTP malformee : tag d'authentification de ${tag.length} octet(s), ${TAG_LENGTH_BYTES} attendus.`,
      );
    }
    return {
      keyId,
      iv,
      tag,
      ciphertext: Buffer.from(ciphertextPart, 'base64url'),
    };
  }
}
