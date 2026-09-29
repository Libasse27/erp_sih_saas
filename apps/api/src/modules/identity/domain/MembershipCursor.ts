/**
 * Curseur de pagination `keyset` opaque, couple `(joinedAt, id)` encode en base64url — MEME
 * CONVENTION que `modules/audit/domain/AuditEntryCursor.ts` (ADR-0009 §6 : jamais un `OFFSET`,
 * qui saute/duplique des lignes sur une collection en croissance non bornee), reprise ICI plutot
 * qu'importee depuis `audit` : "Aucun import direct entre modules" (§5.1 du system prompt) —
 * chaque module possede sa PROPRE implementation de la meme convention, jamais un partage de
 * code cross-module pour un detail d'infrastructure de pagination.
 *
 * "Le curseur est une position, jamais une autorisation" : le decodage ne porte AUCUNE
 * information de perimetre — le filtre tenant est reapplique par l'appelant a CHAQUE page
 * (voir `PrismaUserTenantMembershipRepository.listByTenant`), independamment du contenu du
 * curseur.
 */
export interface MembershipCursorPayload {
  readonly joinedAt: string;
  readonly id: string;
}

/** Renvoie `null` en cas de curseur malforme — jamais une exception : l'appelant HTTP doit traduire ce cas en `400 invalid_request`, jamais un `500`. */
export function decodeMembershipCursor(cursor: string): MembershipCursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { joinedAt?: unknown }).joinedAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const payload = parsed as MembershipCursorPayload;
    if (Number.isNaN(Date.parse(payload.joinedAt))) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function encodeMembershipCursor(payload: MembershipCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
