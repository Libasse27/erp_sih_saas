/**
 * Periodicite de facturation — O-02.2 (mensuel + annuel, remise annuelle ~16,7 % deja integree
 * au tarif catalogue, pas calculee dynamiquement ici). Enumeration litterale fermee, meme choix
 * que `PlanCode`.
 */
export const BILLING_PERIODS = ['MENSUEL', 'ANNUEL'] as const;

export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export function isBillingPeriod(value: string): value is BillingPeriod {
  return (BILLING_PERIODS as readonly string[]).includes(value);
}
