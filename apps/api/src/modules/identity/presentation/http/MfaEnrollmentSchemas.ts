import { z } from 'zod';

/**
 * `POST /api/v1/auth/mfa/enrollment` (ADR-0010 §7 bis A) — AUCUN corps de requete. La commande
 * `StartMfaEnrollmentCommand` n'a aucun champ hors `sessionId`/`correlationId` (tous deux portes
 * hors du corps JSON, voir `Authorization`/`X-Correlation-Id`) : tout corps NON VIDE est un rejet
 * explicite. Ce n'est pas du purisme — c'est la garantie que `{"userAccountId":"<autre compte>"}`
 * ne peut JAMAIS etre accepte sur cette route (F-2, ADR-0005), verifiee par un test dedie.
 * Applique a `req.body ?? {}` (body-parser ne definit pas `req.body` sur un corps absent sans
 * `Content-Type: application/json`).
 */
export const StartMfaEnrollmentBodySchema = z.object({}).strict();

/**
 * `POST /api/v1/auth/mfa/enrollment/confirmation` (ADR-0010 §7 bis B). `totpCode` : plafond de
 * TAILLE de charge utile uniquement (`min(1).max(32)`) — JAMAIS les 6 chiffres de `TOTP_DIGITS`
 * (parametre d'infrastructure, `Rfc6238TotpService`, non declare par le port `TotpService`) : la
 * validite reelle du code est decidee EXCLUSIVEMENT par `TotpService.verify()`.
 */
export const ConfirmMfaEnrollmentBodySchema = z
  .object({
    totpCode: z.string().min(1).max(32),
  })
  .strict();

export type ConfirmMfaEnrollmentBodyInput = z.infer<typeof ConfirmMfaEnrollmentBodySchema>;
