import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { SessionStore } from '../ports/SessionStore.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';
import type { SessionAuditTrail } from '../ports/SessionAuditTrail.js';

export interface CloseSessionCommand {
  readonly sessionId: string;
}

/**
 * Fermeture explicite de session (deconnexion). Idempotent : fermer une session deja fermee ne
 * produit pas d'erreur (regle d'idempotence des mutations, cf. system prompt §2 regle 7). Etape
 * 8/13 (ADR-0006 §9) : revoque aussi la chaine de refresh associee — laisser les deux mecanismes
 * diverger permettrait de rouvrir une session pourtant explicitement fermee via un refresh token
 * encore valide.
 *
 * ORDRE DELIBERE (correctif securite, revue independante) : la chaine Postgres est revoquee
 * AVANT la suppression Redis, jamais l'inverse — Redis n'etant pas transactionnel avec Postgres,
 * un echec de la revocation APRES suppression de la session laisserait la chaine survivre a une
 * deconnexion explicite (fail-open). Dans cet ordre, un echec de revocation empeche la
 * deconnexion de "reussir a moitie" silencieusement : voir aussi `RevokeMembershipHandler`/
 * `ForceMfaReEnrollmentHandler`, memes discipline et raisonnement.
 *
 * ADR-0009 §2.1 — `SESSION_CLOSED`/`SUCCESS` : la session est LUE (`sessionStore.get`) AVANT toute
 * revocation/suppression, uniquement pour porter l'acteur/le tenant dans l'entree d'audit — jamais
 * pour changer le comportement d'idempotence ci-dessus. Une session DEJA fermee (`get` renvoie
 * `null`) n'ecrit AUCUNE entree : aucun NOUVEAU fait a rapporter (idempotence, pas un evenement
 * "re-ferme").
 */
export class CloseSessionHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly sessionAuditTrail: SessionAuditTrail,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(command: CloseSessionCommand): Promise<Result<void, never>> {
    const session = await this.sessionStore.get(command.sessionId);

    await this.refreshTokenIssuer.revokeChainBySessionId(command.sessionId, 'LOGOUT');
    await this.sessionStore.delete(command.sessionId);

    if (session !== null && session.kind !== 'MFA_PENDING') {
      await this.unitOfWork.withTransaction(async () => {
        await this.sessionAuditTrail.record({
          eventType: 'SESSION_CLOSED',
          outcome: 'SUCCESS',
          tenantId: session.kind === 'TENANT' ? session.tenantId : null,
          actorKind: session.kind === 'PLATFORM' ? 'USER_PLATFORM' : 'USER_TENANT',
          actorUserId: session.userId,
          actorRoleCodes: session.kind === 'TENANT' ? session.roleCodes : [],
          subjectUserId: session.userId,
          reason: null,
          sessionId: session.sessionId,
          correlationId: null,
        });
      });
    }

    return Result.success(undefined);
  }
}
