import type { Request, Response } from 'express';
import type { AuthenticateUserHandler, AuthenticateUserResult } from '../../application/commands/AuthenticateUser.js';
import type { ResolveTenantContextHandler } from '../../application/commands/ResolveTenantContext.js';
import type { VerifyMfaChallengeHandler } from '../../application/commands/VerifyMfaChallenge.js';
import type { ContextIntent } from '../../application/services/SessionContextIssuer.js';
// Meme constante que le verrou anti-brute-force d'agregat (§7 bis D) — la couche presentation ne
// fait que la CONVERTIR en secondes pour l'en-tete `Retry-After`, elle ne la reparametre jamais.
import { MFA_LOCKOUT_DURATION_MS } from '../../domain/MfaTuning.js';
import { readBearerToken } from './BearerToken.js';
import { CreateSessionBodySchema, VerifyMfaChallengeBodySchema } from './SessionSchemas.js';
import { toAuthenticatedSessionResponse, toCreateSessionResponse } from './SessionResponseDto.js';

export interface SessionControllerLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * `identity` SEUL (ADR-0010 §1) — deux methodes regroupees par RESSOURCE (la session), pas par
 * commande : `create` (`POST /api/v1/auth/sessions`, §6) et `verifyMfaChallenge`
 * (`POST /api/v1/auth/sessions/mfa-challenge`, §7 bis C), qui PARTAGENT le meme presentateur de
 * session complete (`toAuthenticatedSessionResponse`). Ne connait jamais le module `tenant`.
 *
 * Chaque methode valide (zod `.strict()`), delegue (bus de commandes applicatif), presente (DTO
 * explicite) — rien d'autre (regle §3.5/§11.4 du system prompt).
 */
export class SessionController {
  constructor(
    private readonly authenticateUser: AuthenticateUserHandler,
    private readonly resolveTenantContext: ResolveTenantContextHandler,
    // Nomme `...Handler` (et non `verifyMfaChallenge`) : evite la collision avec la METHODE
    // publique `verifyMfaChallenge` ci-dessous (deux declarations distinctes, TS2300/TS2687).
    private readonly verifyMfaChallengeHandler: VerifyMfaChallengeHandler,
    private readonly logger: SessionControllerLogger,
  ) {}

  /**
   * `POST /api/v1/auth/sessions` (ADR-0010 §6). Non authentifiee (elle PRODUIT
   * l'authentification) : aucun `Authorization` n'est lu. Enchaine `AuthenticateUser` PUIS,
   * seulement si l'identite est verifiee, `ResolveTenantContext` — jamais l'inverse, jamais les
   * deux en parallele (l'intention de contexte ne peut etre derivee qu'APRES authentification,
   * §6 "Derivation de l'intention").
   */
  create = async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const { email, password, context } = parsed.data;

