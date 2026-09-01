import { createHash } from 'node:crypto';
import type { AuditEntryHasher } from '../domain/ports/AuditEntryHasher.js';

/** Prefixe de domaine de hachage (ADR-0009 §5.2) — evite qu'une empreinte calculee ici puisse jamais collisionner avec un hachage produit ailleurs dans le systeme pour un autre usage. */
const HASH_DOMAIN_PREFIX = 'audit-entry:v1|';

/** Enveloppe de version (ADR-0009 §5.2) — meme discipline que `v1.<keyId>` sur `EncryptedTotpSecret` (ADR-0005 §2) : un changement d'algorithme futur reste additif. */
const HASH_ENVELOPE_PREFIX = 'v1.';

/**
 * Implementation `node:crypto` du port `AuditEntryHasher` (ADR-0009 §5.2) — SHA-256 sur la charge
 * canonique deja construite par `AuditEntryCanonicalPayload.ts` (fonction pure du domaine, jamais
 * de logique de serialisation ici).
 */
export class Sha256AuditEntryHasher implements AuditEntryHasher {
  hash(canonicalPayload: string): string {
    const digest = createHash('sha256').update(HASH_DOMAIN_PREFIX + canonicalPayload, 'utf8').digest();
    return HASH_ENVELOPE_PREFIX + digest.toString('base64url');
  }
}
