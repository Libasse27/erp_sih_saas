/**
 * Statut de cycle de vie de l'abonnement. Etendu a l'etape 5/13 (integration O-25/O-03) —
 * initialement minimal a l'etape 4 (`TRIALING`/`ACTIVE` seuls), le passage a `GRACE_PERIOD`/
 * `DEGRADED` fait desormais partie du perimetre explicitement confie a cette etape ("methodes/
 * transitions necessaires pour reagir aux nouveaux evenements — grace, mode degrade,
 * reactivation").
 *
 * - `TRIALING` : essai gratuit (O-02.5), forfait STANDARD, `trialEndsAt` renseigne, aucun moyen
 *   de paiement requis a l'activation.
 * - `ACTIVE` : abonnement payant en cours, periode couverte par un paiement confirme.
 * - `GRACE_PERIOD` : echeance depassee (`periodEndsAt`), AUCUN paiement confirme pour la nouvelle
 *   periode — periode de grace de 7 jours (O-03.2). Continuite des soins garantie, aucune donnee
 *   supprimee (O-03.1).
 * - `DEGRADED` : grace expiree sans regularisation — mode degrade (O-03.2/O-03.3), fonctions
 *   commerciales/administratives non essentielles restreintes UNIQUEMENT (jamais l'acces
 *   clinique — hors perimetre de ce module, qui ne connait et ne doit connaitre que ce statut,
 *   pas les regles d'acces elles-memes). Maintenu indefiniment au-dela de J+37 (O-03.3), sans
 *   transition ulterieure automatique — seul un paiement confirme en sort (`reactivate()`).
 */
export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'GRACE_PERIOD', 'DEGRADED'] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
