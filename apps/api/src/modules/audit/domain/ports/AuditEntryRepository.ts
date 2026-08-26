import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { AuditEntry } from '../AuditEntry.js';
import type { AuditEntryId } from '../value-objects/AuditEntryId.js';

/**
 * Port de persistance `AuditEntry` — UNIQUEMENT `append()` et `findById()` (ADR-0005 §5). Aucune
 * methode `update`/`delete`/`list` dans ce contrat : c'est ce qui rend le contrat LUI-MEME
 * append-only, independamment des contraintes SQL (`REVOKE UPDATE, DELETE` + trigger, voir la
 * migration correspondante) — deux defenses independantes, jamais une seule.
 *
 * `findById` prend un `tenantId` OBLIGATOIRE (correctif securite, revue independante F-6) :
 * `platform.AuditEntry` est HORS RLS (`tenant_id` NULLABLE, ADR-0005 §5) — sans ce parametre,
 * `findById(id)` seul aurait pu renvoyer la ligne d'un AUTRE tenant que celui de l'appelant, le
 * seul filtrage possible sur cette table etant PUREMENT APPLICATIF (jamais garanti par le
 * moteur). `tenantId: null` est une valeur EXPLICITE et LEGITIME (lecture au niveau PLATEFORME,
 * ex. console Super Admin, etape 11/13) — l'implementation DOIT alors filtrer sur
 * `tenant_id IS NULL`, jamais ignorer purement et simplement le filtre. Voir
 * `auditEntryTenantIsolation.test.ts` pour la demonstration complete de l'absence de RLS sur
 * cette table et la necessite de ce filtrage applicatif.
 */
export interface AuditEntryRepository {
  append(entry: AuditEntry): Promise<void>;
  findById(id: AuditEntryId, tenantId: TenantId | null): Promise<AuditEntry | null>;
}
