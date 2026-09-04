import type { SuperAdminBreakGlassRequest } from '../SuperAdminBreakGlassRequest.js';
import type { SuperAdminBreakGlassRequestId } from '../value-objects/SuperAdminBreakGlassRequestId.js';

/**
 * Port de persistance de `SuperAdminBreakGlassRequest` — table `platform.SuperAdminBreakGlassRequest`,
 * hors RLS (ADR-0005 Amendement 1 : meme regime que `RefreshToken`/`MfaEnrollment`, concept
 * d'identite/administration plateforme, jamais tenant-scope).
 */
export interface SuperAdminBreakGlassRequestRepository {
  /**
   * Persiste une nouvelle demande (toujours `true`), OU la transition `PENDING -> APPROVED` d'une
   * demande existante. Retourne `false` (JAMAIS une exception qui romprait la transaction en
   * cours) si CETTE transition precise a ete perdue face a un AUTRE approbateur concurrent (quorum
   * deja atteint entre-temps) — meme idiome que `RefreshTokenRepository.tryMarkRotatedIfActive` :
   * l'appelant (`ApproveSuperAdminBreakGlassHandler`) doit alors traiter `false` comme un refus
   * metier propre (`REQUEST_NOT_PENDING`, audite), jamais une erreur technique.
   */
  save(request: SuperAdminBreakGlassRequest): Promise<boolean>;
  findById(id: SuperAdminBreakGlassRequestId): Promise<SuperAdminBreakGlassRequest | null>;
}
