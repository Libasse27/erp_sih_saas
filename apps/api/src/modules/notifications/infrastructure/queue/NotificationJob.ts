/**
 * File BullMQ DEDIEE au pipeline de livraison des notifications — DISTINCTE de `outbox-relay`
 * (ADR-0007 §6 : deux pipelines, deux politiques de retry deliberement differentes, jamais
 * confondues). `buildOutboxJobId`/`parseOutboxJobId` (`shared-kernel/infrastructure/queue/
 * OutboxJob.ts`) sont GENERIQUES malgre leur nom (encodage `<id>#<attempts>`, aucune dependance a
 * `OutboxMessage`) — reutilises tels quels ici plutot que dupliques.
 */
export const NOTIFICATION_QUEUE_NAME = 'notification-delivery';

/** Meme discipline de securite que `OutboxJobData` : ne porte QUE l'identifiant de la ligne `platform.Notification` — jamais son contenu (destinataire, texte). Redis n'est pas une frontiere de confiance ; le worker relit systematiquement Postgres avant tout envoi. */
export interface NotificationJobData {
  readonly id: string;
}
