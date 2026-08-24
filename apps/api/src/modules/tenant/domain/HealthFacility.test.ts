import { describe, expect, it } from 'vitest';
import { FixedClock, SequentialIdGenerator } from '../../../../test/tenant/builders/testKit.js';
import { HealthFacility } from './HealthFacility.js';
import { FacilityName } from './value-objects/FacilityName.js';

function name(value: string): FacilityName {
  return FacilityName.create(value).getValue();
}

describe('HealthFacility', () => {
  it('create() genere un agregat ACTIF et emet HealthFacilityCreated avec tenantId = aggregateId', () => {
    const clock = new FixedClock('2026-08-24T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const facility = HealthFacility.create({ name: name('Hopital Principal de Dakar'), clock, idGenerator });

    expect(facility.status).toBe('ACTIVE');
    expect(facility.isActive()).toBe(true);
    expect(facility.createdAt).toEqual(new Date('2026-08-24T10:00:00Z'));

    const events = facility.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tenant.health-facility.created');
    expect(events[0]?.aggregateId).toBe(facility.id.toString());
    expect(events[0]?.tenantId).toBe(facility.id.toString());
  });

  it('suspend() passe le statut a SUSPENDED', () => {
    const facility = HealthFacility.create({
      name: name('Clinique Test'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const result = facility.suspend();
    expect(result.isSuccess()).toBe(true);
    expect(facility.status).toBe('SUSPENDED');
    expect(facility.isActive()).toBe(false);
  });

  it('suspend() est refuse si deja suspendu', () => {
    const facility = HealthFacility.create({
      name: name('Clinique Test'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    facility.suspend();

    const result = facility.suspend();
    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('FacilityAlreadySuspendedError');
  });

  it('reactivate() ramene le statut a ACTIVE', () => {
    const facility = HealthFacility.create({
      name: name('Clinique Test'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    facility.suspend();

    const result = facility.reactivate();
    expect(result.isSuccess()).toBe(true);
    expect(facility.status).toBe('ACTIVE');
  });

  it('reactivate() est refuse si deja actif', () => {
    const facility = HealthFacility.create({
      name: name('Clinique Test'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const result = facility.reactivate();
    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('FacilityAlreadyActiveError');
  });

  it('reconstitute() ne genere aucun evenement de domaine', () => {
    const facility = HealthFacility.create({
      name: name('Clinique Test'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    facility.pullDomainEvents();

    const reconstituted = HealthFacility.reconstitute(facility.id, {
      name: facility.name,
      status: facility.status,
      createdAt: facility.createdAt,
    });

    expect(reconstituted.pullDomainEvents()).toHaveLength(0);
  });
});
