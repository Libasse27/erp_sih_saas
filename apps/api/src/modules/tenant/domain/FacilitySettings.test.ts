import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/tenant/builders/testKit.js';
import { FacilitySettings } from './FacilitySettings.js';

function tenantId(n: number): TenantId {
  return TenantId.create(uuidAt(n)).getValue();
}

describe('FacilitySettings', () => {
  it('create() seme les valeurs par defaut fr-SN/Africa-Dakar/XOF/+221 et emet FacilityConfigurationSeeded (ADR-0008 §10)', () => {
    const clock = new FixedClock('2026-08-28T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const settings = FacilitySettings.create({ tenantId: tenantId(1), clock, idGenerator });

    expect(settings.locale).toBe('fr-SN');
    expect(settings.timezone).toBe('Africa/Dakar');
    expect(settings.currency).toBe('XOF');
    expect(settings.phoneCountryCode).toBe('+221');
    expect(settings.provisioningCompletedAt).toBeNull();
    expect(settings.isProvisioningCompleted()).toBe(false);

    const events = settings.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tenant.facility-configuration-seeded');
    expect(events[0]?.tenantId).toBe(tenantId(1).toString());
  });

  it('completeProvisioning() marque le provisioning termine et emet ProvisioningCompleted UNE SEULE FOIS (ADR-0008 §11)', () => {
    const clock = new FixedClock('2026-08-28T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const settings = FacilitySettings.create({ tenantId: tenantId(2), clock, idGenerator });
    settings.pullDomainEvents();

    const result = settings.completeProvisioning(clock, idGenerator);

    expect(result.isSuccess()).toBe(true);
    expect(settings.isProvisioningCompleted()).toBe(true);
    expect(settings.provisioningCompletedAt).toEqual(new Date('2026-08-28T10:00:00Z'));

    const events = settings.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tenant.provisioning.completed');
  });

  it('completeProvisioning() rejeue est idempotent : PROVISIONING_ALREADY_COMPLETED, aucun second evenement', () => {
    const clock = new FixedClock('2026-08-28T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const settings = FacilitySettings.create({ tenantId: tenantId(3), clock, idGenerator });
    settings.pullDomainEvents();
    settings.completeProvisioning(clock, idGenerator);
    settings.pullDomainEvents();

    const result = settings.completeProvisioning(clock, idGenerator);

    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('ProvisioningAlreadyCompletedError');
    expect(settings.pullDomainEvents()).toHaveLength(0);
  });

  it('reconstitute() ne genere aucun evenement de domaine', () => {
    const clock = new FixedClock('2026-08-28T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const settings = FacilitySettings.create({ tenantId: tenantId(4), clock, idGenerator });
    settings.pullDomainEvents();

    const reconstituted = FacilitySettings.reconstitute(settings.id, {
      tenantId: settings.tenantId,
      locale: settings.locale,
      timezone: settings.timezone,
      currency: settings.currency,
      phoneCountryCode: settings.phoneCountryCode,
      createdAt: settings.createdAt,
      provisioningCompletedAt: settings.provisioningCompletedAt,
    });

    expect(reconstituted.pullDomainEvents()).toHaveLength(0);
  });
});
