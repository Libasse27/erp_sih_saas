import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { AuditEntry } from '../../domain/AuditEntry.js';
import type { AuditEntryRepository } from '../../domain/ports/AuditEntryRepository.js';
import { AuditEntryId } from '../../domain/value-objects/AuditEntryId.js';
import type { AuditCategory } from '../../domain/value-objects/AuditCategory.js';
import type { AuditEventType } from '../../domain/value-objects/AuditEventType.js';
import type { AuditOutcome } from '../../domain/value-objects/AuditOutcome.js';

interface AuditEntryRow {
  id: string;
  category: string;
  eventType: string;
  outcome: string;
  tenantId: string | null;
  subjectUserId: string;
  actorUserId: string;
  actorRoleCodes: string[];
  reason: string | null;
  sessionId: string | null;
  correlationId: string | null;
  occurredAt: Date;
}

/**
 * Repository `AuditEntry` — table `platform.AuditEntry`, HORS RLS (ADR-0005 §5, `tenant_id`
 * NULLABLE, filtrage tenant PUREMENT APPLICATIF pour tout futur consommateur). `resolvePrismaClient`
 * rejoint TOUJOURS la transaction courante (AsyncLocalStorage) — c'est ce qui garantit que
 * `append()` commite dans LA MEME transaction que l'action MFA auditee (ADR-0005 §5), jamais via
 * l'Outbox. `create()` UNIQUEMENT (jamais `update`/`upsert`/`delete`) : coherent avec le contrat
 * `AuditEntryRepository` et avec l'immuabilite imposee en base (`REVOKE UPDATE, DELETE` + trigger,
 * voir la migration correspondante).
 */
export class PrismaAuditEntryRepository implements AuditEntryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async append(entry: AuditEntry): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.auditEntry.create({
      data: {
        id: entry.id.toString(),
        category: entry.category,
        eventType: entry.eventType,
        outcome: entry.outcome,
        tenantId: entry.tenantId,
        subjectUserId: entry.subjectUserId,
        actorUserId: entry.actorUserId,
        actorRoleCodes: [...entry.actorRoleCodes],
        reason: entry.reason,
        sessionId: entry.sessionId,
        correlationId: entry.correlationId,
        occurredAt: entry.occurredAt,
      },
    });
  }

  async findById(id: AuditEntryId, tenantId: TenantId | null): Promise<AuditEntry | null> {
    const client = resolvePrismaClient(this.prisma);
    // F-6 : filtrage tenant PUREMENT APPLICATIF (cette table est HORS RLS, ADR-0005 §5) —
    // `tenantId: null` filtre explicitement sur `tenant_id IS NULL` (lecture PLATEFORME), jamais
    // ignore silencieusement le filtre.
    const row = await client.auditEntry.findFirst({ where: { id: id.toString(), tenantId: tenantId?.toString() ?? null } });
    return row === null ? null : this.toDomain(row);
  }

  private toDomain(row: AuditEntryRow): AuditEntry {
    const id = assertValid(AuditEntryId.create(row.id));
    return AuditEntry.reconstitute(id, {
      category: row.category as AuditCategory,
      eventType: row.eventType as AuditEventType,
      outcome: row.outcome as AuditOutcome,
      tenantId: row.tenantId,
      subjectUserId: row.subjectUserId,
      actorUserId: row.actorUserId,
      actorRoleCodes: row.actorRoleCodes,
      reason: row.reason,
      sessionId: row.sessionId,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
    });
  }
}
