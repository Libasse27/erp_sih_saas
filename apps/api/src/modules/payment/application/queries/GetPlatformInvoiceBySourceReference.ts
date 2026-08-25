import { Result } from '../../../../shared-kernel/domain/Result.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { PlatformInvoiceRepository } from '../../domain/ports/PlatformInvoiceRepository.js';

export type GetPlatformInvoiceBySourceReferenceError = 'INVALID_TENANT_ID';

export interface PlatformInvoiceReference {
  readonly platformInvoiceId: string;
  readonly amountXof: number;
  readonly status: string;
}

/**
 * PREMIERE query du module (aucun pattern `queries/` n'existait ailleurs dans le depot : ni
 * `CommandBus`/`QueryBus`, ni `application/queries/` — les lectures passaient jusqu'ici par les
 * repositories depuis les handlers). Volontairement MINIMALE, sur le modele des handlers de
 * commande existants (`{ execute(...): Promise<Result<...>> }`) plutot que d'introduire une
 * infrastructure de bus qu'aucun ADR n'a decidee.
 *
 * Repond a la seule question que la passe 2 rend necessaire cote appelant : "quelle facture
 * plateforme regler pour le fait metier que j'ai declenche ?" — indispensable des qu'un endpoint
 * HTTP exposera la demande d'upgrade (le client recoit un `planChangeId`, il doit pouvoir en
 * deduire la facture a payer sans deviner un couple `(subscriptionId, periodStartsAt)`).
 * Renvoie `null` — jamais une erreur — si aucune facture ne porte cette reference : soit
 * l'evenement `SubscriptionUpgradeRequested` n'a pas encore ete relaye (l'Outbox est
 * asynchrone, at-least-once : un decalage de quelques secondes est le fonctionnement NORMAL,
 * pas une anomalie), soit la reference est inconnue de ce tenant — deux cas que l'appelant traite
 * de la meme facon (reessayer plus tard), et qu'il serait trompeur de distinguer par un code
 * d'erreur.
 */
export class GetPlatformInvoiceBySourceReferenceHandler {
  constructor(private readonly platformInvoiceRepository: PlatformInvoiceRepository) {}

  async execute(
    sourceReference: string,
    tenantId: string,
  ): Promise<Result<PlatformInvoiceReference | null, GetPlatformInvoiceBySourceReferenceError>> {
    const tenantIdResult = TenantId.create(tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }

    const invoice = await this.platformInvoiceRepository.findBySourceReference(
      sourceReference,
      tenantIdResult.getValue(),
    );
    if (invoice === null) {
      return Result.success(null);
    }

    // DTO explicite : jamais l'agregat lui-meme (§6 du system prompt — aucune reponse ne se fait
    // sur un objet de persistance/domaine brut).
    return Result.success({
      platformInvoiceId: invoice.id.toString(),
      amountXof: invoice.amount.amount,
      status: invoice.status,
    });
  }
}
