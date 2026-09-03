import type { Request } from 'express';

/**
 * Extrait une chaine OPAQUE depuis `Authorization: Bearer <...>` — jamais depuis le corps JSON
 * (ADR-0010 §7 bis, correctif securite F-2 d'ADR-0005). Fonction PURE : aucun acces
 * `SessionStore`, aucun appel a `ServerContextResolver` — ce n'est PAS un second chemin de
 * resolution de contexte (ADR-0009 §8.2). Le handler applicatif (`StartMfaEnrollmentHandler`,
 * `ConfirmMfaEnrollmentHandler`, `VerifyMfaChallengeHandler`) reste le SEUL validateur de la
 * chaine retournee ici.
 *
 * Utilisee par les TROIS routes MFA (`MfaEnrollmentController`, `SessionController.verifyMfaChallenge`)
 * — jamais par un endpoint monte derriere `requireAuthenticatedContext` (qui a sa propre lecture
 * equivalente, dupliquee a dessein dans `composition-root.ts` : deux lectures structurellement
 * identiques mais des CONSOMMATEURS different, jamais partagees pour ne pas laisser un futur
 * changement de l'une affecter silencieusement l'autre).
 */
export function readBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  const bearerPrefix = 'Bearer ';
  if (header === undefined || !header.startsWith(bearerPrefix)) {
    return null;
  }
  const token = header.slice(bearerPrefix.length).trim();
  return token.length === 0 ? null : token;
}
