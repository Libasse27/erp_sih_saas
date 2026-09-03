import { z } from 'zod';

/**
 * Selection de contexte (ADR-0010 §6) — une SELECTION, jamais une preuve : le serveur la
 * revalide systematiquement contre les memberships reels via `ResolveTenantContextHandler`
 * (O-05). La transmettre depuis le client n'est donc pas l'anti-pattern qu'ADR-0008 §9 interdit
 * pour `ownerUserId`.
 */
const SessionContextSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TENANT'), tenantId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('PLATFORM') }).strict(),
]);

/**
 * `POST /api/v1/auth/sessions` (ADR-0010 §6). `.strict()` — anti mass-assignment (regle §7.3).
 *
 * DELIBEREMENT AUCUNE contrainte de format sur `email`/`password` au-dela du type/de la
 * non-vacuite : contrairement a `POST /api/v1/registrations` (§2/§3, bornes dupliquees comme
 * garde d'ordonnancement), la table d'erreurs du §6 ne classe JAMAIS un email malforme en `400` —
 * `AuthenticateUserHandler` le traduit en `401 invalid_credentials`, indistinct d'un mot de passe
 * faux (anti-enumeration, regle 2.4 du system prompt). Ajouter ici une regex d'email
 * transformerait une tentative de connexion malformee en `400`, un canal distinct de `401` qu'un
 * attaquant pourrait exploiter pour distinguer "format invalide" de "identifiants inconnus".
 */
export const CreateSessionBodySchema = z
  .object({
    email: z.string().min(1),
    password: z.string().min(1),
    context: SessionContextSelectionSchema.optional(),
  })
  .strict();

export type CreateSessionBodyInput = z.infer<typeof CreateSessionBodySchema>;

/**
 * `POST /api/v1/auth/sessions/mfa-challenge` (ADR-0010 §7 bis C) — union discriminee sur
 * `factor.kind`, chaque variante en `.strict()`, reprise litterale de `MfaChallengeFactorInput`.
 * `code` : plafond de TAILLE uniquement (`min(1).max(64)`) — jamais un format (6 chiffres TOTP OU
 * motif de code de recuperation) : la validite reelle appartient exclusivement a `TotpService`/
 * `HmacRecoveryCodeHasher` (domaine), jamais dupliquee ici (ADR-0010, Gate pour l'agent
 * d'implementation).
 */
const MfaChallengeFactorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TOTP'), code: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('RECOVERY_CODE'), code: z.string().min(1).max(64) }).strict(),
]);

export const VerifyMfaChallengeBodySchema = z
  .object({
    factor: MfaChallengeFactorSchema,
  })
  .strict();

export type VerifyMfaChallengeBodyInput = z.infer<typeof VerifyMfaChallengeBodySchema>;
