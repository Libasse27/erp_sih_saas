import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { Plan } from '../../domain/Plan.js';
import { PlanPrice } from '../../domain/PlanPrice.js';
import type { PlanPriceRepository } from '../../domain/ports/PlanPriceRepository.js';
import type { PlanRepository } from '../../domain/ports/PlanRepository.js';
import type { BillingPeriod } from '../../domain/value-objects/BillingPeriod.js';
import type { PlanCode } from '../../domain/value-objects/PlanCode.js';
import { PlanLimits } from '../../domain/value-objects/PlanLimits.js';
import { PlanName } from '../../domain/value-objects/PlanName.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';

/**
 * Catalogue V1 fige par O-02 (03-open-decisions.md O-02, reliquat clos le 2026-08-24) et
 * 01-target-architecture.md §6.3 — CROSS-CHECKE contre les deux sources avant d'ecrire ce fichier,
 * aucune valeur inventee ni approximee. Remise annuelle ~16,7 % (2 mois offerts) deja integree au
 * tarif annuel catalogue, pas recalculee dynamiquement.
 */
const PLAN_CATALOG: ReadonlyArray<{
  readonly code: PlanCode;
  readonly name: string;
  readonly maxUsers: number;
  readonly maxBeds: number;
  readonly prices: ReadonlyArray<{ readonly period: BillingPeriod; readonly amountXof: number }>;
}> = [
  {
    code: 'STANDARD',
    name: 'Standard',
    maxUsers: 10,
    maxBeds: 20,
    prices: [
      { period: 'MENSUEL', amountXof: 35_000 },
      { period: 'ANNUEL', amountXof: 350_000 },
    ],
  },
  {
    code: 'PROFESSIONNEL',
    name: 'Professionnel',
    maxUsers: 30,
    maxBeds: 50,
    prices: [
      { period: 'MENSUEL', amountXof: 55_000 },
      { period: 'ANNUEL', amountXof: 550_000 },
    ],
  },
  {
    code: 'COMPLET',
    name: 'Complet',
    maxUsers: 100,
    maxBeds: 200,
    prices: [
      { period: 'MENSUEL', amountXof: 75_000 },
      { period: 'ANNUEL', amountXof: 750_000 },
    ],
  },
];

/**
 * Seed du catalogue de forfaits ET de leur tarif initial (niveau plateforme, tables
 * `platform.Plan` / `platform.PlanPrice`). Idempotent : ne cree un `Plan` ou un `PlanPrice` que
 * s'il n'existe pas deja pour ce `(code)` / `(planId, period, effectiveFrom)` — meme regime que
 * `seedIdentityCatalog.ts` (module Identity, etape 2). `effectiveFrom` fixe au 2026-08-24 (date
 * de cloture du reliquat O-02, cf. clock injecte par l'appelant) : premier tarif catalogue,
 * applicable a toute souscription a compter de cette date.
 */
export async function seedPlanCatalog(
  planRepository: PlanRepository,
  planPriceRepository: PlanPriceRepository,
  clock: Clock,
  idGenerator: IdGenerator,
): Promise<void> {
  for (const definition of PLAN_CATALOG) {
    let plan = await planRepository.findByCode(definition.code);
    if (plan === null) {
      plan = Plan.create({
        code: definition.code,
        name: assertValid(PlanName.create(definition.name)),
        limits: assertValid(PlanLimits.create(definition.maxUsers, definition.maxBeds)),
        clock,
        idGenerator,
      });
      await planRepository.save(plan);
    }

    for (const priceDefinition of definition.prices) {
      const effectiveFrom = clock.now();
      const existing = await planPriceRepository.findEffectivePrice(plan.id, priceDefinition.period, effectiveFrom);
      if (existing !== null) {
        continue;
      }
      const price = PlanPrice.create({
        planId: plan.id,
        amount: assertValid(Money.fromXOF(priceDefinition.amountXof)),
        period: priceDefinition.period,
        effectiveFrom,
        clock,
        idGenerator,
      });
      await planPriceRepository.save(price);
    }
  }
}
