import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Signal de cloture de la Saga de provisioning (ADR-0008 §11, amendement 1, Phase 0 etape 10/13)
 * — dernier evenement de la chaine chorographiee. AUCUNE SEMANTIQUE METIER au-dela de "la Saga a
 * atteint sa fin" : ne porte aucun etat, n'introduit aucune machine a etats backend.
 *
 * IMPORTANT (ADR-0008 §3/§11, rappel non negociable) : cet evenement N'EST JAMAIS consulte par
 * `TenantModuleBackedAccessChecker` (composition-root.ts) — l'acces reste TOUJOURS derive
 * DYNAMIQUEMENT de l'etat reel de `HealthFacility`/`Subscription`, jamais d'un indicateur de
 * progression de Saga. Un futur consommateur de cet evenement reste possible (ex. demarrage du
 * parcours "onboarding" cote `apps/web`, deja evoque par 02-roadmap-migration.md) mais AUCUN
 * consommateur backend ne doit jamais le traiter comme une preuve d'autorisation.
 */
export class ProvisioningCompleted implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'tenant.provisioning.completed';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
  }

  static create(params: {
    facilitySettingsId: string;
    tenantId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): ProvisioningCompleted {
    return new ProvisioningCompleted({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.facilitySettingsId,
      tenantId: params.tenantId,
    });
  }
}
