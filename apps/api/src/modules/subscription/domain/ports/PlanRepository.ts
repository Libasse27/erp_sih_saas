import type { Plan } from '../Plan.js';
import type { PlanCode } from '../value-objects/PlanCode.js';
import type { PlanId } from '../value-objects/PlanId.js';

/**
 * Port de persistance pour `Plan` — catalogue global, niveau plateforme (schema `platform`,
 * ADR-0001 §3.3), aucun `tenantId` : par construction, un forfait n'appartient a aucun tenant en
 * particulier, il est visible de tous.
 */
export interface PlanRepository {
  findById(id: PlanId): Promise<Plan | null>;

  findByCode(code: PlanCode): Promise<Plan | null>;

  save(plan: Plan): Promise<void>;
}
