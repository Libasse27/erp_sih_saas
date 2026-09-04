import type { Request, Response } from 'express';
import type { RequestSuperAdminBreakGlassHandler } from '../../application/commands/RequestSuperAdminBreakGlass.js';
import type { ApproveSuperAdminBreakGlassHandler } from '../../application/commands/ApproveSuperAdminBreakGlass.js';
import {
  ApproveSuperAdminBreakGlassBodySchema,
  RequestSuperAdminBreakGlassBodySchema,
  SuperAdminBreakGlassRequestIdParamSchema,
} from './SuperAdminBreakGlassSchemas.js';

/**
 * Ce que `requireAuthenticatedContext` (composition-root.ts) attache a `res.locals` AVANT ce
 * controleur — jamais un second chemin de resolution de session (meme discipline que
 * `AuditHttpLocals`, module `audit`, non reutilise ICI pour ne jamais faire dependre `identity`
 * de la presentation d'un autre module).
 */
export interface SuperAdminBreakGlassHttpLocals {
  readonly sessionId: string;
}

function isSuperAdminBreakGlassHttpLocals(locals: Record<string, unknown>): locals is Record<string, unknown> & SuperAdminBreakGlassHttpLocals {
  return typeof locals.sessionId === 'string';
}

/**
 * Recuperation break-glass `SUPER_ADMIN` (ADR-0005 Amendement 1, O-04 residu 4) : DEUX endpoints,
 * tous deux montes derriere `requireAuthenticatedContext` (aucune route publique, voir server.ts)
 * — l'autorisation FINE (session `PLATFORM` + step-up MFA, quorum de deux `SUPER_ADMIN` distincts)
 * reste ENTIEREMENT deleguee aux handlers applicatifs (`RequestSuperAdminBreakGlassHandler`/
 * `ApproveSuperAdminBreakGlassHandler`) : ce controleur ne fait que valider la FORME de la
 * requete, deleguer, presenter — jamais de logique d'autorisation ici (meme discipline que
 * `AuditEntryController`/`MfaEnrollmentController`).
 *
 * Codes d'erreur DELIBEREMENT peu discriminants entre `SUBJECT_NOT_FOUND`/`REQUEST_NOT_FOUND` et
 * les refus metier (`409`) : un acteur a deja franchi `requireAuthenticatedContext` (authentifie)
 * ET la verification PLATFORM+step-up du handler pour atteindre ces branches — aucune de ces
 * reponses ne fuit d'information exploitable par un acteur NON authentifie ou NON habilite (ceux-
 * la recoivent `401`/`403` avant meme d'atteindre la logique metier).
 */
export class SuperAdminBreakGlassController {
  constructor(
    private readonly requestBreakGlass: RequestSuperAdminBreakGlassHandler,
    private readonly approveBreakGlass: ApproveSuperAdminBreakGlassHandler,
  ) {}

  request = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isSuperAdminBreakGlassHttpLocals(locals)) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const parsed = RequestSuperAdminBreakGlassBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');

    const result = await this.requestBreakGlass.execute({
      subjectUserAccountId: parsed.data.subjectUserAccountId,
      actorSessionId: locals.sessionId,
      reason: parsed.data.reason,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SESSION_NOT_FOUND') {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (error === 'FORBIDDEN') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (error === 'REASON_REQUIRED') {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      if (error === 'SUBJECT_NOT_FOUND') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // SUBJECT_NOT_SUPER_ADMIN | CANNOT_TARGET_SELF : refus metier, jamais un etat serveur.
      res.status(409).json({ error: 'conflict' });
      return;
    }

    res.status(201).json({ requestId: result.getValue().requestId });
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isSuperAdminBreakGlassHttpLocals(locals)) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const paramsParsed = SuperAdminBreakGlassRequestIdParamSchema.safeParse(req.params);
    const bodyParsed = ApproveSuperAdminBreakGlassBodySchema.safeParse(req.body ?? {});
    if (!paramsParsed.success || !bodyParsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');

    const result = await this.approveBreakGlass.execute({
      requestId: paramsParsed.data.requestId,
      actorSessionId: locals.sessionId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SESSION_NOT_FOUND') {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (error === 'FORBIDDEN') {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (error === 'REQUEST_NOT_FOUND' || error === 'ENROLLMENT_NOT_FOUND') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // REQUEST_NOT_PENDING | CANNOT_APPROVE_OWN_SUBJECT | CANNOT_APPROVE_OWN_REQUEST.
      res.status(409).json({ error: 'conflict' });
      return;
    }

    res.status(200).json({ status: 'approved' });
  };
}
