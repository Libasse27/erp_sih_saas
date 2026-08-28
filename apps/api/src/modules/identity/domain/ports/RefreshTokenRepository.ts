import type { RefreshToken, RefreshTokenRevocationReason } from '../RefreshToken.js';
import type { RefreshTokenHash } from '../value-objects/RefreshTokenHash.js';

/**
 * Port de persistance de `RefreshToken` — table `platform.RefreshToken`, hors RLS (ADR-0006 §4 :
 * meme regime que `MfaEnrollment`/`AuditEntry`, concept d'identite/session globale, pas de donnee
 * clinique tenant-scopee).
 */
export interface RefreshTokenRepository {
  /** Recherche par hash, QUEL QUE SOIT le statut (ACTIVE/ROTATED/REVOKED) — necessaire pour distinguer "jamais emis" de "reutilisation d'un token deja consomme" (ADR-0006 §6). */
  findByHash(hash: RefreshTokenHash): Promise<RefreshToken | null>;

  create(token: RefreshToken): Promise<void>;

  /**
   * Transition atomique `ACTIVE -> ROTATED` (`UPDATE ... WHERE token_hash = ? AND status =
   * 'ACTIVE'`, ADR-0006 §5) — MEME pattern que la consommation d'un code de recuperation
   * (ADR-0005 §3). Retourne `false` si la ligne n'etait plus `ACTIVE` au moment de l'ecriture (un
   * autre writer a gagne la course, ou une reutilisation est en cours) : l'appelant doit alors
   * traiter ce cas comme une reutilisation potentielle, jamais comme un succes silencieux.
   */
  tryMarkRotatedIfActive(hash: RefreshTokenHash, now: Date): Promise<boolean>;

  /**
   * Revoque TOUTES les lignes non deja `REVOKED` de la chaine (ADR-0006 §6). Idempotent. Retourne
   * l'ensemble des `sessionId` DISTINCTS portes par les lignes de la chaine (toutes generations
   * confondues) : le sessionId du token PRESENTE (potentiellement une generation perimee, deja
   * fermee) ne suffit PAS a identifier la session actuellement vivante — seule la chaine complete
   * le sait. L'appelant DOIT fermer chacun de ces sessionId cote `SessionStore` (suppression
   * idempotente pour les generations deja closes).
   */
  revokeChain(chainId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<readonly string[]>;

  /** Retrouve la chaine associee a une session courante puis la revoque — no-op si aucune ligne ne porte ce `sessionId` (deconnexion d'une session sans chaine, ou deja revoquee). */
  revokeChainBySessionId(sessionId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<void>;

  revokeAllForUser(userId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<void>;

  revokeAllForMembership(membershipId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<void>;
}
