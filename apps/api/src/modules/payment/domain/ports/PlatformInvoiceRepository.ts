import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlatformInvoice } from '../PlatformInvoice.js';
import type { PlatformInvoiceId } from '../value-objects/PlatformInvoiceId.js';

export interface PlatformInvoiceRepository {
  findById(id: PlatformInvoiceId, tenantId: TenantId): Promise<PlatformInvoice | null>;

  /**
   * Emission IDEMPOTENTE : la contrainte UNIQUE `(subscriptionId, periodStartsAt)` (voir
   * migration SQL) est la barriere reelle contre la double-facturation en cas de renouvellements
   * concurrents (deux scheduler ticks, ou une re-livraison Outbox de `SubscriptionRenewalDue`).
   * Si une facture existe deja pour cette periode, l'IMPLEMENTATION DOIT la renvoyer (pas lever
   * d'erreur) — c'est ce contrat, pas seulement une discipline d'appel, qui rend
   * `IssuePlatformInvoiceOnRenewalDue.ts` idempotent.
   */
  issue(invoice: PlatformInvoice): Promise<PlatformInvoice>;

  save(invoice: PlatformInvoice, tenantId: TenantId): Promise<void>;
}
