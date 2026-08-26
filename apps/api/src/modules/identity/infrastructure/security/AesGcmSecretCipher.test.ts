import { describe, expect, it } from 'vitest';
import { AesGcmSecretCipher, TotpSecretDecryptionError } from './AesGcmSecretCipher.js';

const KEY = Buffer.alloc(32, 7);
const USER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

describe('AesGcmSecretCipher', () => {
  it('chiffre puis dechiffre fidelement le secret en clair', () => {
    const cipher = new AesGcmSecretCipher(KEY, 'k1');
    const envelope = cipher.encrypt('JBSWY3DPEHPK3PXP', USER_ACCOUNT_ID);

    expect(cipher.decrypt(envelope, USER_ACCOUNT_ID)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejette (TotpSecretDecryptionError) une enveloppe dechiffree avec un userAccountId different (AAD ne correspond plus)', () => {
    const cipher = new AesGcmSecretCipher(KEY, 'k1');
    const envelope = cipher.encrypt('JBSWY3DPEHPK3PXP', USER_ACCOUNT_ID);

    expect(() => cipher.decrypt(envelope, OTHER_USER_ACCOUNT_ID)).toThrow(TotpSecretDecryptionError);
  });

  it('rejette (TotpSecretDecryptionError) une enveloppe chiffree avec un keyId inconnu', () => {
    const cipher = new AesGcmSecretCipher(KEY, 'k1');
    const otherKeyCipher = new AesGcmSecretCipher(KEY, 'k2');
    const envelope = otherKeyCipher.encrypt('JBSWY3DPEHPK3PXP', USER_ACCOUNT_ID);

    expect(() => cipher.decrypt(envelope, USER_ACCOUNT_ID)).toThrow(TotpSecretDecryptionError);
  });

  it('rejette (TotpSecretDecryptionError) un format d_enveloppe malforme (nombre de segments incorrect)', () => {
    const cipher = new AesGcmSecretCipher(KEY, 'k1');

    expect(() => cipher.decrypt('v1.k1.iv-only', USER_ACCOUNT_ID)).toThrow(TotpSecretDecryptionError);
  });

  describe('F-9 : validation de longueur IV/tag APRES decodage base64url, jamais une RangeError brute de node:crypto', () => {
    it('rejette (TotpSecretDecryptionError, PAS une RangeError) une enveloppe avec un IV tronque', () => {
      const cipher = new AesGcmSecretCipher(KEY, 'k1');
      const envelope = cipher.encrypt('JBSWY3DPEHPK3PXP', USER_ACCOUNT_ID);
      const [version, keyId, ivPart, tagPart, ciphertextPart] = envelope.split('.');
      const truncatedIv = Buffer.from(ivPart as string, 'base64url').subarray(0, 4).toString('base64url');
      const corrupted = [version, keyId, truncatedIv, tagPart, ciphertextPart].join('.');

      expect(() => cipher.decrypt(corrupted, USER_ACCOUNT_ID)).toThrow(TotpSecretDecryptionError);
    });

    it('rejette (TotpSecretDecryptionError, PAS une RangeError) une enveloppe avec un tag de mauvaise taille', () => {
      const cipher = new AesGcmSecretCipher(KEY, 'k1');
      const envelope = cipher.encrypt('JBSWY3DPEHPK3PXP', USER_ACCOUNT_ID);
      const [version, keyId, ivPart, tagPart, ciphertextPart] = envelope.split('.');
      const shortTag = Buffer.from(tagPart as string, 'base64url').subarray(0, 8).toString('base64url');
      const corrupted = [version, keyId, ivPart, shortTag, ciphertextPart].join('.');

      expect(() => cipher.decrypt(corrupted, USER_ACCOUNT_ID)).toThrow(TotpSecretDecryptionError);
    });

    it('rejette (TotpSecretDecryptionError, PAS une RangeError) une enveloppe avec un tag trop long', () => {
      const cipher = new AesGcmSecretCipher(KEY, 'k1');
      const envelope = cipher.encrypt('JBSWY3DPEHPK3PXP', USER_ACCOUNT_ID);
      const [version, keyId, ivPart, tagPart, ciphertextPart] = envelope.split('.');
      const longTag = Buffer.concat([Buffer.from(tagPart as string, 'base64url'), Buffer.alloc(4, 1)]).toString('base64url');
      const corrupted = [version, keyId, ivPart, longTag, ciphertextPart].join('.');

      expect(() => cipher.decrypt(corrupted, USER_ACCOUNT_ID)).toThrow(TotpSecretDecryptionError);
    });
  });
});
