import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { ContextIntent, SessionContextIssuer } from '../services/SessionContextIssuer.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';
import type { SessionContext, SessionStore } from '../ports/SessionStore.js';
import type { SessionAuditTrail } from '../ports/SessionAuditTrail.js';

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
  /** Refresh token brut (O-06.5, ADR-0006 §9) — `null` pour une session `MFA_PENDING` (aucune chaine n'est jamais issue avant preuve du second facteur). Retourne UNE SEULE FOIS : jamais persiste en clair (voir domain/RefreshToken.ts). */
  readonly refreshToken: string | null;
}

/**
 * Erreurs qui NE produisent PAS d'entree `SESSION_CONTEXT_DENIED` (ADR-0009 §2.1) : erreurs de
 * FORME (`userId`/`tenantId` syntaxiquement invalides — aucun sujet fiable) et `ACCOUNT_NOT_FOUND`
 * (meme raisonnement que `SESSION_LOGIN_FAILED` sur identifiant inconnu — minimisation, ADR-0005
 * §6). Toutes les AUTRES erreurs ont un `userId` deja verifie EXISTANT (verifie par
 * `AuthenticateUser` en amont dans le meme parcours) : `NOT_SUPER_ADMIN`, `TENANT_NOT_FOUND`,
 * `TENANT_SUSPENDED`, `MEMBERSHIP_NOT_FOUND_OR_INACTIVE` sont de VRAIS refus d'autorisation,
 * audites en `DENIED`.
 */
const UNAUDITABLE_DENIAL_ERRORS: ReadonlySet<ResolveTenantContextError> = new Set([
  'INVALID_USER_ID',
  'INVALID_TENANT_ID',
  'ACCOUNT_NOT_FOUND',
]);

/**
 * Ouvre un nouveau contexte de session (PLATFORM ou TENANT). Depuis l'etape 7/13 (ADR-0005 §4),
 * la resolution roles/permissions/gate-MFA est DELEGUEE a `SessionContextIssuer` — CE handler ne
 * fait plus que : valider le format des identifiants transmis, invoquer le service, gerer le
 * remplacement de session (fermeture de l'ancienne, ouverture de la nouvelle). Le CONTRAT PUBLIC
 * (commande, erreurs, `{ session }`) reste inchange ; seule la VALEUR possible de `session` change
 * (une session `MFA_PENDING` peut desormais etre retournee en succes, jamais signalee comme une
 * erreur — voir ADR-0005 §4 : le blocage est porte par le TYPE de la session, pas par un code
 * d'erreur).
 *
 * ADR-0009 §2.1 — `SESSION_CONTEXT_OPENED` (SUCCESS, porte le tenantId REELLEMENT ouvert) pour une
 * session `PLATFORM`/`TENANT` complete ; `SESSION_CONTEXT_DENIED` (DENIED) pour un refus
 * d'autorisation reel (voir `UNAUDITABLE_DENIAL_ERRORS` ci-dessus). Une session `MFA_PENDING`
 * N'EST NI l'un NI l'autre : structurellement, aucun contexte n'est encore "ouvert" (ADR-0005 §4)
 * — ce cas n'est pas audite ici (le contournement d'un `MFA_PENDING` est deja audite ailleurs,
 * `MFA_BYPASS_ATTEMPTED`, voir `ServerContextResolver`).
 */
export class ResolveTenantContextHandler {
  constructor(
    private readonly sessionContextIssuer: SessionContextIssuer,
    private readonly sessionStore: SessionStore,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly sessionAuditTrail: SessionAuditTrail,
    private readonly unitOfWork: UnitOfWork,
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
      const error = sessionResult.getError();
      if (!UNAUDITABLE_DENIAL_ERRORS.has(error)) {
        await this.unitOfWork.withTransaction(async () => {
          await this.sessionAuditTrail.record({
            eventType: 'SESSION_CONTEXT_DENIED',
            outcome: 'DENIED',
            tenantId: command.intent.kind === 'TENANT' ? command.intent.tenantId : null,
            actorKind: command.intent.kind === 'PLATFORM' ? 'USER_PLATFORM' : 'USER_TENANT',
            actorUserId: userId.toString(),
            actorRoleCodes: [],
            subjectUserId: userId.toString(),
            reason: null,
            sessionId: null,
            correlationId: null,
          });
        });
      }
      return Result.failure(error);
    }
    const session = sessionResult.getValue();

    // Changement de contexte = fermeture puis emission (jamais une mutation en place) : le
    // nouvel objet `session` ci-dessus ne partage aucun etat mutable avec l'ancien. Etape 8/13
    // (ADR-0006 §9) : la chaine de refresh suit EXACTEMENT le meme cycle de vie que la session
    // elle-meme — fermer l'ancienne chaine, en ouvrir une nouvelle, jamais l'inverse. ORDRE
    // DELIBERE (correctif securite, revue independante) : la chaine Postgres AVANT la session
    // Redis — voir CloseSessionHandler pour le raisonnement complet (fail-closed).
    if (command.previousSessionId !== undefined) {
      await this.refreshTokenIssuer.revokeChainBySessionId(command.previousSessionId, 'CONTEXT_SWITCHED');
      await this.sessionStore.delete(command.previousSessionId);
    }
    await this.sessionStore.create(session);
    const issuedChain = await this.refreshTokenIssuer.issueChain(session);

    if (session.kind !== 'MFA_PENDING') {
      await this.unitOfWork.withTransaction(async () => {
        await this.sessionAuditTrail.record({
          eventType: 'SESSION_CONTEXT_OPENED',
          outcome: 'SUCCESS',
          tenantId: session.kind === 'TENANT' ? session.tenantId : null,
          actorKind: session.kind === 'PLATFORM' ? 'USER_PLATFORM' : 'USER_TENANT',
          actorUserId: userId.toString(),
          actorRoleCodes: session.kind === 'TENANT' ? session.roleCodes : [],
          subjectUserId: userId.toString(),
          reason: null,
          sessionId: session.sessionId,
          correlationId: null,
        });
      });
    }

    return Result.success({ session, refreshToken: issuedChain?.raw ?? null });
  }
}
