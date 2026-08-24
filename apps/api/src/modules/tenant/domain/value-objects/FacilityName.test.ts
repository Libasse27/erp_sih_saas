import { describe, expect, it } from 'vitest';
import { FacilityName } from './FacilityName.js';

describe('FacilityName', () => {
  it('accepte un nom non vide et le normalise (trim)', () => {
    const result = FacilityName.create('  Hopital Principal de Dakar  ');
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().value).toBe('Hopital Principal de Dakar');
  });

  it('rejette une chaine vide (y compris apres trim)', () => {
    const result = FacilityName.create('   ');
    expect(result.isFailure()).toBe(true);
  });

  it('rejette un nom au-dela de la longueur maximale', () => {
    const result = FacilityName.create('A'.repeat(201));
    expect(result.isFailure()).toBe(true);
  });

  it('accepte un nom pile a la limite de longueur', () => {
    const result = FacilityName.create('A'.repeat(200));
    expect(result.isSuccess()).toBe(true);
  });
});
