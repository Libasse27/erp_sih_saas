/**
 * Port de generation du SECRET EN CLAIR d'un refresh token (ADR-0006 §4) — jamais persiste tel
 * quel, uniquement retourne au client au moment de l'emission/rotation. Aux cotes de
 * `RecoveryCodeGenerator` (meme famille : secret aleatoire haute entropie).
 */
export interface RefreshTokenGenerator {
  /** Chaine opaque, haute entropie (256 bits), encodee pour transport (base64url). */
  generate(): string;
}
