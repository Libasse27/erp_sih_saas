import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { RequestTenantAdminRecoveryHandler } from '../../application/commands/RequestTenantAdminRecovery.js';
import type { ApproveTenantAdminRecoveryHandler } from '../../application/commands/ApproveTenantAdminRecovery.js';
import { TenantAdminRecoveryController } from './TenantAdminRecoveryController.js';

function responseHarness(): { response: Response; status: () => number; body: () => unknown } {
  let statusCode = 0;
  let responseBody: unknown;
  const response = {
    locals: { sessionId: 'test-session' },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      responseBody = body;
      return response;
    },
  } as unknown as Response;
  return { response, status: () => statusCode, body: () => responseBody };
}

describe('TenantAdminRecoveryController — statuts HTTP de refus', () => {
  it('traduit une session expirée en 401 sur la demande', async () => {
    const requestHandler = {
      execute: async () => Result.failure('SESSION_NOT_FOUND'),
    } as unknown as RequestTenantAdminRecoveryHandler;
    const controller = new TenantAdminRecoveryController(requestHandler, {} as ApproveTenantAdminRecoveryHandler);
    const res = responseHarness();

    await controller.request(
      {
        body: { tenantId: 'a5e18f5b-7ebd-4a33-90dc-ae7bb1c4b872', beneficiaryUserId: '9f240282-d957-4562-8104-4b2eb34d7838', reason: 'Récupération' },
        header: () => undefined,
      } as unknown as Request,
      res.response,
    );

    expect(res.status()).toBe(401);
    expect(res.body()).toEqual({ error: 'unauthenticated' });
  });

  it('traduit le refus d’une session non PLATFORM ou sans MFA en 403 sur l’approbation', async () => {
    const approvalHandler = {
      execute: async () => Result.failure('FORBIDDEN'),
    } as unknown as ApproveTenantAdminRecoveryHandler;
    const controller = new TenantAdminRecoveryController({} as RequestTenantAdminRecoveryHandler, approvalHandler);
    const res = responseHarness();

    await controller.approve(
      { params: { requestId: 'a5e18f5b-7ebd-4a33-90dc-ae7bb1c4b872' }, body: {}, header: () => undefined } as unknown as Request,
      res.response,
    );

    expect(res.status()).toBe(403);
    expect(res.body()).toEqual({ error: 'forbidden' });
  });
});
