import { z } from 'zod';
import { MEMBERSHIP_STATUSES } from '../../domain/value-objects/MembershipStatus.js';

/**
 * `GET /api/v1/memberships` — Phase 1, deuxieme increment vertical (permission
 * `membership:administer`). `.strict()` — rejet des champs inconnus (anti mass-assignment, regle
 * §7.3) : `tenantId` n'est accepte D'AUCUNE MANIERE, jamais silencieusement (le tenant cible est
 * TOUJOURS derive du `ServerContext` serveur, jamais du client — meme discipline que
 * `FacilitySchemas.ts`, module `tenant`). `limit` borne 1..200 — MEME CONVENTION que
 * `ListAuditEntriesQuerySchema.ts` (module `audit`) : un depassement est un REJET explicite
 * (`400`), jamais un plafonnement silencieux (§6).
 */
export const ListTenantMembershipsQuerySchema = z
  .object({
    status: z.enum(MEMBERSHIP_STATUSES).optional(),
    cursor: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type ListTenantMembershipsQueryInput = z.infer<typeof ListTenantMembershipsQuerySchema>;
