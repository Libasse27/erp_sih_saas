import type { Request, Response } from 'express';
import type { ListAuditEntriesHandler, ListAuditEntriesRequestedScope } from '../../application/queries/ListAuditEntries.js';
import type { RecordAuditAccessHandler } from '../../application/commands/RecordAuditAccess.js';
import type { AuditReadPrincipal } from '../../application/AuditReadPrincipal.js';
import { authorizeAuditRead } from '../../application/AuthorizeAuditRead.js';
import type { AuditEntryFilter } from '../../domain/AuditEntryFilter.js';
import { AUDIT_PAGE_DEFAULT_LIMIT } from '../../domain/AuditPage.js';
import { ListAuditEntriesQuerySchema } from './ListAuditEntriesQuerySchema.js';
import { toAuditEntryListResponse } from './AuditEntryDto.js';

/**
 * Ce que le middleware `requireAuthenticatedContext` (construit dans `composition-root.ts`)
 * attache a `res.locals` AVANT ce controleur — jamais un second chemin de resolution de contexte
 * (ADR-0009 §8.2).
 */
export interface AuditHttpLocals {
  readonly auditPrincipal: AuditReadPrincipal;
  readonly sessionId: string;
}

function isAuditHttpLocals(locals: Record<string, unknown>): locals is Record<string, unknown> & AuditHttpLocals {
  return locals.auditPrincipal !== undefined && locals.sessionId !== undefined;
}

/**
 * SEUL endpoint HTTP de ce module — le PREMIER endpoint authentifie du depot (ADR-0009 §8). Le
 * controleur fait STRICTEMENT trois choses (§3.5 du system prompt) : valider (zod `.strict()`),
 * deleguer (`RecordAuditAccess` PUIS, seulement si autorise, `ListAuditEntries`), presenter (DTO
 * explicite). Aucune logique metier ici — l'autorisation elle-meme est deleguee a
 * `authorizeAuditRead` (module `audit`), jamais reimplementee.
 */
export class AuditEntryController {
  constructor(
    private readonly listAuditEntries: ListAuditEntriesHandler,
    private readonly recordAuditAccess: RecordAuditAccessHandler,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const locals = res.locals as Record<string, unknown>;
    if (!isAuditHttpLocals(locals)) {
      // Ne devrait jamais arriver : `requireAuthenticatedContext` repond deja 401/403 AVANT
      // d'atteindre ce controleur si aucun principal n'a pu etre resolu (voir composition-root.ts).
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const { auditPrincipal: principal, sessionId } = locals;

    const parsed = ListAuditEntriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const q = parsed.data;
    const correlationId = req.header('x-correlation-id') ?? null;

    const requestedScope = toRequestedScope(q.scope, q.tenantId);

    // AVANT toute lecture (ADR-0009 §7/§10) : la trace de consultation — GRANTED ou DENIED — est
    // TOUJOURS ecrite en premier, y compris quand l'acces est refuse.
    const authorization = authorizeAuditRead(principal, requestedScope);
    await this.recordAuditAccess.execute({
      principal,
      outcome: authorization.isSuccess() ? 'GRANTED' : 'DENIED',
      sessionId,
      correlationId,
      // Refus d'AUTORISATION (jamais de rythme) : `reason: null`, non-regression exacte ADR-0011
      // §4.2 — distingue ce refus du rejet de limitation de debit, ecrit par
      // `AuditEntriesRateLimitMiddleware.ts`/`composition-root.ts` avec `reason:
      // AUDIT_TRAIL_QUERY_RATE_LIMIT_REASON`.
      reason: null,
    });

    if (authorization.isFailure()) {
      const error = authorization.getError();
      if (error === 'SCOPE_NOT_ALLOWED') {
        // §8.5 : un parametre de perimetre soumis par une session TENANT -> 400, jamais ignore.
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // `exactOptionalPropertyTypes` (regle 1 du system prompt) interdit d'assigner explicitement
    // `undefined` a une propriete optionnelle de `AuditEntryFilter` — chaque champ n'est donc
    // inclus dans l'objet QUE lorsque le parametre de requete correspondant est present, jamais
    // ecrit avec une valeur `undefined` explicite.
    const filter: AuditEntryFilter = {
      ...(q.category !== undefined ? { categories: [q.category] } : {}),
      ...(q.eventType !== undefined ? { eventTypes: [q.eventType] } : {}),
      ...(q.outcome !== undefined ? { outcomes: [q.outcome] } : {}),
      ...(q.actorKind !== undefined ? { actorKinds: [q.actorKind] } : {}),
      ...(q.actorUserId !== undefined ? { actorUserId: q.actorUserId } : {}),
      ...(q.subjectUserId !== undefined ? { subjectUserId: q.subjectUserId } : {}),
      ...(q.targetType !== undefined ? { targetType: q.targetType } : {}),
      ...(q.targetId !== undefined ? { targetId: q.targetId } : {}),
      ...(q.from !== undefined ? { occurredFrom: new Date(q.from) } : {}),
      ...(q.to !== undefined ? { occurredTo: new Date(q.to) } : {}),
    };

    const result = await this.listAuditEntries.execute(principal, {
      filter,
      cursor: q.cursor ?? null,
      limit: q.limit ?? AUDIT_PAGE_DEFAULT_LIMIT,
      requestedScope,
    });

    if (result.isFailure()) {
      // `FORBIDDEN` ne devrait plus survenir ici (deja tranche ci-dessus par
      // `authorizeAuditRead`, defense en profondeur) ; `INVALID_QUERY` = curseur/limite malformes.
      const error = result.getError();
      res.status(error === 'FORBIDDEN' ? 403 : 400).json({ error: error === 'FORBIDDEN' ? 'forbidden' : 'invalid_request' });
      return;
    }

    res.status(200).json(toAuditEntryListResponse(result.getValue()));
  };
}

function toRequestedScope(
  scope: 'all' | 'platform' | 'tenant' | undefined,
  tenantId: string | undefined,
): ListAuditEntriesRequestedScope | null {
  if (scope === undefined && tenantId === undefined) {
    return null;
  }
  if (scope === 'tenant') {
    // `tenantId` manquant avec `scope=tenant` : traite comme une demande de perimetre malformee
    // (ni `null` ni un perimetre valide) — le handler la refusera via `INVALID_QUERY` pour un
    // principal PLATFORM, ou via `SCOPE_NOT_ALLOWED` (presence du parametre) pour un TENANT.
    return { kind: 'TENANT', tenantId: tenantId ?? '' };
  }
  if (scope === 'platform') {
    return { kind: 'PLATFORM_ONLY' };
  }
  // `scope=all`, OU seul `tenantId` fourni sans `scope` (traite comme une demande de perimetre
  // explicite malgre tout, §8.5 : la seule PRESENCE d'un parametre de perimetre suffit).
  return tenantId !== undefined ? { kind: 'TENANT', tenantId } : { kind: 'ALL' };
}
