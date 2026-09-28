import { describe, expect, it } from 'vitest';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/tenant/builders/testKit.js';
import { HealthFacility } from './HealthFacility.js';
import { FacilityName } from './value-objects/FacilityName.js';

const OWNER_USER_ID = uuidAt(500);

function name(value: string): FacilityName {
  return FacilityName.create(value).getValue();
}

function aFacility(): HealthFacility {
  return HealthFacility.create({
    name: name('Hopital Principal de Dakar'),
    ownerUserId: OWNER_USER_ID,
    clock: new FixedClock('2026-08-24T10:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
}

describe('HealthFacility.rename()', () => {
  it('renomme effectivement et emet HealthFacilityRenamed exactement une fois', () => {
    const facility = aFacility();
    facility.pullDomainEvents(); // vide l_evenement de creation, hors perimetre de ce test

    const clock = new FixedClock('2026-09-28T09:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const result = facility.rename(name('Clinique Renommee'), clock, idGenerator);

    expect(result.isSuccess()).toBe(true);
    expect(facility.name.value).toBe('Clinique Renommee');

    const events = facility.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tenant.health-facility.renamed');
    expect(events[0]?.aggregateId).toBe(facility.id.toString());
    expect(events[0]?.tenantId).toBe(facility.id.toString());
    expect((events[0] as unknown as { previousName: string }).previousName).toBe('Hopital Principal de Dakar');
    expect((events[0] as unknown as { newName: string }).newName).toBe('Clinique Renommee');
  });

  it('refuse (Result.failure nomme, FacilityNameUnchangedError) un renommage vers un nom strictement identique — aucun evenement emis', () => {
    const facility = aFacility();
    facility.pullDomainEvents();

    const result = facility.rename(name('Hopital Principal de Dakar'), new FixedClock('2026-09-28T09:00:00Z'), new SequentialIdGenerator());

    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('FacilityNameUnchangedError');
    expect(facility.name.value).toBe('Hopital Principal de Dakar');
    expect(facility.pullDomainEvents()).toHaveLength(0);
  });

  it('un nom different uniquement par des espaces superflus est traite comme IDENTIQUE (FacilityName normalise par trim() — meme regle deja decidee par le VO, non redupliquee ici)', () => {
    const facility = aFacility();
    facility.pullDomainEvents();

    const result = facility.rename(name('  Hopital Principal de Dakar  '), new FixedClock('2026-09-28T09:00:00Z'), new SequentialIdGenerator());

    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('FacilityNameUnchangedError');
    expect(facility.pullDomainEvents()).toHaveLength(0);
  });

  it('deux renommages successifs vers des noms differents emettent chacun leur propre HealthFacilityRenamed (jamais accumule au-dela d_un par appel)', () => {
    const facility = aFacility();
    facility.pullDomainEvents();

    facility.rename(name('Premier Nouveau Nom'), new FixedClock('2026-09-28T09:00:00Z'), new SequentialIdGenerator());
    const firstBatch = facility.pullDomainEvents();
    expect(firstBatch).toHaveLength(1);

    facility.rename(name('Second Nouveau Nom'), new FixedClock('2026-09-28T09:05:00Z'), new SequentialIdGenerator());
    const secondBatch = facility.pullDomainEvents();
    expect(secondBatch).toHaveLength(1);
    expect((secondBatch[0] as unknown as { previousName: string }).previousName).toBe('Premier Nouveau Nom');
    expect((secondBatch[0] as unknown as { newName: string }).newName).toBe('Second Nouveau Nom');
  });
});
