import type { TenantAdminRecoveryRequest } from '../TenantAdminRecoveryRequest.js';
import type { TenantAdminRecoveryRequestId } from '../value-objects/TenantAdminRecoveryRequestId.js';

/** Persistance de la preuve de demande/approbation, plateforme et hors RLS tenant. */
export interface TenantAdminRecoveryRequestRepository {
  /** Création = true ; transition atomique PENDING → APPROVED = false si un autre approbateur a gagné. */
  save(request: TenantAdminRecoveryRequest): Promise<boolean>;
  findById(id: TenantAdminRecoveryRequestId): Promise<TenantAdminRecoveryRequest | null>;
}
