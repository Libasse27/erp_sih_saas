import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import type { AuditEntryRecordParams } from '../../domain/AuditEntryRecordParams.js';
import type { AuditReadPrincipal } from '../AuditReadPrincipal.js';

export type RecordAuditAccessOutcome = 'GRANTED' | 'DENIED';

export interface RecordAuditAccessCommand {
  readonly principal: AuditReadPrincipal;
  readonly outcome: RecordAuditAccessOutcome;
  readonly sessionId: string | null;
  readonly correlationId: string | null;
}

export interface AuditEntryRecorder {
  recordEntry(params: AuditEntryRecordParams): Promise<void>;
}

/**
 * Commande DISTINCTE de `ListAuditEntriesHandler` (ADR-0009 §7 — tension CQRS assumee, alternative
 * ecartee #11) : trace TOUTE consultation du journal, dans sa PROPRE transaction courte, invoquee
 * par la couche de presentation AVANT la lecture — y compris en cas de refus (§7, §10 :
 * l'entree `AUDIT_TRAIL_QUERY_DENIED` doit etre ecrite AVANT que le refus soit renvoye au client).
 *
 * `GRANTED` -> `AUDIT_ACCESS`/`AUDIT_TRAIL_QUERIED`/`SUCCESS`.
 * `DENIED`  -> `AUDIT_ACCESS`/`AUDIT_TRAIL_QUERY_DENIED`/`DENIED` — "c'est le refus qui a le plus
 * de valeur probante : une tentative de lecture transverse laisse une trace PERMANENTE, dans la
 * chaine du TENANT DE L'ACTEUR" (jamais dans celle du tenant vise, qui n'a rien a voir avec
 * l'incident).
 */
export class RecordAuditAccessHandler {
  constructor(
    private readonly auditEntries: AuditEntryRecorder,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(command: RecordAuditAccessCommand): Promise<void> {
    const tenantId = command.principal.kind === 'TENANT' ? command.principal.tenantId : null;

    await this.unitOfWork.withTransaction(
      async () => {
        await this.auditEntries.recordEntry({
          category: 'AUDIT_ACCESS',
          eventType: command.outcome === 'GRANTED' ? 'AUDIT_TRAIL_QUERIED' : 'AUDIT_TRAIL_QUERY_DENIED',
          outcome: command.outcome === 'GRANTED' ? 'SUCCESS' : 'DENIED',
          tenantId,
          actorKind: command.principal.kind === 'PLATFORM' ? 'USER_PLATFORM' : 'USER_TENANT',
          actorUserId: command.principal.actorUserId,
          actorRoleCodes: command.principal.kind === 'TENANT' ? command.principal.roleCodes : [],
          subjectUserId: null,
          targetType: 'AUDIT_TRAIL',
          targetId: null,
          reason: null,
          sessionId: command.sessionId,
          correlationId: command.correlationId,
        });
      },
      tenantId === null
        ? { actorUserId: command.principal.actorUserId }
        : { tenantId: assertValid(TenantId.create(tenantId)), actorUserId: command.principal.actorUserId },
    );
  }
}
