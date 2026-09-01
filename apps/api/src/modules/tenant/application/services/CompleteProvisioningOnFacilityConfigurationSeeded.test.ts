import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryFacilitySettingsRepository,
  InMemoryProvisioningAuditTrail,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { CompleteProvisioningHandler } from '../commands/CompleteProvisioning.js';
import { SeedFacilityConfigurationHandler } from '../commands/SeedFacilityConfiguration.js';
import { createCompleteProvisioningOnFacilityConfigurationSeededHandler } from './CompleteProvisioningOnFacilityConfigurationSeeded.js';

const TENANT_A = uuidAt(9401);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(1),
    eventType: 'tenant.facility-configuration-seeded',
    eventVersion: 1,
    aggregateId: uuidAt(2),
    tenantId: TENANT_A,
    occurredAt: new Date('2026-08-28T00:00:00.000Z'),
    payload: { locale: 'fr-SN', timezone: 'Africa/Dakar', currency: 'XOF', phoneCountryCode: '+221' },
    ...overrides,
  };
}

describe('CompleteProvisioningOnFacilityConfigurationSeeded (ADR-0008 §11, amendement 1)', () => {
  function build() {
    const repository = new InMemoryFacilitySettingsRepository();
    const clock = new FixedClock('2026-08-28T00:00:00.000Z');
    const idGenerator = new SequentialIdGenerator();
    const seedFacilityConfigurationHandler = new SeedFacilityConfigurationHandler(
      repository,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
      new InMemoryProvisioningAuditTrail(),
    );
    const completeProvisioningHandler = new CompleteProvisioningHandler(
      repository,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
      new InMemoryProvisioningAuditTrail(),
    );
    const handler = createCompleteProvisioningOnFacilityConfigurationSeededHandler({ completeProvisioningHandler });
    return { handler, repository, seedFacilityConfigurationHandler };
  }

  it('cloture le provisioning du tenant de l_evenement quand FacilitySettings existe deja', async () => {
    const { handler, repository, seedFacilityConfigurationHandler } = build();
    await seedFacilityConfigurationHandler.execute({ tenantId: TENANT_A });

    await handler(envelope());

    const settings = await repository.findByTenantId(TenantId.create(TENANT_A).getValue());
    expect(settings?.isProvisioningCompleted()).toBe(true);
  });

  it("leve une erreur explicite (jamais silencieuse) si FacilitySettings n'existe pas encore — l'etape precedente n'a pas ete rejouee", async () => {
    const { handler } = build();
    await expect(handler(envelope())).rejects.toThrow(/FACILITY_SETTINGS_NOT_FOUND/);
  });

  it("leve si tenantId est absent de l'enveloppe", async () => {
    const { handler, seedFacilityConfigurationHandler } = build();
    await seedFacilityConfigurationHandler.execute({ tenantId: TENANT_A });
    await expect(handler(envelope({ tenantId: null }))).rejects.toThrow();
  });

  it('redelivrance (meme evenement) : idempotent — PROVISIONING_ALREADY_COMPLETED traite comme succes, aucune exception', async () => {
    const { handler, seedFacilityConfigurationHandler } = build();
    await seedFacilityConfigurationHandler.execute({ tenantId: TENANT_A });

    await expect(handler(envelope())).resolves.toBeUndefined();
    await expect(handler(envelope())).resolves.toBeUndefined();
  });
});
