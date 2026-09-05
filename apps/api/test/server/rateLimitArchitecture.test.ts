import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Test d'architecture textuel (ADR-0011, "Tests attendus") — verifie par LECTURE DU CODE SOURCE,
 * pas par execution, les deux invariants structurels de D4 :
 *   - `SilentRateLimitGuard.ts` (webhook paiement) ne contient AUCUNE occurrence de `429` : son
 *     UNIQUE chemin de reponse sur rejet est `res.status(200).end()` (D4, alternative ecartee #6 —
 *     aucun drapeau `silent` sur `createRateLimitMiddleware` qui rendrait un `429` possible ici) ;
 *   - `RateLimitMiddleware.ts` (les cinq routes ADR-0010) ne contient AUCUN chemin de reponse
 *     `200` explicite (il ne repond QUE `429` sur rejet, ou delegue via `next()`).
 *
 * Aucune dependance a Redis/PostgreSQL/Express — lecture de fichier pure, execution immediate.
 */
function readSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

describe('Invariants structurels des factories de limitation de debit (ADR-0011)', () => {
  it('SilentRateLimitGuard.ts ne contient aucune occurrence de 429', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/SilentRateLimitGuard.ts');
    expect(source).not.toContain('429');
  });

  it('SilentRateLimitGuard.ts ne repond jamais autrement que 200 sur son chemin de rejet', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/SilentRateLimitGuard.ts');
    expect(source).toContain('res.status(200).end()');
  });

  it('RateLimitMiddleware.ts (ADR-0010, cinq routes) ne contient aucun chemin de reponse 200', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/RateLimitMiddleware.ts');
    expect(source).not.toContain('status(200)');
  });

  it('RateLimitMiddleware.ts (ADR-0010) reste INCHANGE : aucun drapeau "silent" n_y a ete ajoute (ADR-0011, alternative ecartee #6)', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/RateLimitMiddleware.ts');
    expect(source).not.toContain('silent');
  });

  it('AuditEntriesRateLimitMiddleware.ts n_ecrit lui-meme aucun log (aucune IP, aucun corps de requete, aucun secret ne peut donc y fuiter : le seul canal d_ecriture sur rejet est le rappel `onFirstRejectionInWindow` fourni par composition-root.ts)', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/AuditEntriesRateLimitMiddleware.ts');
    expect(source).not.toMatch(/console\.|logger\./);
  });

  it('SilentRateLimitGuard.ts n_ecrit lui-meme aucun log (le rappel `onRejected`, fourni par composition-root.ts, est le SEUL canal d_observabilite)', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/SilentRateLimitGuard.ts');
    expect(source).not.toMatch(/console\.|logger\./);
  });

  it('SilentRateLimitGuard.ts ne peut structurellement pas ecrire d_AuditEntry : aucune dependance a Prisma ni au module `audit` (ADR-0011 §5.3)', () => {
    const source = readSource('../../src/shared-kernel/infrastructure/SilentRateLimitGuard.ts');
    expect(source).not.toMatch(/@prisma\/client|modules\/audit/);
  });

  it('RateLimitMiddleware.ts (ADR-0010, cinq routes) ne peut structurellement pas ecrire d_AuditEntry : aucune dependance a Prisma ni au module `audit`', () => {
    // Complete, sans en dependre, l_assertion par count() de rateLimiting.test.ts (ADR-0011
    // Amendement 1, BLOQUANT-2) : cette derniere est bornee par un correlationId que
    // POST /api/v1/registrations ne propage nulle part et ne peut donc pas, seule, prouver
    // l_absence d_ecriture d_audit sur un rejet des cinq routes ADR-0010. Cette garantie
    // structurelle-ci est independante de tout comportement HTTP observe.
    const source = readSource('../../src/shared-kernel/infrastructure/RateLimitMiddleware.ts');
    expect(source).not.toMatch(/@prisma\/client|modules\/audit/);
  });
});
