import type { FacilityStatus } from '../../domain/value-objects/FacilityStatus.js';

/**
 * DTO explicite (jamais l'agregat `HealthFacility` ni une ligne Prisma brute exposee — regle 6 du
 * system prompt) — reponse PARTAGEE par `GET /api/v1/facility` et `PATCH /api/v1/facility` (les
 * deux operations portent sur le meme etablissement, la seconde retourne la ressource mise a jour,
 * convention deja en place ADR-0010 §7 bis C pour `AuthenticatedSessionResponse`).
 */
export interface HealthFacilityResponse {
  readonly tenantId: string;
  readonly name: string;
  readonly status: FacilityStatus;
  readonly createdAt: string;
}

export function toHealthFacilityResponse(facility: {
  readonly tenantId: string;
  readonly name: string;
  readonly status: FacilityStatus;
  readonly createdAt: Date;
}): HealthFacilityResponse {
  return {
    tenantId: facility.tenantId,
    name: facility.name,
    status: facility.status,
    createdAt: facility.createdAt.toISOString(),
  };
}
