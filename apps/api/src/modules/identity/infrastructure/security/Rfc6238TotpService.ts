import * as OTPAuth from 'otpauth';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { EncryptedTotpSecret } from '../../domain/value-objects/EncryptedTotpSecret.js';
import type { TotpProvisioning, TotpService, TotpVerificationOutcome } from '../../domain/ports/TotpService.js';
import { AesGcmSecretCipher } from './AesGcmSecretCipher.js';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
/** Fenetre de derive +-1 pas de temps (RFC 6238 §5.2) — ni plus large (fenetre de rejeu trop permissive), ni plus stricte (horloges client legerement desynchronisees). */
const TOTP_DRIFT_WINDOW_STEPS = 1;

/**
 * Implementation `TotpService` (ADR-0005 §2) : compose `AesGcmSecretCipher` (dechiffrement en
 * memoire, jamais persiste) et `otpauth` (RFC 6238 — SHA-1, 6 chiffres, periode 30s). Seul point
 * du code, avec `AesGcmSecretCipher`, qui manipule le secret TOTP en clair — jamais renvoye a
 * l'appelant (`verify()` ne retourne qu'un booleen + le pas de temps accepte).
 */
export class Rfc6238TotpService implements TotpService {
  constructor(
    private readonly cipher: AesGcmSecretCipher,
    private readonly issuer: string,
  ) {}

  async generateSecret(params: { userAccountId: string; accountLabel: string }): Promise<TotpProvisioning> {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = this.buildTotp(params.accountLabel, secret);
    const provisioningUri = totp.toString();
    const envelope = this.cipher.encrypt(secret.base32, params.userAccountId);
    const encryptedSecret = assertValid(EncryptedTotpSecret.create(envelope));
    return { encryptedSecret, provisioningUri };
  }

  async verify(params: {
    secret: EncryptedTotpSecret;
    userAccountId: string;
    code: string;
    at: Date;
  }): Promise<TotpVerificationOutcome> {
    const plainSecretBase32 = this.cipher.decrypt(params.secret.value, params.userAccountId);
    const secret = OTPAuth.Secret.fromBase32(plainSecretBase32);
    const totp = this.buildTotp(params.userAccountId, secret);
    const delta = totp.validate({
      token: params.code,
      timestamp: params.at.getTime(),
      window: TOTP_DRIFT_WINDOW_STEPS,
    });
    if (delta === null) {
      return { valid: false, timeStep: null };
    }
    const acceptedTimeStep = Math.floor(params.at.getTime() / 1000 / TOTP_PERIOD_SECONDS) + delta;
    return { valid: true, timeStep: acceptedTimeStep };
  }

  private buildTotp(label: string, secret: OTPAuth.Secret): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: this.issuer,
      label,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret,
    });
  }
}
