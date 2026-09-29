/**
 * DTO explicite (jamais l'agregat `FacilitySettings` ni une ligne Prisma brute exposee — regle 6
 * du system prompt) — reponse de `GET /api/v1/facility-settings`.
 */
export interface FacilitySettingsResponse {
  readonly tenantId: string;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly phoneCountryCode: string;
  readonly createdAt: string;
}

export function toFacilitySettingsResponse(settings: {
  readonly tenantId: string;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly phoneCountryCode: string;
  readonly createdAt: Date;
}): FacilitySettingsResponse {
  return {
    tenantId: settings.tenantId,
    locale: settings.locale,
    timezone: settings.timezone,
    currency: settings.currency,
    phoneCountryCode: settings.phoneCountryCode,
    createdAt: settings.createdAt.toISOString(),
  };
}
