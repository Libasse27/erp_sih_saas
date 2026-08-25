import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlatformInvoice } from '../PlatformInvoice.js';
import type { PlatformInvoiceId } from '../value-objects/PlatformInvoiceId.js';

export interface PlatformInvoiceRepository {
  findById(id: PlatformInvoiceId, tenantId: TenantId): Promise<PlatformInvoice | null>;

  /**
   * Retrouve une facture par la reference OPAQUE du fait metier qui l'a declenchee (voir
   * `PlatformInvoice.sourceReference`) — `null` si aucune facture ne porte cette reference. Sert au
   * module emetteur pour savoir quelle facture regler pour SON fait metier, sans jamais avoir a
   * deviner un couple `(subscriptionId, periodStartsAt)`.
   */
  findBySourceReference(sourceReference: string, tenantId: TenantId): Promise<PlatformInvoice | null>;

  /**
   * Emission IDEMPOTENTE : la table porte DEUX contraintes UNIQUE, chacune couvrant un chemin
   * d'emission (voir migration SQL) —
   *   - `(subscriptionId, purpose, periodStartsAt)` : barriere contre la double-facturation lors de
   *     renouvellements concurrents (deux scheduler ticks, ou une re-livraison Outbox de
   *     `SubscriptionRenewalDue`) ;
   *   - `sourceReference` : barriere equivalente pour les factures declenchees par un fait metier
   *     identifie (upgrade proratise), y compris en cas de re-livraison Outbox at-least-once.
   * Si une facture existe deja au titre de l'une OU l'autre de ces contraintes, l'IMPLEMENTATION
   * DOIT la renvoyer (pas lever d'erreur) — c'est ce contrat, pas seulement une discipline
   * d'appel, qui rend `IssuePlatformInvoiceOnRenewalDue.ts` et
   * `IssuePlatformInvoiceOnUpgradeRequested.ts` idempotents.
   */
  issue(invoice: PlatformInvoice): Promise<PlatformInvoice>;

  save(invoice: PlatformInvoice, tenantId: TenantId): Promise<void>;
}
