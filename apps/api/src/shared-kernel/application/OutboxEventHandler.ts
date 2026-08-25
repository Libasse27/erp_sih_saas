/**
 * Contrat d'un consommateur d'evenement Outbox (D9) — vit dans shared-kernel/application/ (pas
 * infrastructure/) : c'est un PORT, au meme titre que `UnitOfWork.ts` dans ce dossier, pas un
 * detail de l'implementation du relais (`shared-kernel/infrastructure/persistence/
 * OutboxRelay.ts`, qui l'implemente/l'invoque). Permet aux `application/services/*` de chaque
 * module d'exposer des handlers conformes a ce type SANS importer `infrastructure/` (regle CI
 * §5 : application/ n'importe jamais infrastructure/).
 *
 * `payload` reste `unknown` : c'est le JSON persiste par `OutboxWriter.ts`, potentiellement
 * emis par un AUTRE module (voir `SubscriptionRenewalDue` -> module `payment`) — chaque handler
 * DOIT valider sa forme avant usage (frontiere de confiance, regle §2 du system prompt), jamais
 * supposer un typage statique partage entre modules.
 */
export interface OutboxEventEnvelope {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateId: string;
  readonly tenantId: string | null;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

/** Un consommateur d'evenement Outbox. DOIT etre idempotent (re-livraison possible, at-least-once, D9). */
export type OutboxEventHandler = (envelope: OutboxEventEnvelope) => Promise<void>;
