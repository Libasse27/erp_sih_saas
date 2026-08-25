/**
 * Moyens de paiement automatises (O-25.2) : Mobile Money + carte bancaire. Le VIREMENT est
 * DELIBEREMENT ABSENT de cette enumeration — "exclu du flux automatise `InitiatePayment`,
 * reserve a un reglement manuel/commercial" (O-25.2) : le rendre inexprimable ici, plutot que de
 * l'exclure par une verification a l'appel, applique la regle "par construction" (meme discipline
 * que le reste du depot, ex. `PlanChangeType` limite a `UPGRADE`).
 */
export const PAYMENT_METHODS = ['MOBILE_MONEY', 'CARD'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value);
}
