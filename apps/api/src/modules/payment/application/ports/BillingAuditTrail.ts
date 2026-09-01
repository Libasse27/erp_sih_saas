/**
 * Types d'evenement d'audit `BILLING` (ADR-0009 §2.2). Union primitive DUPLIQUEE de
 * `modules/audit/domain/value-objects/AuditEventType.ts` (jamais importee depuis `payment` : un
 * module n'importe jamais le domain/ d'un autre module) — meme discipline qu'ADR-0005 §5.
 */
export type BillingAuditEventType =
  | 'BILLING_PAYMENT_INITIATED'
  | 'BILLING_PAYMENT_CONFIRMED'
  | 'BILLING_PLATFORM_INVOICE_ISSUED'
  | 'BILLING_PLATFORM_INVOICE_SETTLED';

export type BillingAuditTargetType = 'PAYMENT' | 'PLATFORM_INVOICE';

/**
 * "Depuis quel contexte" — miroir primitif d'`ActorKind`. `ConfirmPaymentHandler` est un webhook
 * NON AUTHENTIFIE (SYSTEM par construction) ; les trois consommateurs Outbox le sont egalement ;
 * `InitiatePaymentHandler` ne threade aujourd'hui aucun acteur (voir le rapport de cette etape) :
 * `SYSTEM` est la SEULE valeur emise a ce jour.
 */
export type BillingActorKind = 'SYSTEM' | 'USER_TENANT' | 'USER_PLATFORM';

export interface BillingAuditRecordInput {
  readonly eventType: BillingAuditEventType;
  readonly outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  readonly tenantId: string;
  readonly actorKind: BillingActorKind;
  readonly actorUserId: string | null;
  readonly targetType: BillingAuditTargetType;
  readonly targetId: string;
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

/**
 * Port sortant de `payment` vers le module `audit` (ADR-0009 §2.2/§4). L'implementation reelle
 * est cablee dans `composition-root.ts`. `record()` DOIT etre appele DANS LA TRANSACTION
 * COURANTE, jamais depuis un consommateur Outbox dont la SEULE fonction serait d'ecrire de
 * l'audit.
 */
export interface BillingAuditTrail {
  record(input: BillingAuditRecordInput): Promise<void>;
}
