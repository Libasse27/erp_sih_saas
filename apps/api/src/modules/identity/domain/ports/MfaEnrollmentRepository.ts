import type { MfaEnrollment } from '../MfaEnrollment.js';
import type { UserAccountId } from '../value-objects/UserAccountId.js';

/**
 * Port de persistance de `MfaEnrollment` — schema `platform`, hors RLS (voir MfaEnrollment.ts,
 * ADR-0005 §1 : meme regime que `UserAccountRepository`, aucune methode ne prend de `tenantId`).
 * Au plus une ligne par utilisateur (`findByUserId`) : jamais de liste, jamais de recherche par
 * `MfaEnrollmentId` seul (aucun appelant applicatif n'a besoin de retrouver un enrolement
 * autrement que par son titulaire).
 */
export interface MfaEnrollmentRepository {
  findByUserId(userId: UserAccountId): Promise<MfaEnrollment | null>;
  /**
   * Variante VERROUILLANTE (`SELECT ... FOR UPDATE` cote PostgreSQL) de `findByUserId` (correctif
   * securite, revue independante F-3) : DOIT etre utilisee par tout appelant qui s'apprete a
   * EVALUER un code (TOTP ou code de recuperation) puis a persister le resultat de cette
   * evaluation (compteur `consecutiveFailedAttempts`, `lockedUntil`) — `ConfirmMfaEnrollment`,
   * `VerifyMfaChallenge`, `RegenerateMfaRecoveryCodes`. Sans ce verrou pessimiste, N requetes
   * concurrentes evaluant un mauvais code se resolvent par verrouillage OPTIMISTE (colonne
   * `version`) : une seule commite, les N-1 autres echouent sur conflit de version AVANT meme
   * d'ecrire leur `AuditEntry` — le compteur anti-brute-force et sa preuve d'audit sont alors
   * silencieusement perdus pour ces N-1 tentatives. `findByUserIdForUpdate` serialise au
   * contraire les tentatives concurrentes sur le verrou de ligne : chacune s'execute a son tour,
   * incremente reellement le compteur, et ecrit sa propre entree d'audit.
   *
   * DOIT etre appelee A L'INTERIEUR d'une transaction (`UnitOfWork.withTransaction`) — un verrou
   * de ligne hors transaction n'a aucun sens et serait relache immediatement.
   */
  findByUserIdForUpdate(userId: UserAccountId): Promise<MfaEnrollment | null>;
  save(enrollment: MfaEnrollment): Promise<void>;
}
