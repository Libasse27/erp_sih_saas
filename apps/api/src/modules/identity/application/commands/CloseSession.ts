import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { SessionStore } from '../ports/SessionStore.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';

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
 */
export class CloseSessionHandler {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
  ) {}

  async execute(command: CloseSessionCommand): Promise<Result<void, never>> {
    await this.refreshTokenIssuer.revokeChainBySessionId(command.sessionId, 'LOGOUT');
    await this.sessionStore.delete(command.sessionId);
    return Result.success(undefined);
  }
}
