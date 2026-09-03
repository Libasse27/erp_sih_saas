import * as OTPAuth from 'otpauth';

/**
 * Calcule un code TOTP VALIDE a partir d'un `provisioningUri` (`otpauth://totp/...`) reellement
 * recu en reponse HTTP de `POST /api/v1/auth/mfa/enrollment` — jamais un secret connu a l'avance
 * du cote du test (ADR-0010, "Tests attendus" : "un code TOTP calcule DANS LE TEST depuis le
 * secret du `provisioningUri`"). Utilise le MEME package (`otpauth`) que
 * `Rfc6238TotpService.ts` (infrastructure), mais reste un calcul INDEPENDANT (le test ne
 * reimporte jamais `Rfc6238TotpService` lui-meme : ce serait tester le service avec lui-meme).
 */
export function computeTotpCode(provisioningUri: string, at: Date = new Date()): string {
  const totp = OTPAuth.URI.parse(provisioningUri);
  if (!(totp instanceof OTPAuth.TOTP)) {
    throw new Error(`provisioningUri inattendu (pas un TOTP) : "${provisioningUri}".`);
  }
  return totp.generate({ timestamp: at.getTime() });
}
