import type { Request, Response } from 'express';
import type { RequestTenantAdminRecoveryHandler } from '../../application/commands/RequestTenantAdminRecovery.js';
import type { ApproveTenantAdminRecoveryHandler } from '../../application/commands/ApproveTenantAdminRecovery.js';
import {
  ApproveTenantAdminRecoveryBodySchema,
  RequestTenantAdminRecoveryBodySchema,
  TenantAdminRecoveryRequestIdParamSchema,
} from './TenantAdminRecoverySchemas.js';

interface TenantAdminRecoveryHttpLocals {
  readonly sessionId: string;
}

function hasSession(locals: Record<string, unknown>): locals is Record<string, unknown> & TenantAdminRecoveryHttpLocals {
  return typeof locals.sessionId === 'string';
}

export class TenantAdminRecoveryController {
  constructor(
    private readonly requestRecovery: RequestTenantAdminRecoveryHandler,
    private readonly approveRecovery: ApproveTenantAdminRecoveryHandler,
  ) {}

  request = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!hasSession(locals)) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const parsed = RequestTenantAdminRecoveryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');
    const result = await this.requestRecovery.execute({
      ...parsed.data,
      actorSessionId: locals.sessionId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SESSION_NOT_FOUND') { res.status(401).json({ error: 'unauthenticated' }); return; }
      if (error === 'FORBIDDEN') { res.status(403).json({ error: 'forbidden' }); return; }
      if (error === 'TENANT_NOT_FOUND' || error === 'BENEFICIARY_NOT_FOUND') { res.status(404).json({ error: 'not_found' }); return; }
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    res.status(201).json({ requestId: result.getValue().requestId, status: 'PENDING' });
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!hasSession(locals)) {
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const params = TenantAdminRecoveryRequestIdParamSchema.safeParse(req.params);
    const body = ApproveTenantAdminRecoveryBodySchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const correlationId = req.header('x-correlation-id');
    const result = await this.approveRecovery.execute({
      requestId: params.data.requestId,
      actorSessionId: locals.sessionId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
    if (result.isFailure()) {
      const error = result.getError();
      if (error === 'SESSION_NOT_FOUND') { res.status(401).json({ error: 'unauthenticated' }); return; }
      if (error === 'FORBIDDEN') { res.status(403).json({ error: 'forbidden' }); return; }
      if (error === 'REQUEST_NOT_FOUND' || error === 'TENANT_NOT_FOUND' || error === 'BENEFICIARY_NOT_FOUND') {
        res.status(404).json({ error: 'not_found' }); return;
      }
      if (error === 'ADMIN_ROLE_NOT_FOUND') { res.status(500).json({ error: 'internal_error' }); return; }
      res.status(409).json({ error: 'conflict' });
      return;
    }
    res.status(200).json({ status: 'approved', membershipId: result.getValue().membershipId });
  };
}
