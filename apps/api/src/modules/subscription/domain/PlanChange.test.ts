import { describe, expect, it } from 'vitest';
import { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/subscription/builders/testKit.js';
import { PlanChange } from './PlanChange.js';
import { PlanId } from './value-objects/PlanId.js';
import { PlanPriceId } from './value-objects/PlanPriceId.js';
import { SubscriptionId } from './value-objects/SubscriptionId.js';

describe('PlanChange', () => {
  it('create() construit une ligne d_historique UPGRADE avec le montant proratise fourni', () => {
    const clock = new FixedClock('2026-08-24T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();

    const change = PlanChange.create({
      subscriptionId: SubscriptionId.create(uuidAt(1)).getValue(),
      tenantId: TenantId.create(uuidAt(2)).getValue(),
      changeType: 'UPGRADE',
      fromPlanId: PlanId.create(uuidAt(10)).getValue(),
      fromPlanPriceId: PlanPriceId.create(uuidAt(11)).getValue(),
      toPlanId: PlanId.create(uuidAt(20)).getValue(),
      toPlanPriceId: PlanPriceId.create(uuidAt(21)).getValue(),
      proratedAmount: Money.fromXOF(10_000).getValue(),
      clock,
      idGenerator,
    });

    expect(change.changeType).toBe('UPGRADE');
    expect(change.proratedAmount.amount).toBe(10_000);
    expect(change.occurredAt).toEqual(new Date('2026-08-24T10:00:00Z'));
  });

  it("n'expose aucune methode de mutation (append-only par construction)", () => {
    const change = PlanChange.create({
      subscriptionId: SubscriptionId.create(uuidAt(1)).getValue(),
      tenantId: TenantId.create(uuidAt(2)).getValue(),
      changeType: 'UPGRADE',
      fromPlanId: PlanId.create(uuidAt(10)).getValue(),
      fromPlanPriceId: PlanPriceId.create(uuidAt(11)).getValue(),
      toPlanId: PlanId.create(uuidAt(20)).getValue(),
      toPlanPriceId: PlanPriceId.create(uuidAt(21)).getValue(),
      proratedAmount: Money.fromXOF(10_000).getValue(),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    // Ne cible que les METHODES (descriptor.value est une fonction), pas les accesseurs en
    // lecture (`get changeType()` est un accesseur, pas un mutateur, malgre son prefixe).
    const prototype = Object.getPrototypeOf(change) as object;
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    const mutatorMethodNames = Object.entries(descriptors)
      .filter(([key, descriptor]) => key !== 'constructor' && typeof descriptor.value === 'function')
      .map(([key]) => key)
      .filter((key) => key.startsWith('set') || key.startsWith('change') || key.startsWith('update'));
    expect(mutatorMethodNames).toHaveLength(0);
  });
});
