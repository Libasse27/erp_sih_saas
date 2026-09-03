import type { Request, Response } from 'express';
import type { StartMfaEnrollmentHandler } from '../../application/commands/StartMfaEnrollment.js';
import type { ConfirmMfaEnrollmentHandler } from '../../application/commands/ConfirmMfaEnrollment.js';
import { MFA_LOCKOUT_DURATION_MS } from '../../domain/MfaTuning.js';
import { readBearerToken } from './BearerToken.js';
import { ConfirmMfaEnrollmentBodySchema, StartMfaEnrollmentBodySchema } from './MfaEnrollmentSchemas.js';

/**
 * `identity` SEUL (ADR-0010 §1) — cycle de vie du facteur MFA : `start`
 * (`POST /api/v1/auth/mfa/enrollment`, §7 bis A) et `confirm`
 * (`POST /api/v1/auth/mfa/enrollment/confirmation`, §7 bis B). PAS montee derriere
 * `requireAuthenticatedContext` — voir composition-root.ts/server.ts.
 *
 * Chaque methode valide, delegue, presente — rien d'autre. Le `pendingSessionId` est lu
 * EXCLUSIVEMENT dans `Authorization: Bearer` (correctif F-2, ADR-0005) : ce controleur n'accede
 * jamais a `SessionStore`, n'appelle jamais `ServerContextResolver` — le handler applicatif reste
 * le SEUL validateur de la session.
 */
export class MfaEnrollmentController {
  constructor(
    private readonly startMfaEnrollment: StartMfaEnrollmentHandler,
    private readonly confirmMfaEnrollment: ConfirmMfaEnrollmentHandler,
  ) {}

  start = async (req: Request, res: Response): Promise<void> => {
    const pendingSessionId = readBearerToken(req);
    if (pendingSessionId === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const parsed = StartMfaEnrollmentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');

    const result = await this.startMfaEnrollment.execute({
      sessionId: pendingSessionId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SESSION_NOT_FOUND' || error === 'SESSION_NOT_PENDING_ENROLLMENT' || error === 'ACCOUNT_NOT_FOUND') {
        // Reponse IDENTIQUE, octet pour octet, pour les TROIS causes (anti-oracle d'etat de
        // jeton, ADR-0010 §7 bis A — `ACCOUNT_NOT_FOUND` traite comme `401`, jamais `500` : une
        // session referencant un `UserAccount` inexistant est structurellement inexploitable).
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      // ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE
      res.status(409).json({ error: 'mfa_enrollment_already_active' });
      return;
    }

    const { enrollmentId, provisioningUri } = result.getValue();
    // `provisioningUri` porte le secret TOTP en clair (ADR-0010 §7 bis A) : `no-store`
    // obligatoire, jamais journalise (voir §10 — respecte ici : aucun log de ce corps).
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ enrollmentId, provisioningUri });
  };

  confirm = async (req: Request, res: Response): Promise<void> => {
    const pendingSessionId = readBearerToken(req);
    if (pendingSessionId === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const parsed = ConfirmMfaEnrollmentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');

    const result = await this.confirmMfaEnrollment.execute({
      sessionId: pendingSessionId,
      totpCode: parsed.data.totpCode,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SESSION_NOT_FOUND' || error === 'SESSION_NOT_PENDING_ENROLLMENT') {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (error === 'INVALID_CODE') {
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }
      if (error === 'ENROLLMENT_NOT_FOUND' || error === 'NO_PENDING_FACTOR') {
        res.status(409).json({ error: 'mfa_enrollment_required' });
        return;
      }
      // TOO_MANY_ATTEMPTS — verrou anti-brute-force DE COMPTE (§7 bis D), Retry-After = duree
      // NOMINALE du verrou, jamais le reliquat.
      res.set('Retry-After', String(Math.ceil(MFA_LOCKOUT_DURATION_MS / 1000)));
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }

    // `recoveryCodes` expose UNE SEULE FOIS (ADR-0005 §3) — `no-store`, jamais journalise.
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ recoveryCodes: result.getValue().recoveryCodes });
  };
}
