import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a la creation d'un `HealthFacility`, c'est-a-dire a la naissance du tenant lui-meme.
 * `tenantId` = `aggregateId` (le HealthFacility EST le tenant, voir HealthFacility.ts) —
 * contrairement aux evenements Identity ou `tenantId` designe un tenant distinct de l'agregat
 * qui emet l'evenement.
 *
 * `ownerUserId` (ADR-0008 §9, amendement 1, Phase 0 etape 10/13) : identifiant du `UserAccount`
 * qui doit recevoir le role `ADMIN_ETABLISSEMENT` sur ce tenant naissant. AJOUT ADDITIF —
 * `eventVersion` reste `1` (docs/domain/events.md, convention de versionnage) : aucun champ
 * existant n'est renomme ni supprime. Simple donnee de CORRELATION du provisioning initial,
 * jamais une relation persistante `User -> Tenant` (le modele relationnel reste
 * `UserAccount -> UserTenantMembership -> HealthFacility`, O-05, inchange) — `HealthFacility`
 * lui-meme NE STOCKE PAS cette valeur (voir HealthFacility.create()).
 */
export class HealthFacilityCreated implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'tenant.health-facility.created';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly name: string;
  readonly ownerUserId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    name: string;
    ownerUserId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.aggregateId;
    this.name = params.name;
    this.ownerUserId = params.ownerUserId;
  }

  static create(params: {
    healthFacilityId: string;
    name: string;
    ownerUserId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): HealthFacilityCreated {
    return new HealthFacilityCreated({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.healthFacilityId,
      name: params.name,
      ownerUserId: params.ownerUserId,
    });
  }
}
