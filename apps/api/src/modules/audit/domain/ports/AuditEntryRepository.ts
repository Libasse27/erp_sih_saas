import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { AuditEntry } from '../AuditEntry.js';
import type { AuditEntryId } from '../value-objects/AuditEntryId.js';
import type { AuditChainKey } from '../value-objects/AuditChainKey.js';
import type { AuditEntryFilter } from '../AuditEntryFilter.js';
import type { AuditEntryPage, AuditPageRequest } from '../AuditPage.js';
import type { PlatformAuditScope } from '../PlatformAuditScope.js';

/**
 * Port de persistance `AuditEntry` (ADR-0005 §5, etendu ADR-0009 §6). `append()` reste la SEULE
 * methode d'ECRITURE — aucune methode `update`/`delete`, a AUCUN niveau : c'est ce qui rend le
 * contrat LUI-MEME append-only, independamment des contraintes SQL (deux defenses independantes).
 *
 * `findById` prend un `tenantId` OBLIGATOIRE (correctif securite F-6, ADR-0005 §5) — inchange.
 *
 * ADR-0009 §6 — trois methodes de LECTURE supplementaires, AUCUN `tenantId` optionnel nulle part :
 *   - `listForTenant` : `tenantId` POSITIONNEL et OBLIGATOIRE, jamais un champ de `filter`
 *     (alternative ecartee #4 — un filtre optionnel est precisement le mecanisme par lequel une
 *     fuite inter-tenant arrive : ici, l'oublier ne compile pas) ;
 *   - `listForPlatform` : SEULE methode autorisee a traverser les tenants, perimetre
 *     `PlatformAuditScope` obligatoire (voir ce fichier) ;
 *   - `readChainSegment` : lecture par lots bornes d'UNE chaine, utilisee par
 *     `VerifyAuditChainIntegrity` — soumise au MEME perimetre d'isolation que la lecture (§5.4).
 * Pagination par curseur `keyset` UNIQUEMENT — jamais `OFFSET` (§6).
 */
export interface AuditEntryRepository {
  append(entry: AuditEntry): Promise<void>;
  findById(id: AuditEntryId, tenantId: TenantId | null): Promise<AuditEntry | null>;
  listForTenant(tenantId: TenantId, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage>;
  listForPlatform(scope: PlatformAuditScope, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage>;
  readChainSegment(chain: AuditChainKey, fromSequence: number, limit: number): Promise<readonly AuditEntry[]>;
  /**
   * Compte les entrees "pre-chaine" (`entry_hash IS NULL`, ecrites avant la migration de
   * chainage) de ce perimetre — METHODE DE LECTURE (aucune mutation), necessaire au
   * `VerifyAuditChainIntegrityHandler` pour les COMPTER et les SIGNALER explicitement, jamais les
   * ignorer en silence (ADR-0009 §5.3/§5.4). Ces lignes sont structurellement invisibles a
   * `readChainSegment` (leur `chain_sequence` est NULL, jamais `>= fromSequence`).
   */
  countUnchained(chain: AuditChainKey): Promise<number>;
}
