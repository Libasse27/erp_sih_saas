import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { AuditEntry } from '../domain/AuditEntry.js';
import type { AuditEntryRepository } from '../domain/ports/AuditEntryRepository.js';
import type { AuditCategory } from '../domain/value-objects/AuditCategory.js';
import type { AuditEventType } from '../domain/value-objects/AuditEventType.js';
import type { AuditOutcome } from '../domain/value-objects/AuditOutcome.js';
import { PrismaAuditEntryRepository } from './persistence/PrismaAuditEntryRepository.js';

export interface RecordAuditEntryParams {
  readonly category: AuditCategory;
  readonly eventType: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly tenantId: string | null;
  readonly subjectUserId: string;
  readonly actorUserId: string;
  readonly actorRoleCodes: readonly string[];
  readonly reason: string | null;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

export interface AuditModule {
  readonly repositories: {
    readonly auditEntries: AuditEntryRepository;
  };
  readonly services: {
    /**
     * Construit et persiste une `AuditEntry` (via `AuditEntry.record()` + `append()`). DOIT
     * toujours etre appele DANS la transaction courante de l'appelant (`resolvePrismaClient`
     * rejoint l'AsyncLocalStorage active par `unitOfWork.withTransaction` — voir
     * `PrismaAuditEntryRepository.append()`), jamais depuis un consommateur Outbox (ADR-0005 §5).
     */
    recordEntry(params: RecordAuditEntryParams): Promise<void>;
  };
}

/**
 * Cablage minimal du module `audit` (Phase 0, etape 7/13, ADR-0005 §5). Perimetre volontairement
 * reduit : persistance append-only + enregistrement simple — requetes, retention (O-15) et
 * console Super Admin restent a l'etape 11/13 (voir l'ADR).
 */
export function buildAuditModule(deps: { prisma: PrismaClient; clock: Clock; idGenerator: IdGenerator }): AuditModule {
  const auditEntries = new PrismaAuditEntryRepository(deps.prisma);

  return {
    repositories: { auditEntries },
    services: {
      async recordEntry(params: RecordAuditEntryParams): Promise<void> {
        const entry = AuditEntry.record({
          category: params.category,
          eventType: params.eventType,
          outcome: params.outcome,
          tenantId: params.tenantId,
          subjectUserId: params.subjectUserId,
          actorUserId: params.actorUserId,
          actorRoleCodes: params.actorRoleCodes,
          reason: params.reason,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          clock: deps.clock,
          idGenerator: deps.idGenerator,
        });
        await auditEntries.append(entry);
      },
    },
  };
}
