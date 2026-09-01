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
import { SeedFacilityConfigurationHandler } from '../commands/SeedFacilityConfiguration.js';
import { createSeedFacilityConfigurationOnMembershipGrantedHandler } from './SeedFacilityConfigurationOnMembershipGranted.js';

const TENANT_A = uuidAt(9301);

function envelope(overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
  return {
    id: uuidAt(1),
    eventType: 'identity.membership.granted',
    eventVersion: 1,
    aggregateId: uuidAt(2),
    tenantId: TENANT_A,
    occurredAt: new Date('2026-08-28T00:00:00.000Z'),
    payload: { userId: uuidAt(3) },
    ...overrides,
  };
}

describe('SeedFacilityConfigurationOnMembershipGranted (ADR-0008 §10, amendement 1)', () => {
  function build() {
    const repository = new InMemoryFacilitySettingsRepository();
    const seedFacilityConfigurationHandler = new SeedFacilityConfigurationHandler(
      repository,
      new InMemoryUnitOfWork(),
      new FixedClock('2026-08-28T00:00:00.000Z'),
      new SequentialIdGenerator(),
      new InMemoryProvisioningAuditTrail(),
    );
    const handler = createSeedFacilityConfigurationOnMembershipGrantedHandler({ seedFacilityConfigurationHandler });
    return { handler, repository };
  }

  it('seme la configuration technique du tenant de l_evenement', async () => {
    const { handler, repository } = build();

    await handler(envelope());

    const settings = await repository.findByTenantId(TenantId.create(TENANT_A).getValue());
    expect(settings).not.toBeNull();
    expect(settings?.locale).toBe('fr-SN');
  });

  it("leve si tenantId est absent de l'enveloppe", async () => {
    const { handler } = build();
    await expect(handler(envelope({ tenantId: null }))).rejects.toThrow();
  });

  it('redelivrance (meme evenement, ou membership supplementaire sur le meme tenant) : idempotent, aucun doublon', async () => {
    const { handler, repository } = build();

    await handler(envelope());
    await handler(envelope({ id: uuidAt(4), payload: { userId: uuidAt(5) } }));

    const settings = await repository.findByTenantId(TenantId.create(TENANT_A).getValue());
    expect(settings).not.toBeNull();
  });

  it("n'extrait aucun champ du payload (userId) — seul envelope.tenantId est utilise", async () => {
    const { handler, repository } = build();

    await handler(envelope({ payload: { anything: 'unexpected-shape' } }));

    const settings = await repository.findByTenantId(TenantId.create(TENANT_A).getValue());
    expect(settings).not.toBeNull();
  });
});
