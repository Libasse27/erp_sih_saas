import { describe, expect, it } from 'vitest';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { calculateUpgradeProration } from './ProrationCalculator.js';

function xof(amount: number): Money {
  return Money.fromXOF(amount).getValue();
}

describe('calculateUpgradeProration (O-02.6)', () => {
  it('cas nominal : STANDARD -> PROFESSIONNEL a mi-periode mensuelle', () => {
    // Periode du 2026-08-01 au 2026-08-31 (30 jours), upgrade le 2026-08-16 : 15 jours restants.
    const result = calculateUpgradeProration({
      oldPrice: xof(35_000),
      newPrice: xof(55_000),
      periodStartsAt: new Date('2026-08-01T00:00:00Z'),
      periodEndsAt: new Date('2026-08-31T00:00:00Z'),
      now: new Date('2026-08-16T00:00:00Z'),
    });

    expect(result.isSuccess()).toBe(true);
    // (55000 - 35000) * 15 / 30 = 10000
    expect(result.getValue().amount).toBe(10_000);
  });

  it('arrondi pile a .5 : arrondit AU SUPERIEUR', () => {
    // diff = 101, joursRestants = 15, periode = 30 -> brut = 1515/30 = 50.5
    const result = calculateUpgradeProration({
      oldPrice: xof(0),
      newPrice: xof(101),
      periodStartsAt: new Date('2026-08-01T00:00:00Z'),
      periodEndsAt: new Date('2026-08-31T00:00:00Z'),
      now: new Date('2026-08-16T00:00:00Z'),
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().amount).toBe(51);
  });

  it('applique le plancher de 1 FCFA quand le montant brut est positif mais < 1', () => {
    // diff = 1, joursRestants = 1, periode = 1000 -> brut = 0.001
    const result = calculateUpgradeProration({
      oldPrice: xof(0),
      newPrice: xof(1),
      periodStartsAt: new Date('2026-01-01T00:00:00Z'),
      periodEndsAt: new Date('2028-09-27T00:00:00Z'), // ~1000 jours
      now: new Date('2028-09-26T00:00:00Z'), // 1 jour restant
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().amount).toBe(1);
  });

  it("refuse un 'upgrade' vers un prix strictement inferieur (ce n'est pas un upgrade)", () => {
    const result = calculateUpgradeProration({
      oldPrice: xof(55_000),
      newPrice: xof(35_000),
      periodStartsAt: new Date('2026-08-01T00:00:00Z'),
      periodEndsAt: new Date('2026-08-31T00:00:00Z'),
      now: new Date('2026-08-16T00:00:00Z'),
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('NOT_AN_UPGRADE');
  });

  it("refuse un 'upgrade' vers un prix strictement egal (ce n'est pas un upgrade)", () => {
    const result = calculateUpgradeProration({
      oldPrice: xof(55_000),
      newPrice: xof(55_000),
      periodStartsAt: new Date('2026-08-01T00:00:00Z'),
      periodEndsAt: new Date('2026-08-31T00:00:00Z'),
      now: new Date('2026-08-16T00:00:00Z'),
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('NOT_AN_UPGRADE');
  });

  it('plusieurs upgrades dans la meme periode : le second se calcule depuis le forfait ACTUELLEMENT actif (PROFESSIONNEL), pas depuis le prix initial (STANDARD)', () => {
    const periodStartsAt = new Date('2026-08-01T00:00:00Z');
    const periodEndsAt = new Date('2026-08-31T00:00:00Z');
    const now = new Date('2026-08-16T00:00:00Z'); // 15 jours restants sur 30

    // Premier upgrade : STANDARD -> PROFESSIONNEL
    const first = calculateUpgradeProration({
      oldPrice: xof(35_000),
      newPrice: xof(55_000),
      periodStartsAt,
      periodEndsAt,
      now,
    });
    expect(first.isSuccess()).toBe(true);
    expect(first.getValue().amount).toBe(10_000); // (55000-35000)*15/30

    // Second upgrade, MEME jour : PROFESSIONNEL -> COMPLET. Doit facturer COMPLET-PROFESSIONNEL,
    // jamais COMPLET-STANDARD.
    const second = calculateUpgradeProration({
      oldPrice: xof(55_000), // forfait ACTUELLEMENT actif apres le premier upgrade
      newPrice: xof(75_000),
      periodStartsAt,
      periodEndsAt,
      now,
    });
    expect(second.isSuccess()).toBe(true);
    expect(second.getValue().amount).toBe(10_000); // (75000-55000)*15/30, PAS (75000-35000)*15/30 = 20000

    // Preuve explicite de la non-regression : si on avait (a tort) recalcule depuis STANDARD,
    // le montant du second upgrade aurait ete le double.
    const wrongFromInitialPlan = calculateUpgradeProration({
      oldPrice: xof(35_000),
      newPrice: xof(75_000),
      periodStartsAt,
      periodEndsAt,
      now,
    });
    expect(wrongFromInitialPlan.getValue().amount).not.toBe(second.getValue().amount);
  });

  it('jours restants nuls (upgrade le dernier jour de la periode) : montant nul', () => {
    const result = calculateUpgradeProration({
      oldPrice: xof(35_000),
      newPrice: xof(55_000),
      periodStartsAt: new Date('2026-08-01T00:00:00Z'),
      periodEndsAt: new Date('2026-08-31T00:00:00Z'),
      now: new Date('2026-08-31T00:00:00Z'),
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().amount).toBe(0);
  });

  it('periodicite annuelle : calcul au jour calendaire pres, pas un mois de 30 jours suppose', () => {
    // Periode annuelle du 2026-01-01 au 2027-01-01 (365 jours), upgrade au bout de 100 jours.
    const result = calculateUpgradeProration({
      oldPrice: xof(350_000),
      newPrice: xof(550_000),
      periodStartsAt: new Date('2026-01-01T00:00:00Z'),
      periodEndsAt: new Date('2027-01-01T00:00:00Z'),
      now: new Date('2026-04-11T00:00:00Z'), // 265 jours restants
    });

    expect(result.isSuccess()).toBe(true);
    // (550000-350000) * 265 / 365 = 145205.47... -> arrondi
    const expectedRaw = (200_000 * 265) / 365;
    expect(result.getValue().amount).toBe(Math.round(expectedRaw));
  });
});
