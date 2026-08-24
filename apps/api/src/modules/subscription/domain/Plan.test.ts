import { describe, expect, it } from 'vitest';
import { FixedClock, SequentialIdGenerator } from '../../../../test/subscription/builders/testKit.js';
import { Plan } from './Plan.js';
import { PlanLimits } from './value-objects/PlanLimits.js';
import { PlanName } from './value-objects/PlanName.js';

function limits(maxUsers: number, maxBeds: number): PlanLimits {
  return PlanLimits.create(maxUsers, maxBeds).getValue();
}

function name(value: string): PlanName {
  return PlanName.create(value).getValue();
}

describe('Plan', () => {
  it('create() construit un forfait avec le code, le nom et les limites fournis', () => {
    const clock = new FixedClock('2026-08-24T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();

    const plan = Plan.create({
      code: 'STANDARD',
      name: name('Standard'),
      limits: limits(10, 20),
      clock,
      idGenerator,
    });

    expect(plan.code).toBe('STANDARD');
    expect(plan.name.value).toBe('Standard');
    expect(plan.limits.maxUsers).toBe(10);
    expect(plan.limits.maxBeds).toBe(20);
    expect(plan.createdAt).toEqual(new Date('2026-08-24T10:00:00Z'));
  });

  it('reconstitute() reconstruit un forfait sans emettre d_evenement (Plan n_emet jamais d_evenement de domaine)', () => {
    const plan = Plan.create({
      code: 'PROFESSIONNEL',
      name: name('Professionnel'),
      limits: limits(30, 50),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const reconstituted = Plan.reconstitute(plan.id, {
      code: plan.code,
      name: plan.name,
      limits: plan.limits,
      createdAt: plan.createdAt,
    });

    expect(reconstituted.pullDomainEvents()).toHaveLength(0);
    expect(plan.pullDomainEvents()).toHaveLength(0);
  });
});
