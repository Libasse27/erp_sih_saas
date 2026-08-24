import { describe, expect, it } from 'vitest';
import { PlanName } from './PlanName.js';

describe('PlanName', () => {
  it('accepte un nom non vide et le normalise (trim)', () => {
    const result = PlanName.create('  Standard  ');
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().value).toBe('Standard');
  });

  it('rejette une chaine vide (y compris apres trim)', () => {
    expect(PlanName.create('   ').isFailure()).toBe(true);
  });

  it('rejette un nom au-dela de la longueur maximale', () => {
    expect(PlanName.create('A'.repeat(101)).isFailure()).toBe(true);
  });

  it('accepte un nom pile a la limite de longueur', () => {
    expect(PlanName.create('A'.repeat(100)).isSuccess()).toBe(true);
  });
});
