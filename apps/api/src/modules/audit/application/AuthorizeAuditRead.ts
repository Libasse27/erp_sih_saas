import { Result } from '../../../shared-kernel/domain/Result.js';
import type { AuditReadPrincipal } from './AuditReadPrincipal.js';
import type { ListAuditEntriesRequestedScope } from './queries/ListAuditEntries.js';

/**
 * Deux sous-causes distinctes, TRADUITES en codes HTTP differents par le controleur (§8.5,
 * §3.2 du system prompt) : un parametre de perimetre presente par une session `TENANT` est un
 * `400` ("payload malforme" — ce parametre n'existe structurellement pas pour ce contrat), une
 * permission `audit:read` absente est un `403` ("authentifie mais non autorise"). Les DEUX
 * restent une SEULE et MEME notion de refus pour `ListAuditEntriesHandler`
 * (`Result.failure('FORBIDDEN')`, valeur exacte exigee par les tests d'isolation §10 de l'ADR).
 */
export type AuditReadAuthorizationError = 'SCOPE_NOT_ALLOWED' | 'MISSING_PERMISSION';

/**
 * Decision d'autorisation de lecture du journal (ADR-0009 §7/§9) — fonction PURE, SOURCE UNIQUE
 * de cette regle, appelee a la fois par :
 *   - la couche de presentation (AVANT `RecordAuditAccess` puis, seulement si autorisee,
 *     `ListAuditEntries` — §7) ;
 *   - `ListAuditEntriesHandler` lui-meme (defense en profondeur, §7.3 du system prompt :
 *     "verification cote serveur UNIQUEMENT, dans l'application" — jamais une confiance aveugle
 *     dans le fait que l'appelant a deja verifie).
 *
 * `TENANT` : `audit:read` obligatoire, ET aucun parametre de perimetre (`requestedScope`) —
 * meme une valeur qui "coinciderait" avec le tenant du principal reste rejetee (§8.5, jamais
 * ignoree silencieusement).
 * `PLATFORM` : toujours autorise, quel que soit le perimetre demande — `principal.kind ===
 * 'PLATFORM'` EST la preuve du statut SUPER_ADMIN (§9), jamais une permission testee dans une
 * session (`platform-audit:read` n'y est jamais materialisee).
 */
export function authorizeAuditRead(
  principal: AuditReadPrincipal,
  requestedScope: ListAuditEntriesRequestedScope | null,
): Result<void, AuditReadAuthorizationError> {
  if (principal.kind === 'PLATFORM') {
    return Result.success(undefined);
  }
  if (requestedScope !== null) {
    return Result.failure('SCOPE_NOT_ALLOWED');
  }
  if (!principal.permissionCodes.includes('audit:read')) {
    return Result.failure('MISSING_PERMISSION');
  }
  return Result.success(undefined);
}
