import { Result } from '../../../../shared-kernel/domain/Result.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { AuditEntryRepository } from '../../domain/ports/AuditEntryRepository.js';
import type { AuditEntryFilter } from '../../domain/AuditEntryFilter.js';
import { AUDIT_PAGE_DEFAULT_LIMIT, AUDIT_PAGE_MAX_LIMIT, type AuditEntryPage } from '../../domain/AuditPage.js';
import type { PlatformAuditScope } from '../../domain/PlatformAuditScope.js';
import { decodeAuditEntryCursor } from '../../domain/AuditEntryCursor.js';
import type { AuditReadPrincipal } from '../AuditReadPrincipal.js';
import { authorizeAuditRead } from '../AuthorizeAuditRead.js';

/** `null` = aucun parametre de perimetre envoye par le client. */
export type ListAuditEntriesRequestedScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'PLATFORM_ONLY' }
  | { readonly kind: 'TENANT'; readonly tenantId: string };

export interface ListAuditEntriesQuery {
  readonly filter: AuditEntryFilter;
  readonly cursor: string | null;
  readonly limit: number;
  /**
   * Perimetre demande par le client, TEL QUEL — y compris pour un principal `TENANT` (le handler
   * DOIT le rejeter explicitement, jamais l'ignorer silencieusement, §8.5). `null` = aucun
   * parametre `scope`/`tenantId` dans la requete.
   */
  readonly requestedScope: ListAuditEntriesRequestedScope | null;
}

export type ListAuditEntriesError = 'FORBIDDEN' | 'INVALID_QUERY';

/**
 * Query handler PUR (aucun effet de bord — §6.1, §7 de l'ADR) : la trace de consultation est
 * produite par la commande DISTINCTE `RecordAuditAccess`, invoquee par la couche de presentation
 * AVANT cet appel (voir `composition-root.ts`/le controleur HTTP) — jamais ici.
 *
 * `audit` n'importe JAMAIS `ServerContext` : `principal` est un `AuditReadPrincipal`, type
 * POSSEDE par ce module (voir AuditReadPrincipal.ts).
 */
export class ListAuditEntriesHandler {
  constructor(private readonly repository: AuditEntryRepository) {}

  async execute(principal: AuditReadPrincipal, query: ListAuditEntriesQuery): Promise<Result<AuditEntryPage, ListAuditEntriesError>> {
    if (query.limit < 1 || query.limit > AUDIT_PAGE_MAX_LIMIT) {
      return Result.failure('INVALID_QUERY');
    }

    let cursor: { occurredAt: Date; id: string } | null = null;
    if (query.cursor !== null) {
      const decoded = decodeAuditEntryCursor(query.cursor);
      if (decoded === null) {
        return Result.failure('INVALID_QUERY');
      }
      cursor = { occurredAt: new Date(decoded.occurredAt), id: decoded.id };
    }

    const page = { cursor, limit: query.limit };

    // Defense en profondeur (§7.3 du system prompt) : `authorizeAuditRead` est la SOURCE UNIQUE
    // de cette regle, appelee AUSSI par la couche de presentation avant `RecordAuditAccess` —
    // jamais une confiance aveugle dans le fait que l'appelant a deja verifie.
    const authorization = authorizeAuditRead(principal, query.requestedScope);
    if (authorization.isFailure()) {
      // Collapse volontaire vers UNE SEULE valeur, quelle que soit la sous-cause (§10 de l'ADR
      // exige exactement `Result.failure('FORBIDDEN')` a ce niveau) — la distinction HTTP
      // 400/403 est la responsabilite du controleur (voir AuthorizeAuditRead.ts).
      return Result.failure('FORBIDDEN');
    }

    if (principal.kind === 'TENANT') {
      const tenantIdResult = TenantId.create(principal.tenantId);
      if (tenantIdResult.isFailure()) {
        // Un AuditReadPrincipal TENANT est toujours construit par composition-root.ts a partir
        // d'un ServerContext deja valide — un tenantId invalide ici trahit un bug appelant.
        throw new Error(`ListAuditEntriesHandler : AuditReadPrincipal.tenantId invalide ("${principal.tenantId}").`);
      }
      const resultPage = await this.repository.listForTenant(tenantIdResult.getValue(), query.filter, page);
      return Result.success(resultPage);
    }

    // PLATFORM — seul principal autorise a fournir un `requestedScope` (§8). Absence de
    // parametre => perimetre le plus large (`ALL`), choix delibere : un SUPER_ADMIN qui
    // n'exprime aucun filtre de perimetre voit tout, coherent avec l'objectif de supervision.
    const requested = query.requestedScope ?? { kind: 'ALL' as const };
    let scope: PlatformAuditScope;
    switch (requested.kind) {
      case 'ALL':
        scope = { kind: 'ALL' };
        break;
      case 'PLATFORM_ONLY':
        scope = { kind: 'PLATFORM_ONLY' };
        break;
      case 'TENANT': {
        const tenantIdResult = TenantId.create(requested.tenantId);
        if (tenantIdResult.isFailure()) {
          return Result.failure('INVALID_QUERY');
        }
        // PLATFORM -> tenant ARBITRAIRE (decision complementaire validee par le responsable
        // technique) : supervision SUPER_ADMIN, aucun controle d'appartenance supplementaire.
        scope = { kind: 'TENANT', tenantId: tenantIdResult.getValue() };
        break;
      }
      default: {
        const exhaustiveCheck: never = requested;
        throw new Error(`ListAuditEntriesRequestedScope non gere : ${JSON.stringify(exhaustiveCheck)}`);
      }
    }

    const resultPage = await this.repository.listForPlatform(scope, query.filter, page);
    return Result.success(resultPage);
  }
}

export { AUDIT_PAGE_DEFAULT_LIMIT };
