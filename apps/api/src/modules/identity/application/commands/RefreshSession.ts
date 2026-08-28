import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { RefreshToken, RefreshTokenRevocationReason } from '../../domain/RefreshToken.js';
import type { RefreshTokenRepository } from '../../domain/ports/RefreshTokenRepository.js';
import type { ContextIntent, SessionContextIssuer } from '../services/SessionContextIssuer.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';
import type { PlatformSessionContext, SessionStore, TenantSessionContext } from '../ports/SessionStore.js';
import type { SessionAuditRecordInput, SessionAuditTrail } from '../ports/SessionAuditTrail.js';

export interface RefreshSessionCommand {
  readonly refreshToken: string;
  readonly correlationId?: string;
}

export type RefreshSessionError =
  | 'INVALID_TOKEN'
  | 'REUSE_DETECTED'
  | 'CHAIN_ALREADY_REVOKED'
  | 'ABSOLUTE_CEILING_EXCEEDED'
  | 'INACTIVITY_TIMEOUT_EXCEEDED'
  | 'CONTEXT_NO_LONGER_AVAILABLE'
  | 'CONCURRENT_REFRESH_CONFLICT';

export interface RefreshSessionResult {
  readonly session: PlatformSessionContext | TenantSessionContext;
  readonly refreshToken: string;
}

/**
 * Renouvelle une session via son refresh token (O-06.5, ADR-0006). Ordre DELIBERE, jamais
 * inversé : 1) valider la ligne presentee (lecture seule) — 2) SI valide, resoudre le nouveau
 * contexte (peut encore echouer : membership revoque, tenant suspendu) — 3) SEULEMENT si les
 * deux ont reussi, consommer atomiquement la ligne presentee et creer la suivante. Ne jamais
 * consommer la ligne avant de savoir que le renouvellement va reellement aboutir : une ligne
 * consommee pour rien serait indiscernable d'une reutilisation lors d'une tentative suivante.
 *
 * Ne relance JAMAIS la table de decision MFA (voir `SessionContextIssuer.issueForRefresh`) — une
 * chaine n'existe que pour une session deja complete (ADR-0006 §7).
 */
