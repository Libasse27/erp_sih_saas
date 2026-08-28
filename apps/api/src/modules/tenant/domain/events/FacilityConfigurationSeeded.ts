import type { DomainEvent } from '../../../../shared-kernel/domain/DomainEvent.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';

/**
 * Emis a la creation d'un `FacilitySettings` (ADR-0008 §10, amendement 1, Phase 0 etape 10/13) —
 * troisieme etape chorographiee de la Saga de provisioning : la configuration technique minimale
 * du tenant (parametres regionaux, PAS de contenu metier hospitalier) vient d'etre semee.
 * `aggregateId` = identifiant de `FacilitySettings` ; `tenantId` designe le tenant concerne
 * (distinct de `aggregateId`, contrairement a `HealthFacilityCreated`).
 */
export class FacilityConfigurationSeeded implements DomainEvent {
  readonly eventId: string;
  readonly eventType = 'tenant.facility-configuration-seeded';
  readonly eventVersion = 1;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly phoneCountryCode: string;

  private constructor(params: {
    eventId: string;
    occurredAt: Date;
    aggregateId: string;
    tenantId: string;
    locale: string;
    timezone: string;
    currency: string;
    phoneCountryCode: string;
  }) {
    this.eventId = params.eventId;
    this.occurredAt = params.occurredAt;
    this.aggregateId = params.aggregateId;
    this.tenantId = params.tenantId;
    this.locale = params.locale;
    this.timezone = params.timezone;
    this.currency = params.currency;
    this.phoneCountryCode = params.phoneCountryCode;
  }

  static create(params: {
    facilitySettingsId: string;
    tenantId: string;
    locale: string;
    timezone: string;
    currency: string;
    phoneCountryCode: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): FacilityConfigurationSeeded {
    return new FacilityConfigurationSeeded({
      eventId: params.idGenerator.generate(),
      occurredAt: params.clock.now(),
      aggregateId: params.facilitySettingsId,
      tenantId: params.tenantId,
      locale: params.locale,
      timezone: params.timezone,
      currency: params.currency,
      phoneCountryCode: params.phoneCountryCode,
    });
  }
}
