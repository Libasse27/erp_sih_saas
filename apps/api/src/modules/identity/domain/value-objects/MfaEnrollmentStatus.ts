/**
 * Cycle de vie de `MfaEnrollment` (ADR-0005 §1). Trois valeurs, et trois seulement :
 * - `PENDING_ACTIVATION` : un facteur a ete provisionne mais jamais confirme par un code valide.
 * - `ACTIVE` : le facteur est operationnel, challengeable.
 * - `RESET_REQUIRED` : facteur revoque par `forceReEnrollment` (O-04.5 : jamais un etat
 *   "MFA non requis" — le compte reste soumis au MFA, seul un nouvel enrolement peut sortir de
 *   cet etat).
 */
export type MfaEnrollmentStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'RESET_REQUIRED';
