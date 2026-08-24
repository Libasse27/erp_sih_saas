import type { PlanPrice } from '../PlanPrice.js';
import type { BillingPeriod } from '../value-objects/BillingPeriod.js';
import type { PlanId } from '../value-objects/PlanId.js';
import type { PlanPriceId } from '../value-objects/PlanPriceId.js';

/**
 * Port de persistance pour `PlanPrice` — tarif historise, niveau plateforme (schema `platform`,
 * ADR-0001 §3.3), aucun `tenantId`.
 */
export interface PlanPriceRepository {
  findById(id: PlanPriceId): Promise<PlanPrice | null>;

  /**
   * Resout le `PlanPrice` REELLEMENT applicable pour un `(planId, period)` a un instant donne :
   * le plus recent dont `effectiveFrom <= asOf`. C'est la SEULE maniere autorisee de determiner
   * un montant a facturer (O-02.6) — jamais `plan.price`, jamais le premier ou le dernier tarif
   * du catalogue sans egard a `effectiveFrom`.
   */
  findEffectivePrice(planId: PlanId, period: BillingPeriod, asOf: Date): Promise<PlanPrice | null>;

  /** Append-only : chaque appel cree une NOUVELLE ligne, jamais une mise a jour d'une ligne existante (voir PlanPrice.ts). */
  save(price: PlanPrice): Promise<void>;
}