export class RefreshSessionHandler {
  constructor(
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    /** Acces DIRECT au repository (pas seulement via `refreshTokenIssuer`) : les chemins d'echec ci-dessous doivent revoquer la chaine ET ecrire l'entree d'audit DANS LA MEME TRANSACTION (voir `revokeAndAudit`) — meme discipline que `VerifyMfaChallengeHandler`, qui prend `mfaEnrollmentRepository` directement pour la meme raison. */
    private readonly refreshTokenRepository: RefreshTokenRepository,
    private readonly sessionContextIssuer: SessionContextIssuer,
    private readonly sessionStore: SessionStore,
    private readonly sessionAuditTrail: SessionAuditTrail,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: RefreshSessionCommand): Promise<Result<RefreshSessionResult, RefreshSessionError>> {
    const validation = await this.refreshTokenIssuer.validateForRotation(command.refreshToken);

    if (validation.kind === 'NOT_FOUND') {
      // Aucun sujet identifiable : pas d'entree d'audit honnete possible (meme raisonnement que
      // ForceMfaReEnrollment.SESSION_NOT_FOUND — voir ce handler).
      return Result.failure('INVALID_TOKEN');
    }

    if (validation.kind === 'REUSE_DETECTED') {
      await this.revokeAndAudit(validation.record, 'REUSE_DETECTED', 'SESSION_REFRESH_REUSE_DETECTED', 'DENIED', command.correlationId ?? null);
      return Result.failure('REUSE_DETECTED');
    }

    if (validation.kind === 'CHAIN_ALREADY_REVOKED') {
      // La chaine a deja ete fermee (deconnexion, changement de contexte, revocation de
      // membership, ou une reutilisation/expiration deja traitee) — refus propre, SANS re-audit
      // ni nouvelle revocation (deja faite, idempotente de toute facon). Voir la doc de
      // `RefreshTokenValidationOutcome` : ne jamais confondre avec une reutilisation active.
      return Result.failure('CHAIN_ALREADY_REVOKED');
    }

    if (validation.kind === 'ABSOLUTE_CEILING_EXCEEDED') {
      await this.revokeAndAudit(validation.record, 'ABSOLUTE_CEILING_EXCEEDED', 'SESSION_ABSOLUTE_CEILING_EXCEEDED', 'FAILURE', command.correlationId ?? null);
      return Result.failure('ABSOLUTE_CEILING_EXCEEDED');
    }

    if (validation.kind === 'INACTIVITY_TIMEOUT_EXCEEDED') {
      await this.revokeAndAudit(validation.record, 'INACTIVITY_TIMEOUT', 'SESSION_INACTIVITY_TIMEOUT', 'FAILURE', command.correlationId ?? null);
      return Result.failure('INACTIVITY_TIMEOUT_EXCEEDED');
    }

    const record = validation.record;
    const previousSession = await this.sessionStore.get(record.sessionId);
    if (previousSession === null || previousSession.kind === 'MFA_PENDING') {
      // CORRECTIF SECURITE (revue independante) — fail-CLOSED, jamais fail-open : l'absence de la
      // session d'origine (evincee, TTL desynchronise, ou toute autre anomalie) ne doit JAMAIS
      // degrader silencieusement `mfaSatisfiedAt` a `null` et laisser le renouvellement aboutir
      // quand meme — c'est precisement la forme qu'une session complete ne doit structurellement
      // jamais prendre (`SessionStore.ts`, doc de `PlatformSessionContext`). Une session d'origine
      // introuvable est traitee comme un contexte qui n'est plus disponible, chaine revoquee.
      await this.revokeAndAudit(record, 'CONTEXT_NO_LONGER_AVAILABLE', 'SESSION_REFRESH_REVOKED', 'FAILURE', command.correlationId ?? null, []);
      return Result.failure('CONTEXT_NO_LONGER_AVAILABLE');
    }
    const previousMfaSatisfiedAt = previousSession.mfaSatisfiedAt;
    const previousRoleCodes = previousSession.kind === 'TENANT' ? previousSession.roleCodes : [];

    const intent: ContextIntent = record.tenantId === null ? { kind: 'PLATFORM' } : { kind: 'TENANT', tenantId: record.tenantId.toString() };

    const sessionResult = await this.sessionContextIssuer.issueForRefresh({
      userId: record.userId,
      intent,
      previousMfaSatisfiedAt,
      chainAbsoluteExpiresAt: record.absoluteExpiresAt.toISOString(),
    });
    if (sessionResult.isFailure()) {
      await this.revokeAndAudit(record, 'CONTEXT_NO_LONGER_AVAILABLE', 'SESSION_REFRESH_REVOKED', 'FAILURE', command.correlationId ?? null, previousRoleCodes);
      return Result.failure('CONTEXT_NO_LONGER_AVAILABLE');
    }
    const session = sessionResult.getValue();

    // CORRECTIF SECURITE (revue independante) — la session Redis est creee AVANT de committer la
    // rotation Postgres (jamais apres) : si `completeRotation` echoue ou si le processus meurt
    // entre les deux, aucun jeton n'a ete consomme pour rien — un `sessionId` tentative orphelin,
    // jamais renvoye au client (voir la compensation ci-dessous), est totalement inerte, alors
    // que l'ordre inverse pouvait transformer une panne Redis transitoire en faux
    // `SESSION_REFRESH_REUSE_DETECTED` au prochain essai legitime.
    await this.sessionStore.create(session);
    const rotated = await this.refreshTokenIssuer.completeRotation({ previous: record, newSessionId: session.sessionId });
    if (rotated === null) {
      // Course concurrente perdue (ADR-0006 §5, nuance) — PAS une reutilisation : echec propre,
      // aucune revocation, aucun audit SESSION_* (une perte de course ordinaire n'est pas un
      // signal de securite). La requete gagnante conserve sa session/chaine intactes ; la notre,
      // tentative et jamais retournee au client, est compensee immediatement.
      await this.sessionStore.delete(session.sessionId);
      return Result.failure('CONCURRENT_REFRESH_CONFLICT');
    }

    // CORRECTIF SECURITE (revue independante) — re-verification de fraicheur : entre le commit de
    // `completeRotation` ci-dessus et cet instant, une revocation CONCURRENTE (deconnexion,
    // revocation de membership, ré-enrolement MFA force) a pu invalider la ligne fraichement
    // creee. Sans cette relecture, la session Redis venant d'etre ecrite survivrait a une
    // fermeture forcee jusqu'a l'expiration de sa TTL.
    const stillActive = await this.refreshTokenRepository.findByHash(rotated.record.tokenHash);
    if (stillActive === null || !stillActive.isActive()) {
      await this.sessionStore.delete(session.sessionId);
      await this.sessionStore.delete(record.sessionId);
      return Result.failure('CONTEXT_NO_LONGER_AVAILABLE');
    }

    await this.sessionStore.delete(record.sessionId);
    // Audit NON transactionnel avec la rotation elle-meme (deja committee par
    // `completeRotation`) — dette assumee (voir ADR-0006 §9/"Dette assumee") : contrairement aux
    // chemins d'echec ci-dessus (revocation + audit ATOMIQUES, voir `revokeAndAudit`), l'evenement
    // de succes n'est pas le cas critique que cette ADR protege en priorite.
    await this.sessionAuditTrail.record(
      this.auditInput(record, 'SESSION_REFRESH_ROTATED', 'SUCCESS', command.correlationId ?? null, session.sessionId, previousRoleCodes),
    );

    return Result.success({ session, refreshToken: rotated.raw });
  }

