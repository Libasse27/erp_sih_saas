import { describe, expect, it } from 'vitest';
import { PlanLimits } from './PlanLimits.js';

describe('PlanLimits', () => {
  it('accepte des limites entieres strictement positives', () => {
    const result = PlanLimits.create(10, 20);
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().maxUsers).toBe(10);
    expect(result.getValue().maxBeds).toBe(20);
  });

  it('rejette maxUsers <= 0', () => {
    expect(PlanLimits.create(0, 20).isFailure()).toBe(true);
    expect(PlanLimits.create(-1, 20).isFailure()).toBe(true);
  });

  it('rejette maxBeds <= 0', () => {
    expect(PlanLimits.create(10, 0).isFailure()).toBe(true);
  });

  it('rejette des valeurs non entieres', () => {
    expect(PlanLimits.create(10.5, 20).isFailure()).toBe(true);
    expect(PlanLimits.create(10, 20.5).isFailure()).toBe(true);
  });
});
