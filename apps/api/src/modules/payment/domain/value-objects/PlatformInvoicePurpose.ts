/**
 * A quoi correspond une facture PLATEFORME. Deux chemins d'emission existent, et deux seulement :
 * l'echeance de renouvellement (`application/services/IssuePlatformInvoiceOnRenewalDue.ts`) et
 * l'upgrade proratise (`application/services/IssuePlatformInvoiceOnUpgradeRequested.ts`).
 *
 * VOLONTAIREMENT SANS `'INITIAL'`, contrairement a `PaymentPurpose` : cette liste ne declare que
 * des valeurs REELLEMENT emises par du code existant. `PaymentPurpose.INITIAL` est un residu deja
 * documente la-bas ; le dupliquer ici creerait un SECOND residu jamais atteint, dont plus personne
 * ne saurait dire, dans six mois, s'il correspond a un chemin oublie ou a une intention future.
 */
export const PLATFORM_INVOICE_PURPOSES = ['RENEWAL', 'UPGRADE'] as const;

export type PlatformInvoicePurpose = (typeof PLATFORM_INVOICE_PURPOSES)[number];

export function isPlatformInvoicePurpose(value: string): value is PlatformInvoicePurpose {
  return (PLATFORM_INVOICE_PURPOSES as readonly string[]).includes(value);
}
