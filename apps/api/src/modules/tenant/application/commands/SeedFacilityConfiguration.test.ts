import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryFacilitySettingsRepository,
  InMemoryProvisioningAuditTrail,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { SeedFacilityConfigurationHandler } from './SeedFacilityConfiguration.js';

function buildHandler() {
  const repository = new InMemoryFacilitySettingsRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const provisioningAuditTrail = new InMemoryProvisioningAuditTrail();
  const handler = new SeedFacilityConfigurationHandler(
    repository,
    unitOfWork,
    new FixedClock('2026-08-28T10:00:00Z'),
    new SequentialIdGenerator(),
    provisioningAuditTrail,
  );
  return { repository, provisioningAuditTrail, handler };
}

describe('SeedFacilityConfigurationHandler (ADR-0008 §10, amendement 1)', () => {
  it('seme la configuration fr-SN/Africa-Dakar/XOF/+221 pour un tenant sans configuration existante', async () => {
    const { repository, handler } = buildHandler();
    const tenantId = uuidAt(1);

    const result = await handler.execute({ tenantId });

    expect(result.isSuccess()).toBe(true);
    const settings = await repository.findByTenantId(TenantId.create(tenantId).getValue());
    expect(settings?.locale).toBe('fr-SN');
    expect(settings?.timezone).toBe('Africa/Dakar');
    expect(settings?.currency).toBe('XOF');
    expect(settings?.phoneCountryCode).toBe('+221');
  });

  it('rejette un tenantId invalide', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ tenantId: 'not-a-uuid' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_TENANT_ID');
  });

  it('est idempotent : un second appel pour le meme tenant renvoie FACILITY_SETTINGS_ALREADY_EXISTS, aucun doublon', async () => {
    const { repository, handler } = buildHandler();
    const tenantId = uuidAt(2);

    const first = await handler.execute({ tenantId });
    expect(first.isSuccess()).toBe(true);
    const second = await handler.execute({ tenantId });

    expect(second.isFailure()).toBe(true);
    expect(second.getError()).toBe('FACILITY_SETTINGS_ALREADY_EXISTS');

    const settings = await repository.findByTenantId(TenantId.create(tenantId).getValue());
    expect(settings?.id.toString()).toBe(first.getValue().facilitySettingsId);
  });

  it('ecrit une entree PROVISIONING_CONFIGURATION_SEEDED (ADR-0009 §2.2)', async () => {
    const { handler, provisioningAuditTrail } = buildHandler();
    const tenantId = uuidAt(3);

    const result = await handler.execute({ tenantId });

    expect(result.isSuccess()).toBe(true);
    expect(provisioningAuditTrail.records).toHaveLength(1);
    expect(provisioningAuditTrail.records[0]).toMatchObject({
      eventType: 'PROVISIONING_CONFIGURATION_SEEDED',
      outcome: 'SUCCESS',
      tenantId,
      actorKind: 'SYSTEM',
      targetType: 'FACILITY_SETTINGS',
      targetId: result.getValue().facilitySettingsId,
    });
  });
});