    const authResult = await this.authenticateUser.execute({ email, plainPassword: password });
    if (authResult.isFailure()) {
      // `AuthenticateUserError` est une union a UNE seule valeur (`INVALID_CREDENTIALS`, regle
      // 2.4 anti-enumeration) — jamais de distinction email inconnu / mot de passe faux.
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const auth = authResult.getValue();

    const intent = deriveContextIntent(context, auth);
    if (intent === null) {
      // Cas 4 du §6 : "absent ET zero ou plusieurs -> aucune session n'est ouverte". Aucun appel
      // a ResolveTenantContext ICI : rien a resoudre, rien a auditer (deja couvert par
      // AuthenticateUser -> SESSION_LOGIN_SUCCEEDED, ADR-0009 §2.1, inchange).
      res.status(200).json({ status: 'context_selection_required', availableTenantIds: auth.activeTenantIds });
      return;
    }

    const resolveResult = await this.resolveTenantContext.execute({ userId: auth.userAccountId, intent });
    if (resolveResult.isFailure()) {
      const error = resolveResult.getError();
      if (error === 'ACCOUNT_NOT_FOUND' || error === 'INVALID_USER_ID' || error === 'INVALID_TENANT_ID') {
        // Pathologique a ce stade : `userId` provient du serveur (AuthenticateUser vient de le
        // trouver) et `tenantId` a deja ete valide comme UUID par zod (ADR-0010 §6 : "INVALID_
        // USER_ID/INVALID_TENANT_ID sont interceptees par zod en amont (400) et pathologiques
        // ensuite (500)").
        this.logger.error({ event: 'session.resolve-tenant-context.pathological-error', error }, 'ResolveTenantContext : erreur pathologique post-authentification');
        res.status(500).json({ error: 'internal_error' });
        return;
      }
      // NOT_SUPER_ADMIN / TENANT_NOT_FOUND / TENANT_SUSPENDED / MEMBERSHIP_NOT_FOUND_OR_INACTIVE
      // -> un seul et meme 403, jamais distingue (ADR-0010 §6, meme regle que
      // TenantModuleBackedAccessChecker/ADR-0008 §3 : "un tenant partiellement provisionne ne
      // doit pas etre distingue d'un tenant qui n'existe pas").
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const { session, refreshToken } = resolveResult.getValue();

    // Cache-Control: no-store sur TOUTE reponse portant un secret (sessionId/refreshToken/
    // pendingSessionId — ADR-0010 §10 regle 5).
    res.set('Cache-Control', 'no-store');
    res.status(200).json(toCreateSessionResponse(session, refreshToken));
  };

  /**
   * `POST /api/v1/auth/sessions/mfa-challenge` (ADR-0010 §7 bis C). `pendingSessionId` lu
   * EXCLUSIVEMENT dans `Authorization: Bearer` (jamais le corps, correctif F-2). PAS montee
   * derriere `requireAuthenticatedContext` (voir composition-root.ts/server.ts) : ce middleware
   * refuserait structurellement toute session `MFA_PENDING`.
   */
  verifyMfaChallenge = async (req: Request, res: Response): Promise<void> => {
    const pendingSessionId = readBearerToken(req);
    if (pendingSessionId === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const parsed = VerifyMfaChallengeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');

    const result = await this.verifyMfaChallengeHandler.execute({
      pendingSessionId,
      factor: parsed.data.factor,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    if (result.isFailure()) {
      const error = result.getError();
      switch (error) {
        case 'SESSION_NOT_FOUND':
        case 'SESSION_NOT_PENDING_MFA':
          // Reponse IDENTIQUE, octet pour octet — anti-oracle d'etat de jeton (ADR-0010 §7 bis A/C).
          res.status(401).json({ error: 'unauthenticated' });
          return;
        case 'INVALID_CODE':
          res.status(401).json({ error: 'invalid_credentials' });
          return;
        case 'ENROLLMENT_REQUIRED':
          res.status(409).json({ error: 'mfa_enrollment_required' });
          return;
        case 'TOO_MANY_ATTEMPTS':
          // Verrou anti-brute-force DE COMPTE (§7 bis D) — Retry-After = duree NOMINALE du
          // verrou, jamais le reliquat (meme regle que le limiteur de debit transport, ADR-0010
          // §8). Distinct du 429 du limiteur transport (memes corps, meme code HTTP, valeurs de
          // Retry-After potentiellement differentes, assume par l'ADR).
          res.set('Retry-After', String(Math.ceil(MFA_LOCKOUT_DURATION_MS / 1000)));
          res.status(429).json({ error: 'too_many_requests' });
          return;
        case 'CONTEXT_NO_LONGER_AVAILABLE':
          res.status(403).json({ error: 'forbidden' });
          return;
        default: {
          const exhaustiveCheck: never = error;
          throw new Error(`VerifyMfaChallengeError non gere par SessionController : ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    }

    const { session, refreshToken } = result.getValue();
    if (session.kind === 'MFA_PENDING') {
      // `issueAfterChallenge()` ne peut structurellement pas produire ce cas (ADR-0010 §6 dernier
      // paragraphe) — garde defensive : JAMAIS un corps partiel, JAMAIS un `status: mfa_required`
      // fabrique ici.
      this.logger.error({ event: 'session.verify-mfa-challenge.unexpected-mfa-pending' }, 'VerifyMfaChallenge a produit une session MFA_PENDING de maniere inattendue');
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    res.set('Cache-Control', 'no-store');
    res.status(200).json(toAuthenticatedSessionResponse(session, refreshToken));
  };
}

/**
 * ADR-0010 §6, "Derivation de l'intention", deterministe, sans regle metier inventee :
 *   1. `context` fourni -> utilise tel quel comme SELECTION (revalidee serveur) ;
 *   2. absent ET `isSuperAdmin` -> `{ kind: 'PLATFORM' }` ;
 *   3. absent ET exactement UN `activeTenantIds` -> ce tenant ;
 *   4. absent ET zero ou plusieurs -> `null` (aucune session n'est ouverte, voir l'appelant).
 */
function deriveContextIntent(
  context: { readonly kind: 'TENANT'; readonly tenantId: string } | { readonly kind: 'PLATFORM' } | undefined,
  auth: AuthenticateUserResult,
): ContextIntent | null {
  if (context !== undefined) {
    return context;
  }
  if (auth.isSuperAdmin) {
    return { kind: 'PLATFORM' };
  }
  if (auth.activeTenantIds.length === 1) {
    const [tenantId] = auth.activeTenantIds;
    if (tenantId === undefined) {
      return null;
    }
    return { kind: 'TENANT', tenantId };
  }
  return null;
}
