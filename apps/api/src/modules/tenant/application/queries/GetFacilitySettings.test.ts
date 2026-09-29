import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryFacilitySettingsRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { FacilitySettings } from '../../domain/FacilitySettings.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { TenantConfigPrincipal } from '../TenantConfigPrincipal.js';
import { GetFacilitySettingsHandler } from './GetFacilitySettings.js';

const ACTOR_ID = uuidAt(700);

async function seedSettings(repository: InMemoryFacilitySettingsRepository, tenantId: TenantId): Promise<void> {
  const settings = FacilitySettings.create({
    tenantId,
    clock: new FixedClock('2026-08-24T10:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
  await repository.save(settings, tenantId);
}

describe('GetFacilitySettingsHandler', () => {
  it('retourne les parametres regionaux du tenant courant pour une session TENANT autorisee', async () => {
    const repository = new InMemoryFacilitySettingsRepository();
    const tenantId = TenantId.create(uuidAt(1)).getValue();
    await seedSettings(repository, tenantId);
    const unitOfWork = new InMemoryUnitOfWork();
    const handler = new GetFacilitySettingsHandler(repository, unitOfWork);

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
      locale: 'fr-SN',
      timezone: 'Africa/Dakar',
      currency: 'XOF',
      phoneCountryCode: '+221',
      createdAt: new Date('2026-08-24T10:00:00Z'),
    });
    // Lecture tenant-scopee : DOIT passer par une transaction positionnant app.tenant_id (RLS).
    expect(unitOfWork.lastContext?.tenantId?.equals(tenantId)).toBe(true);
  });

  it('refuse (FORBIDDEN) une session TENANT sans tenant-config:administer', async () => {
    const repository = new InMemoryFacilitySettingsRepository();
    const tenantId = TenantId.create(uuidAt(1)).getValue();
    await seedSettings(repository, tenantId);
    const handler = new GetFacilitySettingsHandler(repository, new InMemoryUnitOfWork());

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
    const repository = new InMemoryFacilitySettingsRepository();
    const handler = new GetFacilitySettingsHandler(repository, new InMemoryUnitOfWork());

    const result = await handler.execute({ principal: { kind: 'PLATFORM', actorUserId: ACTOR_ID } });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('retourne FACILITY_SETTINGS_NOT_FOUND (defensif) quand aucun FacilitySettings n_existe pour ce tenant', async () => {
    const repository = new InMemoryFacilitySettingsRepository();
    const handler = new GetFacilitySettingsHandler(repository, new InMemoryUnitOfWork());
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
    expect(result.getError()).toBe('FACILITY_SETTINGS_NOT_FOUND');
  });
});
