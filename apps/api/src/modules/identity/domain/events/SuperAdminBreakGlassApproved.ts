import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis quand un DEUXIEME `SUPER_ADMIN`, distinct du demandeur et du sujet, approuve une demande
 * de recuperation break-glass (ADR-0005 Amendement 1, O-04 residu 4). L'approbation declenche
 * IMMEDIATEMENT, dans la MEME transaction applicative (`ApproveSuperAdminBreakGlassHandler`), la
 * reinitialisation MFA du sujet et la revocation de toutes ses sessions — cet evenement porte donc
 * aussi bien l'alerte "resultat" que l'alerte "approbation" (une seule etape d'execution, voir
 * ADR-0005 Amendement 1 : "audit final + alerte de resultat" == cette meme approbation).
 */
export class SuperAdminBreakGlassApproved implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'identity.super-admin-break-glass.approved';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string | null = null;
  readonly aggregateId: string;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string;
  readonly subjectUserAccountId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    requestedByUserId: string;
    approvedByUserId: string;
    subjectUserAccountId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.requestedByUserId = params.requestedByUserId;
    this.approvedByUserId = params.approvedByUserId;
    this.subjectUserAccountId = params.subjectUserAccountId;
  }

  static create(params: {
    requestId: string;
    requestedByUserId: string;
    approvedByUserId: string;
    subjectUserAccountId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): SuperAdminBreakGlassApproved {
    return new SuperAdminBreakGlassApproved({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.requestId,
      requestedByUserId: params.requestedByUserId,
      approvedByUserId: params.approvedByUserId,
      subjectUserAccountId: params.subjectUserAccountId,
    });
  }
}
