/**
 * Code du forfait — catalogue V1 clos par O-02 (03-open-decisions.md). Exactement ces trois
 * valeurs, aucune autre inventee. Simple enumeration litterale (pas de VO complet), meme choix
 * que `FacilityStatus`/`MembershipStatus` : aucun invariant au-dela de l'appartenance a cet
 * ensemble ferme.
 */
export const PLAN_CODES = ['STANDARD', 'PROFESSIONNEL', 'COMPLET'] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}
