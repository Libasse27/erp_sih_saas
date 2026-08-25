/**
 * A quoi correspond ce paiement (O-25.1 : "abonnement initial + renouvellements + upgrade
 * proratise"). `UPGRADE` est modelisable mais N'EST PAS EMIS par cette etape — le retro-branchement
 * de `UpgradeSubscriptionPlanHandler` (etape 4) vers ce module reste un residu explicite (voir
 * rapport de fin de tache), pour ne pas modifier un contrat deja livre sans mandat explicite.
 */
export const PAYMENT_PURPOSES = ['INITIAL', 'RENEWAL', 'UPGRADE'] as const;

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export function isPaymentPurpose(value: string): value is PaymentPurpose {
  return (PAYMENT_PURPOSES as readonly string[]).includes(value);
}
