import { describe, expect, it } from 'vitest';
import { Result } from '../../../../shared-kernel/domain/Result.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { AuditEntry } from '../../domain/AuditEntry.js';
import type { AuditEntryRepository } from '../../domain/ports/AuditEntryRepository.js';
import type { AuditEntryFilter } from '../../domain/AuditEntryFilter.js';
import { AUDIT_PAGE_MAX_LIMIT, type AuditEntryPage, type AuditPageRequest } from '../../domain/AuditPage.js';
import type { PlatformAuditScope } from '../../domain/PlatformAuditScope.js';
import { encodeAuditEntryCursor } from '../../domain/AuditEntryCursor.js';
import type { AuditReadPrincipal } from '../AuditReadPrincipal.js';
import { ListAuditEntriesHandler, type ListAuditEntriesQuery, type ListAuditEntriesRequestedScope } from './ListAuditEntries.js';

function uuidAt(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

const TENANT_A = uuidAt(1);

/**
 * Fake du port `AuditEntryRepository` — aucun testKit partage n'existe encore pour ce module au
 * niveau `application/` (seuls des helpers d'integration reels existent sous `test/audit/
 * integration/`) : ce double minimal, local a ce fichier, se contente d'enregistrer les appels
 * recus par les DEUX methodes exercees par `ListAuditEntriesHandler` (`listForTenant`/
 * `listForPlatform`) — les autres methodes du port ne sont jamais invoquees par ce handler PUR
 * (aucun effet de bord, voir le commentaire de tete de ListAuditEntries.ts).
 */
class FakeAuditEntryRepository implements AuditEntryRepository {
  public listForTenantCalls: Array<{ tenantId: TenantId; filter: AuditEntryFilter; page: AuditPageRequest }> = [];
  public listForPlatformCalls: Array<{ scope: PlatformAuditScope; filter: AuditEntryFilter; page: AuditPageRequest }> = [];
  public pageToReturn: AuditEntryPage = { entries: [], nextCursor: null };

  async append(): Promise<void> {
    throw new Error('append() non exerce par ListAuditEntriesHandler (query PURE).');
  }

  async findById(): Promise<AuditEntry | null> {
    throw new Error('findById() non exerce par ListAuditEntriesHandler.');
  }

  async listForTenant(tenantId: TenantId, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage> {
    this.listForTenantCalls.push({ tenantId, filter, page });
    return this.pageToReturn;
  }

  async listForPlatform(scope: PlatformAuditScope, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage> {
    this.listForPlatformCalls.push({ scope, filter, page });
    return this.pageToReturn;
  }

  async readChainSegment(): Promise<readonly AuditEntry[]> {
    throw new Error('readChainSegment() non exerce par ListAuditEntriesHandler.');
  }

  async countUnchained(): Promise<number> {
    throw new Error('countUnchained() non exerce par ListAuditEntriesHandler.');
  }
}

function mustSucceed<T, E>(result: Result<T, E>): T {
  if (result.isFailure()) {
    throw new Error(`Resultat attendu en succes, obtenu en echec : ${JSON.stringify(result.getError())}`);
  }
  return result.getValue();
}

function mustFail<T, E>(result: Result<T, E>): E {
  if (result.isSuccess()) {
    throw new Error('Resultat attendu en echec, obtenu en succes.');
  }
  return result.getError();
}

function baseQuery(overrides: Partial<ListAuditEntriesQuery> = {}): ListAuditEntriesQuery {
  return {
    filter: {},
    cursor: null,
    limit: 50,
    requestedScope: null,
    ...overrides,
  };
}

const TENANT_PRINCIPAL: AuditReadPrincipal = {
  kind: 'TENANT',
  actorUserId: uuidAt(2),
  tenantId: TENANT_A,
  roleCodes: ['ADMIN_ETABLISSEMENT'],
  permissionCodes: ['audit:read'],
};

const PLATFORM_PRINCIPAL: AuditReadPrincipal = {
  kind: 'PLATFORM',
  actorUserId: uuidAt(3),
};

describe('ListAuditEntriesHandler', () => {
  it('rejette un limit hors bornes (0) avec INVALID_QUERY', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(TENANT_PRINCIPAL, baseQuery({ limit: 0 }));

    expect(mustFail(result)).toBe('INVALID_QUERY');
  });

  it('rejette un limit superieur au plafond avec INVALID_QUERY', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(TENANT_PRINCIPAL, baseQuery({ limit: AUDIT_PAGE_MAX_LIMIT + 1 }));

    expect(mustFail(result)).toBe('INVALID_QUERY');
  });

  it('rejette un curseur malforme avec INVALID_QUERY', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(TENANT_PRINCIPAL, baseQuery({ cursor: 'pas-un-curseur-valide' }));

    expect(mustFail(result)).toBe('INVALID_QUERY');
  });

  it('decode un curseur valide et le transmet au repository', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);
    const cursor = encodeAuditEntryCursor({ occurredAt: '2026-08-24T10:00:00.000Z', id: uuidAt(9) });

    const result = await handler.execute(TENANT_PRINCIPAL, baseQuery({ cursor }));

    expect(mustSucceed(result)).toEqual({ entries: [], nextCursor: null });
    expect(repository.listForTenantCalls[0]?.page.cursor).toEqual({
      occurredAt: new Date('2026-08-24T10:00:00.000Z'),
      id: uuidAt(9),
    });
  });

  it('principal TENANT avec un requestedScope non nul est rejete (FORBIDDEN, defense en profondeur §7.3)', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(TENANT_PRINCIPAL, baseQuery({ requestedScope: { kind: 'ALL' } }));

    expect(mustFail(result)).toBe('FORBIDDEN');
  });

  it('principal TENANT sans la permission audit:read est rejete (FORBIDDEN)', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);
    const principalSansPermission: AuditReadPrincipal = { ...TENANT_PRINCIPAL, permissionCodes: [] };

    const result = await handler.execute(principalSansPermission, baseQuery());

    expect(mustFail(result)).toBe('FORBIDDEN');
  });

  it('principal TENANT avec un tenantId corrompu declenche une erreur technique (bug appelant, jamais un Result)', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);
    const principalCorrompu: AuditReadPrincipal = { ...TENANT_PRINCIPAL, tenantId: 'pas-un-uuid' };

    await expect(handler.execute(principalCorrompu, baseQuery())).rejects.toThrow(/tenantId invalide/);
  });

  it('cas nominal TENANT : delegue a listForTenant avec le tenantId du principal', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);
    const filter: AuditEntryFilter = { targetType: 'PAYMENT' };

    const result = await handler.execute(TENANT_PRINCIPAL, baseQuery({ filter, limit: 25 }));

    expect(mustSucceed(result)).toEqual({ entries: [], nextCursor: null });
    expect(repository.listForTenantCalls).toHaveLength(1);
    expect(repository.listForTenantCalls[0]?.tenantId.equals(TenantId.create(TENANT_A).getValue())).toBe(true);
    expect(repository.listForTenantCalls[0]?.filter).toBe(filter);
    expect(repository.listForTenantCalls[0]?.page.limit).toBe(25);
    expect(repository.listForPlatformCalls).toHaveLength(0);
  });

  it('cas nominal PLATFORM sans requestedScope : perimetre par defaut ALL', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(PLATFORM_PRINCIPAL, baseQuery());

    expect(mustSucceed(result)).toEqual({ entries: [], nextCursor: null });
    expect(repository.listForPlatformCalls[0]?.scope).toEqual({ kind: 'ALL' });
  });

  it('cas nominal PLATFORM avec requestedScope PLATFORM_ONLY', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(PLATFORM_PRINCIPAL, baseQuery({ requestedScope: { kind: 'PLATFORM_ONLY' } }));

    expect(mustSucceed(result)).toEqual({ entries: [], nextCursor: null });
    expect(repository.listForPlatformCalls[0]?.scope).toEqual({ kind: 'PLATFORM_ONLY' });
  });

  it('cas nominal PLATFORM avec requestedScope TENANT (tenant arbitraire, supervision SUPER_ADMIN)', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);
    const targetTenant = uuidAt(42);

    const result = await handler.execute(
      PLATFORM_PRINCIPAL,
      baseQuery({ requestedScope: { kind: 'TENANT', tenantId: targetTenant } }),
    );

    expect(mustSucceed(result)).toEqual({ entries: [], nextCursor: null });
    const scope = repository.listForPlatformCalls[0]?.scope;
    expect(scope?.kind).toBe('TENANT');
    expect(scope?.kind === 'TENANT' && scope.tenantId.equals(TenantId.create(targetTenant).getValue())).toBe(true);
  });

  it('PLATFORM avec requestedScope TENANT et un tenantId invalide -> INVALID_QUERY', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);

    const result = await handler.execute(
      PLATFORM_PRINCIPAL,
      baseQuery({ requestedScope: { kind: 'TENANT', tenantId: 'pas-un-uuid' } }),
    );

    expect(mustFail(result)).toBe('INVALID_QUERY');
  });

  it('requestedScope avec un discriminant inconnu declenche la garde d_exhaustivite (bug appelant)', async () => {
    const repository = new FakeAuditEntryRepository();
    const handler = new ListAuditEntriesHandler(repository);
    const scopeInconnu = { kind: 'BOGUS' } as unknown as ListAuditEntriesRequestedScope;

    await expect(handler.execute(PLATFORM_PRINCIPAL, baseQuery({ requestedScope: scopeInconnu }))).rejects.toThrow(
      /non gere/,
    );
  });
});
