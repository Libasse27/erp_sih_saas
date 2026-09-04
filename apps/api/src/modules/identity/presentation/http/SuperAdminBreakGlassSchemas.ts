import { z } from 'zod';

/**
 * Meme motif exact que les VO domaine (`UserAccountId`/`SuperAdminBreakGlassRequestId`,
 * ADR-0005 Amendement 1) — valide ICI, a la frontiere HTTP, pour que tout `subjectUserAccountId`/
 * `requestId` syntaxiquement invalide recoive `400 invalid_request` plutot que d'atteindre le
 * `throw` defensif interne des handlers (`RequestSuperAdminBreakGlassHandler`/
 * `ApproveSuperAdminBreakGlassHandler`), reserve aux corruptions internes (session/Redis), jamais
 * a une entree HTTP non fiable.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `POST /api/v1/platform/super-admin/break-glass-requests` (ADR-0005 Amendement 1, O-04
 * residu 4). `reason` : plafond de TAILLE de charge utile uniquement (`min(1).max(500)`) — le
 * caractere non-vide APRES `trim()` reste decide par le domaine
 * (`SuperAdminBreakGlassRequest.request`), jamais reimplemente ici.
 */
export const RequestSuperAdminBreakGlassBodySchema = z
  .object({
    subjectUserAccountId: z.string().regex(UUID_V4_PATTERN),
    reason: z.string().min(1).max(500),
  })
  .strict();

/**
 * `POST /api/v1/platform/super-admin/break-glass-requests/:requestId/approval` — AUCUN corps de
 * requete (meme discipline que `StartMfaEnrollmentBodySchema` : tout corps NON VIDE est un rejet
 * explicite, `requestId` est le SEUL parametre, porte par l'URL).
 */
export const ApproveSuperAdminBreakGlassBodySchema = z.object({}).strict();

export const SuperAdminBreakGlassRequestIdParamSchema = z
  .object({
    requestId: z.string().regex(UUID_V4_PATTERN),
  })
  .strict();
