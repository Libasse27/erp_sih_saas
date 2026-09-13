import { describe, expect, it } from 'vitest';
import { Sha256AuditEntryHasher } from './Sha256AuditEntryHasher.js';

describe('Sha256AuditEntryHasher', () => {
  it('vecteur fixe : prefixe de domaine, enveloppe de version et algorithme fige (ADR-0009 §5.2) — toute derive ici invalide silencieusement les chaines d_audit deja produites en production', () => {
    const hasher = new Sha256AuditEntryHasher();
    const canonicalPayload = '{"actorUserId":"11111111-1111-1111-1111-111111111111","action":"AUDIT_TRAIL_QUERIED"}';

    const result = hasher.hash(canonicalPayload);

    expect(result).toBe('v1.aZgJcHJrU99j-vdx-q9UwXf-YY2MaSZ5Ju7XOGPr58s');
  });

  it('deux charges canoniques differentes produisent des empreintes differentes', () => {
    const hasher = new Sha256AuditEntryHasher();
    const a = hasher.hash('payload-a');
    const b = hasher.hash('payload-b');
    expect(a).not.toBe(b);
  });

  it('la meme charge canonique produit toujours la meme empreinte (determinisme)', () => {
    const hasher = new Sha256AuditEntryHasher();
    const payload = 'payload-identique';
    expect(hasher.hash(payload)).toBe(hasher.hash(payload));
  });
});
