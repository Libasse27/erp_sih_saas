/**
 * Minimal V1 : une facture plateforme est emise puis payee. Pas d'annulation/avoir — O-25.1 :
 * "remboursement d'abonnement SaaS explicitement hors V1".
 */
export const PLATFORM_INVOICE_STATUSES = ['ISSUED', 'PAID'] as const;

export type PlatformInvoiceStatus = (typeof PLATFORM_INVOICE_STATUSES)[number];

export function isPlatformInvoiceStatus(value: string): value is PlatformInvoiceStatus {
  return (PLATFORM_INVOICE_STATUSES as readonly string[]).includes(value);
}
