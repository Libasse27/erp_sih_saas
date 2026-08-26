import type { EncryptedTotpSecret } from '../value-objects/EncryptedTotpSecret.js';

export interface TotpProvisioning {
  readonly encryptedSecret: EncryptedTotpSecret;
  /** URI `otpauth://` en clair — expose UNE SEULE FOIS a l'enrolement (rendu en QR code cote client), jamais persiste. */
  readonly provisioningUri: string;
}

export interface TotpVerificationOutcome {
  readonly valid: boolean;
  /** Pas de temps RFC 6238 accepte (fenetre de derive incluse) — `null` si `valid === false`. */
  readonly timeStep: number | null;
}

/**
 * Port de verification TOTP (ADR-0005 §2), aux cotes de `PasswordHasher`. L'implementation
 * (infrastructure/, RFC 6238 + AES-256-GCM) dechiffre le secret EN MEMOIRE et n'en ressort
 * jamais qu'un booleen + le pas de temps accepte — aucun appelant applicatif ne peut donc
 * journaliser, serialiser ou renvoyer un secret par accident.
 */
export interface TotpService {
  generateSecret(params: { userAccountId: string; accountLabel: string }): Promise<TotpProvisioning>;
  verify(params: {
    secret: EncryptedTotpSecret;
    userAccountId: string;
    code: string;
    at: Date;
  }): Promise<TotpVerificationOutcome>;
}
