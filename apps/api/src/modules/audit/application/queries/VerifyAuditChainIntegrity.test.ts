import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { AuditEntry } from '../../domain/AuditEntry.js';
import { AuditEntryId } from '../../domain/value-objects/AuditEntryId.js';
import type { AuditChainKey } from '../../domain/value-objects/AuditChainKey.js';
import type { AuditEntryRepository } from '../../domain/ports/AuditEntryRepository.js';
import type { AuditEntryHasher } from '../../domain/ports/AuditEntryHasher.js';
import type { AuditEntryPage } from '../../domain/AuditPage.js';
import { buildAuditEntryCanonicalPayload } from '../../domain/AuditEntryCanonicalPayload.js';
import type { AuditReadPrincipal } from '../AuditReadPrincipal.js';
import { VerifyAuditChainIntegrityHandler } from './VerifyAuditChainIntegrity.js';

function uuidAt(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

const TENANT_A = uuidAt(1);
const TENANT_B = uuidAt(2);

/**
 * Hacheur factice DETERMINISTE (pas de SHA-256 reel — le comportement du hacheur reel est teste
 * ailleurs) : renvoie la charge canonique elle-meme, prefixee, pour rester trivialement
 * previsible dans les assertions de ce fichier.
 */
class FixedAuditEntryHasher implements AuditEntryHasher {
  hash(canonicalPayload: string): string {
    return `fake-hash:${canonicalPayload}`;
  }
}

/**
 * Fake du port `AuditEntryRepository` — seules `readChainSegment`/`countUnchained` sont exercees
 * par `VerifyAuditChainIntegrityHandler` (query PURE, aucune ecriture). `segmentBatchSize` permet
 * de forcer PLUSIEURS appels a `readChainSegment` (boucle de lots) sans construire des centaines
 * d'entrees (deja couvert par le test d'integration reel, `test/audit/integration/
 * auditChainIntegrity.test.ts`, qui, lui, prouve le comportement avec un plafond HTTP de 200).
 */
class FakeChainRepository implements AuditEntryRepository {
  public readonly readChainSegmentCalls: number[] = [];

  constructor(
    private readonly entries: readonly AuditEntry[],
    private readonly preChainCount: number = 0,
    private readonly segmentBatchSize: number = 500,
  ) {}

  async append(): Promise<void> {
    throw new Error('append() non exerce par VerifyAuditChainIntegrityHandler.');
  }

  async findById(): Promise<AuditEntry | null> {
    throw new Error('findById() non exerce par VerifyAuditChainIntegrityHandler.');
  }

  async listForTenant(): Promise<AuditEntryPage> {
    throw new Error('listForTenant() non exerce par VerifyAuditChainIntegrityHandler.');
  }

  async listForPlatform(): Promise<AuditEntryPage> {
    throw new Error('listForPlatform() non exerce par VerifyAuditChainIntegrityHandler.');
  }

  async readChainSegment(_chain: AuditChainKey, fromSequence: number, limit: number): Promise<readonly AuditEntry[]> {
    this.readChainSegmentCalls.push(fromSequence);
    const matching = this.entries
      .filter((entry) => (entry.chainSequence ?? -1) >= fromSequence)
      .sort((a, b) => (a.chainSequence ?? 0) - (b.chainSequence ?? 0));
    const effectiveLimit = Math.min(limit, this.segmentBatchSize);
    return matching.slice(0, effectiveLimit);
  }

  async countUnchained(): Promise<number> {
    return this.preChainCount;
  }
}

function buildEntry(params: {
  idCounter: number;
  tenantId: string | null;
  chainKey: string;
  chainSequence: number;
  previousEntryHash: string | null;
  hasher: AuditEntryHasher;
  tamperedEntryHash?: string;
}): AuditEntry {
  const id = AuditEntryId.create(uuidAt(params.idCounter)).getValue();
  const occurredAt = new Date('2026-08-24T10:00:00.000Z');
  const subjectUserId = uuidAt(9000 + params.idCounter);
  const canonicalPayload = buildAuditEntryCanonicalPayload({
    id: id.toString(),
    chainKey: params.chainKey,
    chainSequence: params.chainSequence,
    previousEntryHash: params.previousEntryHash,
    category: 'MFA',
    eventType: 'MFA_CHALLENGE_SUCCEEDED',
    outcome: 'SUCCESS',
    tenantId: params.tenantId,
    actorKind: 'USER_TENANT',
    actorUserId: subjectUserId,
    actorRoleCodes: [],
    subjectUserId,
    targetType: 'USER_ACCOUNT',
    targetId: subjectUserId,
    reason: null,
    sessionRef: null,
    correlationId: null,
    occurredAt,
  });
  const entryHash = params.tamperedEntryHash ?? params.hasher.hash(canonicalPayload);
  return AuditEntry.reconstitute(id, {
    category: 'MFA',
    eventType: 'MFA_CHALLENGE_SUCCEEDED',
    outcome: 'SUCCESS',
    tenantId: params.tenantId,
    actorKind: 'USER_TENANT',
    actorUserId: subjectUserId,
    actorRoleCodes: [],
    subjectUserId,
    targetType: 'USER_ACCOUNT',
    targetId: subjectUserId,
    reason: null,
    sessionRef: null,
    correlationId: null,
    occurredAt,
    chainSequence: params.chainSequence,
    previousEntryHash: params.previousEntryHash,
    entryHash,
  });
}

/** Clone une entree en forcant `chainSequence` a `null` — simule une ligne "pre-chaine" que `readChainSegment` ne devrait structurellement jamais renvoyer (voir le test dedie a cette incoherence). */
function withNullChainSequence(entry: AuditEntry): AuditEntry {
  return AuditEntry.reconstitute(entry.id, {
    category: entry.category,
    eventType: entry.eventType,
    outcome: entry.outcome,
    tenantId: entry.tenantId,
    actorKind: entry.actorKind,
    actorUserId: entry.actorUserId,
    actorRoleCodes: entry.actorRoleCodes,
    subjectUserId: entry.subjectUserId,
    targetType: entry.targetType,
    targetId: entry.targetId,
    reason: entry.reason,
    sessionRef: entry.sessionRef,
    correlationId: entry.correlationId,
    occurredAt: entry.occurredAt,
    chainSequence: null,
    previousEntryHash: entry.previousEntryHash,
    entryHash: entry.entryHash,
  });
}

const TENANT_PRINCIPAL: AuditReadPrincipal = {
  kind: 'TENANT',
  actorUserId: uuidAt(3),
  tenantId: TENANT_A,
  roleCodes: [],
  permissionCodes: ['audit:read'],
};

const PLATFORM_PRINCIPAL: AuditReadPrincipal = { kind: 'PLATFORM', actorUserId: uuidAt(4) };

function handler(repository: AuditEntryRepository, hasher: AuditEntryHasher): VerifyAuditChainIntegrityHandler {
  return new VerifyAuditChainIntegrityHandler(repository, hasher);
}

describe('VerifyAuditChainIntegrityHandler', () => {
  it('principal TENANT demandant la chaine PLATFORM est rejete (FORBIDDEN)', async () => {
    const result = await handler(new FakeChainRepository([]), new FixedAuditEntryHasher()).execute(TENANT_PRINCIPAL, {
      kind: 'PLATFORM',
    });

    expect(result.isFailure() && result.getError()).toBe('FORBIDDEN');
  });

  it('principal TENANT demandant la chaine d_un AUTRE tenant est rejete (FORBIDDEN)', async () => {
    const result = await handler(new FakeChainRepository([]), new FixedAuditEntryHasher()).execute(TENANT_PRINCIPAL, {
      kind: 'TENANT',
      tenantId: TENANT_B,
    });

    expect(result.isFailure() && result.getError()).toBe('FORBIDDEN');
  });

  it('principal TENANT avec un tenantId corrompu declenche une erreur technique', async () => {
    const principalCorrompu: AuditReadPrincipal = { ...TENANT_PRINCIPAL, tenantId: 'pas-un-uuid' };

    await expect(
      handler(new FakeChainRepository([]), new FixedAuditEntryHasher()).execute(principalCorrompu, {
        kind: 'TENANT',
        tenantId: 'pas-un-uuid',
      }),
    ).rejects.toThrow(/tenantId invalide/);
  });

  it('principal TENANT verifiant SA PROPRE chaine, vide : succes trivial', async () => {
    const result = await handler(new FakeChainRepository([]), new FixedAuditEntryHasher()).execute(TENANT_PRINCIPAL, {
      kind: 'TENANT',
      tenantId: TENANT_A,
    });

    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.chainKey).toBe(TenantId.create(TENANT_A).getValue().toString());
    expect(value.verifiedCount).toBe(0);
    expect(value.preChainCount).toBe(0);
    expect(value.firstBrokenSequence).toBeNull();
  });

  it('principal PLATFORM verifiant la chaine PLATFORM elle-meme (jamais un tenant) : succes trivial', async () => {
    const result = await handler(new FakeChainRepository([]), new FixedAuditEntryHasher()).execute(
      PLATFORM_PRINCIPAL,
      { kind: 'PLATFORM' },
    );

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().chainKey).toBe('PLATFORM');
  });

  it('principal PLATFORM demandant un tenant ARBITRAIRE avec un tenantId invalide -> INVALID_QUERY', async () => {
    const result = await handler(new FakeChainRepository([]), new FixedAuditEntryHasher()).execute(
      PLATFORM_PRINCIPAL,
      { kind: 'TENANT', tenantId: 'pas-un-uuid' },
    );

    expect(result.isFailure() && result.getError()).toBe('INVALID_QUERY');
  });

  it('chaine intacte de plusieurs lots (readChainSegment appele plusieurs fois) : verifiedCount cumule, aucune rupture', async () => {
    const hasher = new FixedAuditEntryHasher();
    const chainKey = TenantId.create(TENANT_A).getValue().toString();
    const entry0 = buildEntry({ idCounter: 10, tenantId: TENANT_A, chainKey, chainSequence: 0, previousEntryHash: null, hasher });
    const entry1 = buildEntry({ idCounter: 11, tenantId: TENANT_A, chainKey, chainSequence: 1, previousEntryHash: entry0.entryHash, hasher });
    const entry2 = buildEntry({ idCounter: 12, tenantId: TENANT_A, chainKey, chainSequence: 2, previousEntryHash: entry1.entryHash, hasher });
    const entry3 = buildEntry({ idCounter: 13, tenantId: TENANT_A, chainKey, chainSequence: 3, previousEntryHash: entry2.entryHash, hasher });
    const repository = new FakeChainRepository([entry0, entry1, entry2, entry3], 2, 2);

    const result = await handler(repository, hasher).execute(PLATFORM_PRINCIPAL, { kind: 'TENANT', tenantId: TENANT_A });

    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.verifiedCount).toBe(4);
    expect(value.preChainCount).toBe(2);
    expect(value.firstBrokenSequence).toBeNull();
    expect(repository.readChainSegmentCalls).toEqual([0, 2, 4]);
  });

  it('rupture de chainage (previousEntryHash incoherent) : firstBrokenSequence pointe l_entree fautive, verification interrompue', async () => {
    const hasher = new FixedAuditEntryHasher();
    const chainKey = TenantId.create(TENANT_A).getValue().toString();
    const entry0 = buildEntry({ idCounter: 20, tenantId: TENANT_A, chainKey, chainSequence: 0, previousEntryHash: null, hasher });
    const entry1 = buildEntry({ idCounter: 21, tenantId: TENANT_A, chainKey, chainSequence: 1, previousEntryHash: 'hash-incoherent', hasher });
    const repository = new FakeChainRepository([entry0, entry1]);

    const result = await handler(repository, hasher).execute(PLATFORM_PRINCIPAL, { kind: 'TENANT', tenantId: TENANT_A });

    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.verifiedCount).toBe(1);
    expect(value.firstBrokenSequence).toBe(1);
  });

  it('alteration du contenu (entryHash stocke ne correspond plus a la charge canonique recalculee) : firstBrokenSequence pointe l_entree alteree', async () => {
    const hasher = new FixedAuditEntryHasher();
    const chainKey = TenantId.create(TENANT_A).getValue().toString();
    const entry0 = buildEntry({ idCounter: 30, tenantId: TENANT_A, chainKey, chainSequence: 0, previousEntryHash: null, hasher });
    const entry1 = buildEntry({
      idCounter: 31,
      tenantId: TENANT_A,
      chainKey,
      chainSequence: 1,
      previousEntryHash: entry0.entryHash,
      hasher,
      tamperedEntryHash: 'hash-fabrique-de-toutes-pieces',
    });
    const repository = new FakeChainRepository([entry0, entry1]);

    const result = await handler(repository, hasher).execute(PLATFORM_PRINCIPAL, { kind: 'TENANT', tenantId: TENANT_A });

    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.verifiedCount).toBe(1);
    expect(value.firstBrokenSequence).toBe(1);
  });

  it('incoherence repository (entree sans chainSequence renvoyee par readChainSegment) : erreur technique, jamais avalee', async () => {
    const hasher = new FixedAuditEntryHasher();
    const chainKey = TenantId.create(TENANT_A).getValue().toString();
    const malformed = buildEntry({ idCounter: 40, tenantId: TENANT_A, chainKey, chainSequence: 0, previousEntryHash: null, hasher });
    const repository = new FakeChainRepository([malformed]);
    // Contourne le filtre du fake (qui exclurait structurellement, comme le repository REEL, une
    // ligne `chainSequence` NULL) en substituant directement `readChainSegment` pour ce seul test :
    // seule maniere de simuler cette incoherence, jamais atteignable via `execute()` en conditions
    // normales.
    repository.readChainSegment = async () => [withNullChainSequence(malformed)];

    await expect(
      handler(repository, hasher).execute(PLATFORM_PRINCIPAL, { kind: 'TENANT', tenantId: TENANT_A }),
    ).rejects.toThrow(/sans chainSequence/);
  });
});
