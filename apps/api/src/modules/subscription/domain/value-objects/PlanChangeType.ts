/**
 * Type de changement de forfait historise. Une seule valeur en V1 : le downgrade reste
 * differe a la fin de periode et n'est pas implemente par cette etape (O-02.6 — deja tranche,
 * hors perimetre ici, voir 03-open-decisions.md O-02). `DOWNGRADE` sera ajoute a cet ensemble
 * ferme quand ce flux sera implemente, jamais devine par avance.
 */
export const PLAN_CHANGE_TYPES = ['UPGRADE'] as const;

export type PlanChangeType = (typeof PLAN_CHANGE_TYPES)[number];

export function isPlanChangeType(value: string): value is PlanChangeType {
  return (PLAN_CHANGE_TYPES as readonly string[]).includes(value);
}
