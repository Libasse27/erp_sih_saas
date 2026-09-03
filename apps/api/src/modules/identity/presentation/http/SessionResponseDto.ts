import type { MfaPendingSessionContext, PlatformSessionContext, SessionContext, TenantSessionContext } from '../../application/ports/SessionStore.js';

/**
 * DTOs de reponse explicites (jamais `SessionContext` serialise tel quel — regle 6 du system
 * prompt, meme discipline qu'`AuditEntryDto`). ADR-0010 §6/§7 bis C : `permissionCodes`/
 * `roleCodes` sont exposes DELIBEREMENT (critere de sortie Phase 0 : "le frontend ne contient
 * aucune permission codee en dur") ; `membershipId`, `userId`, `requiresMfa`, `mfaSatisfiedAt`,
 * `sensitivityCategory`, `issuedAt` ne sont JAMAIS exposes.
 */
export interface AuthenticatedSessionResponse {
  readonly status: 'authenticated';
  readonly session: {
    readonly sessionId: string;
    readonly kind: 'TENANT' | 'PLATFORM';
    readonly tenantId: string | null;
    readonly roleCodes: readonly string[];
    readonly permissionCodes: readonly string[];
    readonly absoluteExpiresAt: string;
  };
  /** Retourne UNE SEULE FOIS, jamais relisible (ADR-0006 §4) — `null` uniquement pour `VerifyMfaChallengeResult.refreshToken` (contrat du handler, jamais remplace par une chaine vide, ADR-0010 §7 bis C). */
  readonly refreshToken: string | null;
}

export interface MfaRequiredResponse {
  readonly status: 'mfa_required';
  readonly mfa: {
    readonly pendingSessionId: string;
    readonly reason: 'CHALLENGE_REQUIRED' | 'ENROLLMENT_REQUIRED';
    readonly expiresAt: string;
  };
}

export interface ContextSelectionRequiredResponse {
  readonly status: 'context_selection_required';
  readonly availableTenantIds: readonly string[];
}

export type CreateSessionResponse = AuthenticatedSessionResponse | MfaRequiredResponse;

/**
 * Presentateur PARTAGE (ADR-0010 §7 bis C : "les deux routes produisent une session complete et
 * partagent le meme presentateur") — utilise a la fois par `SessionController.create` (branche
 * "authenticated" de l'union) et par `SessionController.verifyMfaChallenge` (seule reponse
 * possible en succes). N'accepte QUE `PlatformSessionContext`/`TenantSessionContext` : un
 * `MFA_PENDING` n'a structurellement pas sa place ici, voir les deux points d'appel pour la garde
 * runtime correspondante (`issueAfterChallenge()` ne peut pas en produire, mais le typage de
 * `VerifyMfaChallengeResult.session` reste l'union complete — ADR-0010 §6 dernier paragraphe).
 */
export function toAuthenticatedSessionResponse(
  session: PlatformSessionContext | TenantSessionContext,
  refreshToken: string | null,
): AuthenticatedSessionResponse {
  return {
    status: 'authenticated',
    session: {
      sessionId: session.sessionId,
      kind: session.kind,
      tenantId: session.kind === 'TENANT' ? session.tenantId : null,
      roleCodes: session.kind === 'TENANT' ? session.roleCodes : [],
      permissionCodes: session.kind === 'TENANT' ? session.permissionCodes : [],
      absoluteExpiresAt: session.absoluteExpiresAt,
    },
    refreshToken,
  };
}

function toMfaRequiredResponse(session: MfaPendingSessionContext): MfaRequiredResponse {
  return {
    status: 'mfa_required',
    mfa: {
      pendingSessionId: session.sessionId,
      reason: session.reason,
      expiresAt: session.expiresAt,
    },
  };
}

/**
 * `POST /api/v1/auth/sessions` (ADR-0010 §6) — traduit le resultat de
 * `ResolveTenantContextHandler` (session complete OU `MFA_PENDING`, jamais un troisieme cas a ce
 * stade : `context_selection_required` est decide AVANT tout appel a ce handler, voir
 * `SessionController.create`).
 */
export function toCreateSessionResponse(session: SessionContext, refreshToken: string | null): CreateSessionResponse {
  if (session.kind === 'MFA_PENDING') {
    return toMfaRequiredResponse(session);
  }
  return toAuthenticatedSessionResponse(session, refreshToken);
}
