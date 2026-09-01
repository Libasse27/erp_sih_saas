import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { AuditEntry } from '../domain/AuditEntry.js';
import type { AuditEntryRepository } from '../domain/ports/AuditEntryRepository.js';
import type { AuditEntryHasher } from '../domain/ports/AuditEntryHasher.js';
import type { AuditSessionReferenceDeriver } from '../domain/ports/AuditSessionReferenceDeriver.js';
import type { AuditEntryRecordParams } from '../domain/AuditEntryRecordParams.js';
import { PrismaAuditEntryRepository } from './persistence/PrismaAuditEntryRepository.js';
import { Sha256AuditEntryHasher } from './Sha256AuditEntryHasher.js';
import { Sha256AuditSessionReferenceDeriver } from './Sha256AuditSessionReferenceDeriver.js';
import { ListAuditEntriesHandler } from '../application/queries/ListAuditEntries.js';
import { VerifyAuditChainIntegrityHandler } from '../application/queries/VerifyAuditChainIntegrity.js';
import { RecordAuditAccessHandler } from '../application/commands/RecordAuditAccess.js';

export type { AuditEntryRecordParams as RecordAuditEntryParams };

export interface AuditModule {
  readonly repositories: {
    readonly auditEntries: AuditEntryRepository;
  };
  readonly services: {
    /**
     * Construit et persiste une `AuditEntry` (via `AuditEntry.record()` + `append()`). DOIT
     * toujours etre appele DANS la transaction courante de l'appelant (`resolvePrismaClient`
     * rejoint l'AsyncLocalStorage active par `unitOfWork.withTransaction` — voir
     * `PrismaAuditEntryRepository.append()`), jamais depuis un consommateur Outbox dont la SEULE
     * fonction serait d'ecrire de l'audit (ADR-0005 §5, ADR-0009 §4).
     */
    recordEntry(params: AuditEntryRecordParams): Promise<void>;
  };
  readonly queries: {
    readonly listAuditEntries: ListAuditEntriesHandler;
    readonly verifyAuditChainIntegrity: VerifyAuditChainIntegrityHandler;
  };
  readonly commands: {
    /** Ouvre SA PROPRE transaction courte (`PgUnitOfWork` dedie) — jamais reutilise la transaction d'un autre module (ADR-0009 §7). */
    readonly recordAuditAccess: RecordAuditAccessHandler;
  };
}

/**
 * Cablage du module `audit` — etendu ADR-0009 (etape 11/13) : hacheur SHA-256, query handlers
 * (`ListAuditEntries`/`VerifyAuditChainIntegrity`), commande `RecordAuditAccess`. Perimetre
 * d'origine (etape 7/13, ADR-0005 §5) : persistance append-only + enregistrement simple.
 */
export function buildAuditModule(deps: { prisma: PrismaClient; clock: Clock; idGenerator: IdGenerator }): AuditModule {
  const hasher: AuditEntryHasher = new Sha256AuditEntryHasher();
  // Correctif securite 2026-09-01 (ADR-0009 §3.1) : cable ICI, meme discipline que `hasher`
  // ci-dessus — SEUL point du code ou `AuditEntry.record()` est invoque (voir `recordEntry`
  // ci-dessous), donc SEUL endroit ou ce port a besoin d'etre construit.
  const sessionReferenceDeriver: AuditSessionReferenceDeriver = new Sha256AuditSessionReferenceDeriver();
  const auditEntries = new PrismaAuditEntryRepository(deps.prisma, hasher);
  const unitOfWork = new PgUnitOfWork(deps.prisma);

  const services = {
    async recordEntry(params: AuditEntryRecordParams): Promise<void> {
      const entry = AuditEntry.record({
        category: params.category,
        eventType: params.eventType,
        outcome: params.outcome,
        tenantId: params.tenantId,
        actorKind: params.actorKind,
        actorUserId: params.actorUserId,
        actorRoleCodes: params.actorRoleCodes,
        subjectUserId: params.subjectUserId,
        targetType: params.targetType,
        targetId: params.targetId,
        reason: params.reason,
        sessionId: params.sessionId,
        correlationId: params.correlationId,
        clock: deps.clock,
        idGenerator: deps.idGenerator,
        sessionReferenceDeriver,
      });
      await auditEntries.append(entry);
    },
  };

  return {
    repositories: { auditEntries },
    services,
    queries: {
      listAuditEntries: new ListAuditEntriesHandler(auditEntries),
      verifyAuditChainIntegrity: new VerifyAuditChainIntegrityHandler(auditEntries, hasher),
    },
    commands: {
      recordAuditAccess: new RecordAuditAccessHandler({ recordEntry: services.recordEntry }, unitOfWork),
    },
  };
}
