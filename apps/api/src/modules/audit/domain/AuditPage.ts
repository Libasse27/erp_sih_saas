import type { AuditEntry } from './AuditEntry.js';

/** Plafond de page (ADR-0009 §6) : defaut 50, plafond 200 — un depassement est un rejet EXPLICITE, jamais un plafonnement silencieux (voir le query handler). */
export const AUDIT_PAGE_DEFAULT_LIMIT = 50;
export const AUDIT_PAGE_MAX_LIMIT = 200;

export interface AuditPageRequest {
  /** Curseur opaque DEJA DECODE par l'appelant (le port ne connait jamais la representation base64url) — `null` = premiere page. */
  readonly cursor: { readonly occurredAt: Date; readonly id: string } | null;
  readonly limit: number;
}

export interface AuditEntryPage {
  readonly entries: readonly AuditEntry[];
  /** Curseur opaque (base64url) de la page suivante — `null` si la page courante est la derniere. */
  readonly nextCursor: string | null;
}
