import type { RefreshTokenHash } from '../value-objects/RefreshTokenHash.js';

/**
 * Port de hachage d'un refresh token en clair (ADR-0006 §4) — HMAC poivre, deterministe, pour
 * permettre une recherche indexee en base (`findByHash`). Aux cotes de `RecoveryCodeHasher`
 * (meme raisonnement : secret aleatoire haute entropie, HMAC plutot qu'un hachage lent).
 */
export interface RefreshTokenHasher {
  hash(rawToken: string): RefreshTokenHash;
}
