import { createHash } from 'node:crypto';
import type { AuditSessionReferenceDeriver } from '../domain/ports/AuditSessionReferenceDeriver.js';

/**
 * Prefixe de domaine de hachage (ADR-0009 §3.1) — DISTINCT de celui du chainage
 * (`"audit-entry:v1|"`, voir `Sha256AuditEntryHasher.ts`) : deux usages cryptographiques
 * differents ne partagent jamais un espace de hachage.
 */
const HASH_DOMAIN_PREFIX = 'audit-session:v1|';

/** Enveloppe de version (ADR-0009 §3.1) — meme discipline que `v1.<sha256-base64url>` sur `AuditEntry.entryHash` (§5.2). */
const HASH_ENVELOPE_PREFIX = 'v1.';

/**
 * Implementation `node:crypto` du port `AuditSessionReferenceDeriver` (ADR-0009 §3.1) — SHA-256
 * NON clee (voir l'ADR pour les trois raisons de la divergence avec le HMAC poivre d'ADR-0006 §4 :
 * `sessionRef` n'authentifie rien, l'entropie du `sessionId` (`randomUUID()`, 122 bits CSPRNG)
 * suffit, et un poivre rotatif briserait definitivement la correlation sur un registre
 * append-only non purgeable).
 */
export class Sha256AuditSessionReferenceDeriver implements AuditSessionReferenceDeriver {
  derive(sessionId: string | null): string | null {
    if (sessionId === null) {
      return null;
    }
    const digest = createHash('sha256').update(HASH_DOMAIN_PREFIX + sessionId, 'utf8').digest();
    return HASH_ENVELOPE_PREFIX + digest.toString('base64url');
  }
}
