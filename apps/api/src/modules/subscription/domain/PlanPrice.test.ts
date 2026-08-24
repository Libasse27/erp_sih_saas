import { describe, expect, it } from 'vitest';
import { Money } from '../../../shared-kernel/domain/value-objects/Money.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../../../../test/subscription/builders/testKit.js';
import { PlanId } from './value-objects/PlanId.js';
import { PlanPrice } from './PlanPrice.js';

function planId(): PlanId {
  return PlanId.create(uuidAt(1)).getValue();
}

describe('PlanPrice', () => {
  it('create() construit un tarif avec montant, periode et date d_effet fournis', () => {
    const clock = new FixedClock('2026-08-24T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();

    const price = PlanPrice.create({
      planId: planId(),
      amount: Money.fromXOF(35_000).getValue(),
      period: 'MENSUEL',
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      clock,
      idGenerator,
    });

    expect(price.amount.amount).toBe(35_000);
    expect(price.period).toBe('MENSUEL');
    expect(price.effectiveFrom).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(price.createdAt).toEqual(new Date('2026-08-24T10:00:00Z'));
  });

  it("n'expose aucune methode de mutation (append-only par construction)", () => {
    const price = PlanPrice.create({
      planId: planId(),
      amount: Money.fromXOF(35_000).getValue(),
      period: 'MENSUEL',
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });

    const mutableKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(price)).filter(
      (key) => key.startsWith('set') || key.startsWith('change') || key.startsWith('update'),
    );
    expect(mutableKeys).toHaveLength(0);
  });

  it('reconstitute() ne genere aucun evenement de domaine', () => {
    const price = PlanPrice.create({
      planId: planId(),
      amount: Money.fromXOF(35_000).getValue(),
      period: 'MENSUEL',
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      clock: new FixedClock('2026-08-24T10:00:00Z'),
      idGenerator: new SequentialIdGenerator(),
    });
    price.pullDomainEvents();

    const reconstituted = PlanPrice.reconstitute(price.id, {
      planId: price.planId,
      amount: price.amount,
      period: price.period,
      effectiveFrom: price.effectiveFrom,
      createdAt: price.createdAt,
    });

    expect(reconstituted.pullDomainEvents()).toHaveLength(0);
  });
});
