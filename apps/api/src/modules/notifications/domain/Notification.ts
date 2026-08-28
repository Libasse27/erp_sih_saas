import { Entity } from '../../../shared-kernel/domain/Entity.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import type { NotificationId } from './value-objects/NotificationId.js';
import type { NotificationChannel } from './value-objects/NotificationChannel.js';
import type { NotificationStatus } from './value-objects/NotificationStatus.js';
import type { NotificationTemplateKind } from './value-objects/NotificationTemplateKind.js';

export class EmptyNotificationRecipientError extends Error {
  constructor() {
    super('Le destinataire d\'une notification ne peut pas etre vide.');
    this.name = 'EmptyNotificationRecipientError';
  }
}

export class InvalidNotificationRecipientForChannelError extends Error {
  constructor(channel: NotificationChannel, recipient: string) {
    super(`Destinataire invalide pour le canal ${channel} : "${recipient}".`);
    this.name = 'InvalidNotificationRecipientForChannelError';
  }
}

export type CreateNotificationError = EmptyNotificationRecipientError | InvalidNotificationRecipientForChannelError;

interface NotificationProps {
  readonly tenantId: TenantId | null;
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly templateKind: NotificationTemplateKind;
  /** Identifiant du `DomainEvent` (via l'enveloppe Outbox) a l'origine de cette notification — fait partie de la cle d'idempotence (ADR-0007 §6, `@@unique([sourceEventId, channel, recipient])`). */
  readonly sourceEventId: string;
  status: NotificationStatus;
  attempts: number;
  lastError: string | null;
  providerMessageId: string | null;
  nextAttemptAt: Date | null;
  readonly createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

/** Verification minimale, DEFENSE EN PROFONDEUR : le destinataire est deja valide a la source (Email/PhoneNumber VO du module emetteur) — ce n'est pas ici que la validation complete a lieu, seulement un garde-fou contre une chaine vide/corrompue. */
function isPlausibleForChannel(channel: NotificationChannel, recipient: string): boolean {
  return channel === 'EMAIL' ? recipient.includes('@') : /^\+[0-9]{6,15}$/.test(recipient);
}

/**
 * Notification (01-target-architecture.md §6.3/§9.4) — trace CHAQUE envoi (canal, destinataire,
 * evenement declencheur, statut, tentatives, erreur, identifiant fournisseur). N'est PAS un
 * `AggregateRoot` : n'emet aucun `DomainEvent` (le pipeline de livraison qui la consomme n'est pas
 * l'Outbox — voir ADR-0007 §6) — meme choix que `RefreshToken.ts`.
 *
 * Le CLAIM (PENDING -> PROCESSING) et la transition finale (-> SENT/PENDING-retry/FAILED/
 * DEAD_LETTER) sont geres par `NotificationRelay.ts`/`NotificationWorker.ts` via des `UPDATE`
 * SQL conditionnels directs — meme discipline que `OutboxRelay.ts`/`OutboxWorker.ts`, qui
 * n'operent pas non plus via des methodes d'agregat pour ces transitions a haute concurrence.
 * Cette classe ne porte donc que la construction initiale (invariants a la creation).
 */
export class Notification extends Entity<NotificationId> {
  private props: NotificationProps;

  private constructor(id: NotificationId, props: NotificationProps) {
    super(id);
    this.props = props;
  }

  static create(params: {
    id: NotificationId;
    tenantId: TenantId | null;
    channel: NotificationChannel;
    recipient: string;
    templateKind: NotificationTemplateKind;
    sourceEventId: string;
    now: Date;
  }): Result<Notification, CreateNotificationError> {
    const recipient = params.recipient.trim();
    if (recipient.length === 0) {
      return Result.failure(new EmptyNotificationRecipientError());
    }
    if (!isPlausibleForChannel(params.channel, recipient)) {
      return Result.failure(new InvalidNotificationRecipientForChannelError(params.channel, recipient));
    }
    return Result.success(
      new Notification(params.id, {
        tenantId: params.tenantId,
        channel: params.channel,
        recipient,
        templateKind: params.templateKind,
        sourceEventId: params.sourceEventId,
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        providerMessageId: null,
        nextAttemptAt: null,
        createdAt: params.now,
        updatedAt: params.now,
        sentAt: null,
      }),
    );
  }

  static reconstitute(id: NotificationId, props: NotificationProps): Notification {
    return new Notification(id, props);
  }

  get tenantId(): TenantId | null {
    return this.props.tenantId;
  }

  get channel(): NotificationChannel {
    return this.props.channel;
  }

  get recipient(): string {
    return this.props.recipient;
  }

  get templateKind(): NotificationTemplateKind {
    return this.props.templateKind;
  }

  get sourceEventId(): string {
    return this.props.sourceEventId;
  }

  get status(): NotificationStatus {
    return this.props.status;
  }

  get attempts(): number {
    return this.props.attempts;
  }

  get lastError(): string | null {
    return this.props.lastError;
  }

  get providerMessageId(): string | null {
    return this.props.providerMessageId;
  }

  get nextAttemptAt(): Date | null {
    return this.props.nextAttemptAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get sentAt(): Date | null {
    return this.props.sentAt;
  }
}
