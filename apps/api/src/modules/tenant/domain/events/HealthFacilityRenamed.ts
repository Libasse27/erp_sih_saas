import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis par `HealthFacility.rename()` (Phase 1, premier increment vertical — permission
 * `tenant-config:administer`) UNE SEULE FOIS par renommage EFFECTIF (jamais si le nom soumis est
 * strictement identique au nom courant, voir `FacilityNameUnchangedError` dans HealthFacility.ts).
 *
 * `tenantId` = `aggregateId` (le `HealthFacility` EST le tenant, meme convention que
 * `HealthFacilityCreated.ts` — voir son commentaire de tete pour le detail complet).
 *
 * Aucun consommateur Outbox n'est cable a ce jour pour cet evenement (aucun besoin identifie a
 * cette etape — pas de notification, pas de projection derivee du nom d'etablissement) : il est
 * neanmoins ecrit dans l'Outbox comme tout evenement de domaine (D9), disponible pour un futur
 * consommateur sans migration supplementaire.
 */
export class HealthFacilityRenamed implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'tenant.health-facility.renamed';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly previousName: string;
  readonly newName: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    previousName: string;
    newName: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.aggregateId;
    this.previousName = params.previousName;
    this.newName = params.newName;
  }

  static create(params: {
    healthFacilityId: string;
    previousName: string;
    newName: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): HealthFacilityRenamed {
    return new HealthFacilityRenamed({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.healthFacilityId,
      previousName: params.previousName,
      newName: params.newName,
    });
  }
}
