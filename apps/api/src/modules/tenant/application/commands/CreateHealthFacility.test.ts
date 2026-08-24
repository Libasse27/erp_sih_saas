import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryHealthFacilityRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
} from '../../../../../test/tenant/builders/testKit.js';
import { CreateHealthFacilityHandler } from './CreateHealthFacility.js';

function buildHandler() {
  const repository = new InMemoryHealthFacilityRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const handler = new CreateHealthFacilityHandler(
    repository,
    unitOfWork,
    new FixedClock('2026-08-24T10:00:00Z'),
    new SequentialIdGenerator(),
  );
  return { repository, unitOfWork, handler };
}

describe('CreateHealthFacilityHandler', () => {
  it('cree un HealthFacility ACTIF et le persiste sous le tenantId genere', async () => {
    const { repository, handler } = buildHandler();

    const result = await handler.execute({ name: 'Hopital Principal de Dakar' });

    expect(result.isSuccess()).toBe(true);
    const { tenantId } = result.getValue();
    const saved = await repository.findByTenantId(TenantId.create(tenantId).getValue());
    expect(saved).not.toBeNull();
    expect(saved?.name.value).toBe('Hopital Principal de Dakar');
    expect(saved?.status).toBe('ACTIVE');
  });

  it("positionne le contexte RLS (UnitOfWorkContext.tenantId) sur l'identifiant genere pour l'agregat — amorçage RLS", async () => {
    const { unitOfWork, handler } = buildHandler();

    const result = await handler.execute({ name: 'Clinique Test' });

    expect(result.isSuccess()).toBe(true);
    expect(unitOfWork.lastContext?.tenantId?.toString()).toBe(result.getValue().tenantId);
  });

  it('rejette un nom vide', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ name: '   ' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_NAME');
  });

  it('genere un tenantId different a chaque appel (deux etablissements distincts)', async () => {
    const { handler } = buildHandler();
    const first = await handler.execute({ name: 'Etablissement 1' });
    const second = await handler.execute({ name: 'Etablissement 2' });

    expect(first.getValue().tenantId).not.toBe(second.getValue().tenantId);
  });
});