  /**
   * Revoque la chaine ET ecrit l'entree d'audit DANS LA MEME TRANSACTION (acces direct au
   * repository, jamais via `refreshTokenIssuer.revokeChain` qui ouvre sa PROPRE transaction —
   * voir le commentaire du constructeur). Critique pour `SESSION_REFRESH_REUSE_DETECTED`
   * (ADR-0006 §8 : "l'evenement de securite le plus critique de cette ADR, sa perte serait
   * inacceptable").
   *
   * Ferme ENSUITE, hors transaction (Redis n'est pas transactionnel avec Postgres — meme
   * discipline que `RevokeMembershipHandler`), TOUS les `sessionId` DISTINCTS de la chaine —
   * jamais seulement `record.sessionId` : le token PRESENTE peut appartenir a une generation
   * PERIMEE dont la session a deja ete fermee lors d'une rotation anterieure, auquel cas c'est la
   * session de la generation SUIVANTE (inconnue de `record`) qui est encore reellement vivante et
   * doit etre coupee (voir `RefreshTokenRepository.revokeChain`).
   */
  private async revokeAndAudit(
    record: RefreshToken,
    reason: RefreshTokenRevocationReason,
    eventType: SessionAuditRecordInput['eventType'],
    outcome: 'FAILURE' | 'DENIED',
    correlationId: string | null,
    actorRoleCodes: readonly string[] = [],
  ): Promise<void> {
    const now = this.clock.now();
    const sessionIds = await this.unitOfWork.withTransaction(async () => {
      const ids = await this.refreshTokenRepository.revokeChain(record.chainId, reason, now);
      await this.sessionAuditTrail.record(this.auditInput(record, eventType, outcome, correlationId, undefined, actorRoleCodes));
      return ids;
    });
    await Promise.all(sessionIds.map((sessionId) => this.sessionStore.delete(sessionId)));
  }

  private auditInput(
    record: RefreshToken,
    eventType: SessionAuditRecordInput['eventType'],
    outcome: 'SUCCESS' | 'FAILURE' | 'DENIED',
    correlationId: string | null,
    resultingSessionId?: string,
    actorRoleCodes: readonly string[] = [],
  ): SessionAuditRecordInput {
    return {
      eventType,
      outcome,
      tenantId: record.tenantId?.toString() ?? null,
      subjectUserId: record.userId.toString(),
      actorUserId: record.userId.toString(),
      actorRoleCodes,
      reason: null,
      sessionId: resultingSessionId ?? record.sessionId,
      correlationId,
    };
  }
}
