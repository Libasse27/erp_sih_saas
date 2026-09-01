import type { Prisma, PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { AuditEntry } from '../../domain/AuditEntry.js';
import type { AuditEntryRepository } from '../../domain/ports/AuditEntryRepository.js';
import { AuditEntryId } from '../../domain/value-objects/AuditEntryId.js';
import type { AuditCategory } from '../../domain/value-objects/AuditCategory.js';
import type { AuditEventType } from '../../domain/value-objects/AuditEventType.js';
import type { AuditOutcome } from '../../domain/value-objects/AuditOutcome.js';
import type { ActorKind } from '../../domain/value-objects/ActorKind.js';
import type { AuditTargetType } from '../../domain/value-objects/AuditTargetType.js';
import { AuditChainKey } from '../../domain/value-objects/AuditChainKey.js';
import type { AuditEntryFilter } from '../../domain/AuditEntryFilter.js';
import { AUDIT_PAGE_MAX_LIMIT, type AuditEntryPage, type AuditPageRequest } from '../../domain/AuditPage.js';
import { encodeAuditEntryCursor } from '../../domain/AuditEntryCursor.js';
import type { PlatformAuditScope } from '../../domain/PlatformAuditScope.js';
import { buildAuditEntryCanonicalPayload } from '../../domain/AuditEntryCanonicalPayload.js';
import type { AuditEntryHasher } from '../../domain/ports/AuditEntryHasher.js';

/**
 * Borne de securite DEDIEE a la lecture par lots de `readChainSegment` (§5.4) — DISTINCTE de
 * `AUDIT_PAGE_MAX_LIMIT` (200, pagination HTTP, §6). Deux preoccupations sans rapport : la
 * confondre a plafonne silencieusement `VerifyAuditChainIntegrityHandler` a son premier lot
 * (correctif securite 2026-09-01, voir `readChainSegment` ci-dessous). Valeur choisie assez
 * large pour ne jamais contraindre `CHAIN_SEGMENT_BATCH_SIZE` (500,
 * `VerifyAuditChainIntegrity.ts`) — ce n'est PAS une decision d'ADR, seulement un garde-fou anti-
 * abus sur l'argument `limit`.
 */
const AUDIT_CHAIN_SEGMENT_HARD_LIMIT = 1000;

interface AuditEntryRow {
  id: string;
  category: string;
  eventType: string;
  outcome: string;
  tenantId: string | null;
  actorKind: string;
  actorUserId: string | null;
  actorRoleCodes: string[];
  subjectUserId: string | null;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  /** Colonne SQL `session_id` INCHANGEE (ADR-0009 §3.1) — porte desormais `sessionRef`, jamais le `sessionId` brut ; nom de champ Prisma impose par `schema.prisma` (`@map("session_id")`). */
  sessionId: string | null;
  correlationId: string | null;
  occurredAt: Date;
  chainSequence: bigint | null;
  previousEntryHash: string | null;
  entryHash: string | null;
}

/**
 * Repository `AuditEntry` — table `platform.AuditEntry`, HORS RLS (ADR-0005 §5, filtrage tenant
 * PUREMENT APPLICATIF). Etendu ADR-0009 §5/§6 (etape 11/13) : chainage SHA-256 a l'ecriture,
 * methodes de LECTURE (`listForTenant`/`listForPlatform`/`readChainSegment`), toujours AUCUNE
 * methode de mutation au-dela de `append()` (create() uniquement, jamais update/upsert/delete).
 */
export class PrismaAuditEntryRepository implements AuditEntryRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hasher: AuditEntryHasher,
  ) {}

  /**
   * Ecrit l'entree ET calcule sa position/empreinte de chaine (ADR-0009 §5) — DOIT s'executer
   * dans une transaction REELLE (`unitOfWork.withTransaction`, jamais un appel isole) : le verrou
   * consultatif `pg_advisory_xact_lock` n'a de sens que porte par une transaction explicite
   * (libere au COMMIT/ROLLBACK), et la lecture de la queue + l'INSERT doivent voir un etat
   * COHERENT de la chaine (deux defenses independantes contre la fourche, §5.3 — le verrou EST la
   * premiere, les deux index UNIQUES partiels de la migration sont la seconde).
   */
  async append(entry: AuditEntry): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    const chainKey = entry.chainKey.toString();

    // Verrou consultatif de TRANSACTION, portee au chain_key (ADR-0009 §5.3) — pris AVANT la
    // lecture de la queue : deux ecritures concurrentes sur la MEME chaine se serialisent au lieu
    // de forker. `hashtext(text)` renvoie un int4, promu implicitement en bigint (seule surcharge
    // a un argument de `pg_advisory_xact_lock`).
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${chainKey}))`;

    const tail = await client.auditEntry.findFirst({
      where: { chainKey, entryHash: { not: null } },
      orderBy: { chainSequence: 'desc' },
      select: { chainSequence: true, entryHash: true },
    });

    const chainSequence = tail === null || tail.chainSequence === null ? 0 : Number(tail.chainSequence) + 1;
    const previousEntryHash = tail?.entryHash ?? null;

    const canonicalPayload = buildAuditEntryCanonicalPayload({
      id: entry.id.toString(),
      chainKey,
      chainSequence,
      previousEntryHash,
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
    });
    const entryHash = this.hasher.hash(canonicalPayload);

    await client.auditEntry.create({
      data: {
        id: entry.id.toString(),
        category: entry.category,
        eventType: entry.eventType,
        outcome: entry.outcome,
        tenantId: entry.tenantId,
        actorKind: entry.actorKind,
        actorUserId: entry.actorUserId,
        actorRoleCodes: [...entry.actorRoleCodes],
        subjectUserId: entry.subjectUserId,
        targetType: entry.targetType,
        targetId: entry.targetId,
        reason: entry.reason,
        // Champ Prisma `sessionId` (colonne `session_id`, INCHANGEE) — porte `entry.sessionRef`
        // (ADR-0009 §3.1) : changement de VALEUR applicative, jamais de schema.
        sessionId: entry.sessionRef,
        correlationId: entry.correlationId,
        occurredAt: entry.occurredAt,
        chainSequence,
        previousEntryHash,
        entryHash,
        // `chainKey` JAMAIS fourni ici (colonne GENEREE, voir schema.prisma) — la base la calcule.
      },
    });
  }

  async findById(id: AuditEntryId, tenantId: TenantId | null): Promise<AuditEntry | null> {
    const client = resolvePrismaClient(this.prisma);
    // F-6 : filtrage tenant PUREMENT APPLICATIF — `tenantId: null` filtre explicitement sur
    // `tenant_id IS NULL` (lecture PLATEFORME), jamais ignore silencieusement le filtre.
    const row = await client.auditEntry.findFirst({ where: { id: id.toString(), tenantId: tenantId?.toString() ?? null } });
    return row === null ? null : this.toDomain(row);
  }

  async listForTenant(tenantId: TenantId, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage> {
    // `tenantId` POSITIONNEL et OBLIGATOIRE (ADR-0009 §6, alternative ecartee #4) — jamais lu
    // depuis `filter`, qui ne porte structurellement aucun champ de tenant.
    return this.listInternal({ tenantId: tenantId.toString() }, filter, page);
  }

  async listForPlatform(scope: PlatformAuditScope, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage> {
    switch (scope.kind) {
      case 'ALL':
        return this.listInternal({}, filter, page);
      case 'PLATFORM_ONLY':
        // Le `null` n'est JAMAIS un joker (F-6) : filtre EXPLICITEMENT `tenant_id IS NULL`.
        return this.listInternal({ tenantId: null }, filter, page);
      case 'TENANT':
        // PLATFORM -> tenant ARBITRAIRE (decision complementaire validee par le responsable
        // technique) : supervision SUPER_ADMIN sur n'importe quel etablissement, sans lui donner
        // de membership artificiel.
        return this.listInternal({ tenantId: scope.tenantId.toString() }, filter, page);
      default: {
        const exhaustiveCheck: never = scope;
        throw new Error(`PlatformAuditScope.kind non gere : ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  /**
   * Correctif securite 2026-09-01 (vulnerabilite ELEVEE, revue independante) : `limit` DOIT etre
   * honore tel quel par cette methode — `AUDIT_PAGE_MAX_LIMIT` (200) est une borne de la
   * PAGINATION HTTP (§6), une preoccupation SANS RAPPORT avec la lecture par lots de la
   * VERIFICATION DE CHAINE (§5.4) : les reutiliser ici plafonnait silencieusement chaque lot a
   * 200 quel que soit l'argument demande, faisant sortir `VerifyAuditChainIntegrityHandler` de sa
   * boucle de parcours des le premier lot (sa condition de sortie comparait `segment.length` a
   * `CHAIN_SEGMENT_BATCH_SIZE = 500`, jamais atteignable) et declarant a tort la chaine integre
   * au-dela de la 200e entree. `AUDIT_CHAIN_SEGMENT_HARD_LIMIT` ci-dessous est une borne de
   * SECURITE distincte (garde-fou anti-abus sur `limit`), pas une decision d'ADR.
   */
  async readChainSegment(chain: AuditChainKey, fromSequence: number, limit: number): Promise<readonly AuditEntry[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.auditEntry.findMany({
      where: { chainKey: chain.toString(), chainSequence: { gte: fromSequence } },
      orderBy: { chainSequence: 'asc' },
      take: Math.min(limit, AUDIT_CHAIN_SEGMENT_HARD_LIMIT),
    });
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Coeur commun de pagination `keyset` (ADR-0009 §6) : tri `(occurred_at DESC, id DESC)`, curseur
   * OPAQUE deja decode par l'appelant (query handler) — le filtre `tenantScope` est TOUJOURS
   * reapplique ICI, en plus du curseur, a chaque page : "le curseur est une position, jamais une
   * autorisation".
   */
  private async listInternal(
    tenantScope: { tenantId?: string | null },
    filter: AuditEntryFilter,
    page: AuditPageRequest,
  ): Promise<AuditEntryPage> {
    const client = resolvePrismaClient(this.prisma);
    const limit = Math.min(page.limit, AUDIT_PAGE_MAX_LIMIT);

    const where: Prisma.AuditEntryWhereInput = { ...tenantScope };
    if (filter.categories !== undefined && filter.categories.length > 0) {
      where.category = { in: [...filter.categories] };
    }
    if (filter.eventTypes !== undefined && filter.eventTypes.length > 0) {
      where.eventType = { in: [...filter.eventTypes] };
    }
    if (filter.outcomes !== undefined && filter.outcomes.length > 0) {
      where.outcome = { in: [...filter.outcomes] };
    }
    if (filter.actorKinds !== undefined && filter.actorKinds.length > 0) {
      where.actorKind = { in: [...filter.actorKinds] };
    }
    if (filter.actorUserId !== undefined) {
      where.actorUserId = filter.actorUserId;
    }
    if (filter.subjectUserId !== undefined) {
      where.subjectUserId = filter.subjectUserId;
    }
    if (filter.targetType !== undefined) {
      where.targetType = filter.targetType;
    }
    if (filter.targetId !== undefined) {
      where.targetId = filter.targetId;
    }
    if (filter.occurredFrom !== undefined || filter.occurredTo !== undefined) {
      where.occurredAt = {
        ...(filter.occurredFrom !== undefined ? { gte: filter.occurredFrom } : {}),
        ...(filter.occurredTo !== undefined ? { lte: filter.occurredTo } : {}),
      };
    }

    if (page.cursor !== null) {
      // Keyset DESC : la page suivante ne contient que les lignes STRICTEMENT anterieures au
      // couple (occurredAt, id) du curseur, dans l'ordre de tri — jamais un `OFFSET`.
      where.OR = [
        { occurredAt: { lt: page.cursor.occurredAt } },
        { occurredAt: page.cursor.occurredAt, id: { lt: page.cursor.id } },
      ];
    }

    const rows = await client.auditEntry.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined ? encodeAuditEntryCursor({ occurredAt: lastRow.occurredAt.toISOString(), id: lastRow.id }) : null;

    return { entries: pageRows.map((row) => this.toDomain(row)), nextCursor };
  }

  async countUnchained(chain: AuditChainKey): Promise<number> {
    const client = resolvePrismaClient(this.prisma);
    return client.auditEntry.count({ where: { chainKey: chain.toString(), entryHash: null } });
  }

  private toDomain(row: AuditEntryRow): AuditEntry {
    const id = assertValid(AuditEntryId.create(row.id));
    return AuditEntry.reconstitute(id, {
      category: row.category as AuditCategory,
      eventType: row.eventType as AuditEventType,
      outcome: row.outcome as AuditOutcome,
      tenantId: row.tenantId,
      actorKind: row.actorKind as ActorKind,
      actorUserId: row.actorUserId,
      actorRoleCodes: row.actorRoleCodes,
      subjectUserId: row.subjectUserId,
      targetType: row.targetType as AuditTargetType,
      targetId: row.targetId,
      reason: row.reason,
      // Colonne `session_id` inchangee (`row.sessionId`, nom impose par Prisma) — porte
      // desormais `sessionRef` (ADR-0009 §3.1) ; `reconstitute()` ne derive JAMAIS rien.
      sessionRef: row.sessionId,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
      chainSequence: row.chainSequence === null ? null : Number(row.chainSequence),
      previousEntryHash: row.previousEntryHash,
      entryHash: row.entryHash,
    });
  }
}
