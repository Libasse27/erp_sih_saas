/**
 * Curseur de pagination `keyset` opaque, couple `(occurredAt, id)` encode en base64url
 * (ADR-0009 §6 — jamais un `OFFSET`, qui saute/duplique des lignes sur une table append-only en
 * croissance non bornee). "Le curseur est une position, jamais une autorisation" : le decodage ne
 * porte AUCUNE information de perimetre — le filtre tenant est reapplique par l'appelant a CHAQUE
 * page, independamment du contenu du curseur (voir `PrismaAuditEntryRepository.listForTenant`).
 */
export interface AuditEntryCursorPayload {
  readonly occurredAt: string;
  readonly id: string;
}

/** Renvoie `null` en cas de curseur malforme — jamais une exception : l'appelant HTTP doit traduire ce cas en `400 invalid_request`, jamais un `500`. */
export function decodeAuditEntryCursor(cursor: string): AuditEntryCursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { occurredAt?: unknown }).occurredAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const payload = parsed as AuditEntryCursorPayload;
    if (Number.isNaN(Date.parse(payload.occurredAt))) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function encodeAuditEntryCursor(payload: AuditEntryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
