import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryFacilitySettingsRepository,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { CompleteProvisioningHandler } from './CompleteProvisioning.js';
import { SeedFacilityConfigurationHandler } from './SeedFacilityConfiguration.js';

function buildHandlers() {
  const repository = new InMemoryFacilitySettingsRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const clock = new FixedClock('2026-08-28T10:00:00Z');
  const idGenerator = new SequentialIdGenerator();
  const seedFacilityConfiguration = new SeedFacilityConfigurationHandler(repository, unitOfWork, clock, idGenerator);
  const completeProvisioning = new CompleteProvisioningHandler(repository, unitOfWork, clock, idGenerator);
  return { repository, seedFacilityConfiguration, completeProvisioning };
}

describe('CompleteProvisioningHandler (ADR-0008 §11, amendement 1)', () => {
  it('emet ProvisioningCompleted quand une configuration existe deja pour ce tenant', async () => {
    const { repository, seedFacilityConfiguration, completeProvisioning } = buildHandlers();
    const tenantId = uuidAt(1);
    await seedFacilityConfiguration.execute({ tenantId });

    const result = await completeProvisioning.execute({ tenantId });

    expect(result.isSuccess()).toBe(true);
    const settings = await repository.findByTenantId(TenantId.create(tenantId).getValue());
    expect(settings?.isProvisioningCompleted()).toBe(true);
  });

  it("echoue avec FACILITY_SETTINGS_NOT_FOUND si l'etape SeedFacilityConfiguration n'a pas encore ete rejouee (ADR-0008 §5, retry-jusqu-a-completion)", async () => {
    const { completeProvisioning } = buildHandlers();
    const tenantId = uuidAt(2);

    const result = await completeProvisioning.execute({ tenantId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FACILITY_SETTINGS_NOT_FOUND');
  });

  it('rejette un tenantId invalide', async () => {
    const { completeProvisioning } = buildHandlers();
    const result = await completeProvisioning.execute({ tenantId: 'not-a-uuid' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_TENANT_ID');
  });

  it('est idempotent : un second appel renvoie PROVISIONING_ALREADY_COMPLETED, ProvisioningCompleted emis une seule fois', async () => {
    const { seedFacilityConfiguration, completeProvisioning } = buildHandlers();
    const tenantId = uuidAt(3);
    await seedFacilityConfiguration.execute({ tenantId });

    const first = await completeProvisioning.execute({ tenantId });
    expect(first.isSuccess()).toBe(true);
    const second = await completeProvisioning.execute({ tenantId });

    expect(second.isFailure()).toBe(true);
    expect(second.getError()).toBe('PROVISIONING_ALREADY_COMPLETED');
  });
});
