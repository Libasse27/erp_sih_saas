import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryHealthFacilityRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { HealthFacility } from '../../domain/HealthFacility.js';
import { FacilityName } from '../../domain/value-objects/FacilityName.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { TenantConfigPrincipal } from '../TenantConfigPrincipal.js';
import { GetHealthFacilityHandler } from './GetHealthFacility.js';

const OWNER_USER_ID = uuidAt(500);
const ACTOR_ID = uuidAt(600);

async function seedFacility(repository: InMemoryHealthFacilityRepository, name: string): Promise<TenantId> {
  const facility = HealthFacility.create({
    name: FacilityName.create(name).getValue(),
    ownerUserId: OWNER_USER_ID,
    clock: new FixedClock('2026-08-24T10:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
  await repository.save(facility, facility.id);
  return facility.id;
}

describe('GetHealthFacilityHandler', () => {
  it('retourne l_identite du HealthFacility du tenant courant pour une session TENANT autorisee', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const unitOfWork = new InMemoryUnitOfWork();
    const handler = new GetHealthFacilityHandler(repository, unitOfWork);

    const principal: TenantConfigPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: tenantId.toString(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['tenant-config:administer'],
    };

    const result = await handler.execute({ principal });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue()).toEqual({
      tenantId: tenantId.toString(),
      name: 'Hopital Principal de Dakar',
      status: 'ACTIVE',
      createdAt: new Date('2026-08-24T10:00:00Z'),
    });
    // Lecture tenant-scopee : DOIT passer par une transaction positionnant app.tenant_id (RLS).
    expect(unitOfWork.lastContext?.tenantId?.equals(tenantId)).toBe(true);
  });

  it('refuse (FORBIDDEN) une session TENANT sans tenant-config:administer', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const handler = new GetHealthFacilityHandler(repository, new InMemoryUnitOfWork());

    const principal: TenantConfigPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: tenantId.toString(),
      roleCodes: ['CAISSIER'],
      permissionCodes: [],
    };

    const result = await handler.execute({ principal });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('refuse EXPLICITEMENT (FORBIDDEN) une session PLATFORM', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const handler = new GetHealthFacilityHandler(repository, new InMemoryUnitOfWork());

    const result = await handler.execute({ principal: { kind: 'PLATFORM', actorUserId: ACTOR_ID } });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('retourne FACILITY_NOT_FOUND (defensif) quand aucun HealthFacility n_existe pour ce tenant', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const handler = new GetHealthFacilityHandler(repository, new InMemoryUnitOfWork());
    const orphanTenantId = TenantId.create(uuidAt(999)).getValue();

    const principal: TenantConfigPrincipal = {
      kind: 'TENANT',
      actorUserId: ACTOR_ID,
      tenantId: orphanTenantId.toString(),
      roleCodes: ['ADMIN_ETABLISSEMENT'],
      permissionCodes: ['tenant-config:administer'],
    };

    const result = await handler.execute({ principal });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FACILITY_NOT_FOUND');
  });
});
