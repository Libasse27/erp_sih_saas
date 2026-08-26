import { Result } from '../../../../shared-kernel/domain/Result.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { ContextIntent, SessionContextIssuer } from '../services/SessionContextIssuer.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';

export type { ContextIntent };

export interface ResolveTenantContextCommand {
  /** Identite deja verifiee par AuthenticateUser (2.4) — cette commande ne re-verifie pas le mot de passe. */
  readonly userId: string;
  /**
   * Selection d'intention soumise par le client. Jamais une preuve : le serveur la valide
   * systematiquement contre les memberships reels avant d'ouvrir un contexte (O-05).
   */
  readonly intent: ContextIntent;
  /**
   * Session actuellement ouverte, le cas echeant. Le changement de contexte ferme celle-ci et
   * en ouvre une nouvelle — jamais une mutation en place (O-05 §7.1).
   */
  readonly previousSessionId?: string;
}

export type ResolveTenantContextError =
  | 'INVALID_USER_ID'
  | 'INVALID_TENANT_ID'
  | 'ACCOUNT_NOT_FOUND'
  | 'NOT_SUPER_ADMIN'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'MEMBERSHIP_NOT_FOUND_OR_INACTIVE';

export interface ResolveTenantContextResult {
  readonly session: SessionContext;
}

/**
 * Ouvre un nouveau contexte de session (PLATFORM ou TENANT). Depuis l'etape 7/13 (ADR-0005 §4),
 * la resolution roles/permissions/gate-MFA est DELEGUEE a `SessionContextIssuer` — CE handler ne
 * fait plus que : valider le format des identifiants transmis, invoquer le service, gerer le
 * remplacement de session (fermeture de l'ancienne, ouverture de la nouvelle). Le CONTRAT PUBLIC
 * (commande, erreurs, `{ session }`) reste inchange ; seule la VALEUR possible de `session` change
 * (une session `MFA_PENDING` peut desormais etre retournee en succes, jamais signalee comme une
 * erreur — voir ADR-0005 §4 : le blocage est porte par le TYPE de la session, pas par un code
 * d'erreur).
 */
export class ResolveTenantContextHandler {
  constructor(
    private readonly sessionContextIssuer: SessionContextIssuer,
    private readonly sessionStore: SessionStore,
  ) {}

  async execute(
    command: ResolveTenantContextCommand,
  ): Promise<Result<ResolveTenantContextResult, ResolveTenantContextError>> {
    const userIdResult = UserAccountId.create(command.userId);
    if (userIdResult.isFailure()) {
      return Result.failure('INVALID_USER_ID');
    }
    const userId = userIdResult.getValue();

    if (command.intent.kind === 'TENANT') {
      const tenantIdResult = TenantId.create(command.intent.tenantId);
      if (tenantIdResult.isFailure()) {
        return Result.failure('INVALID_TENANT_ID');
      }
    }

    const sessionResult = await this.sessionContextIssuer.issueForNewContext({
      userId,
      intent: command.intent,
    });
    if (sessionResult.isFailure()) {
      return Result.failure(sessionResult.getError());
    }
    const session = sessionResult.getValue();

    // Changement de contexte = fermeture puis emission (jamais une mutation en place) : le
    // nouvel objet `session` ci-dessus ne partage aucun etat mutable avec l'ancien.
    if (command.previousSessionId !== undefined) {
      await this.sessionStore.delete(command.previousSessionId);
    }
    await this.sessionStore.create(session);

    return Result.success({ session });
  }
}
