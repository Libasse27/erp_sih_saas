import { describe, expect, it } from 'vitest';
import { mustSucceed, uuidAt } from '../../../../test/identity/builders/testKit.js';
import { RefreshToken } from './RefreshToken.js';
import { RefreshTokenHash } from './value-objects/RefreshTokenHash.js';
import { RefreshTokenId } from './value-objects/RefreshTokenId.js';
import { UserAccountId } from './value-objects/UserAccountId.js';

function hashOf(raw: string): RefreshTokenHash {
  return mustSucceed(RefreshTokenHash.create(`v1.p1.${raw}`));
}

describe('RefreshToken (ADR-0006 §5)', () => {
  const userId = mustSucceed(UserAccountId.create(uuidAt(1)));

  it("issueNewChain fixe le plafond absolu depuis 'now' selon la politique de la categorie", () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    const token = RefreshToken.issueNewChain({
      id: mustSucceed(RefreshTokenId.create(uuidAt(2))),
      chainId: uuidAt(3),
      userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD',
      tokenHash: hashOf('secret-1'),
      sessionId: 's1',
      now,
    });

    expect(token.isActive()).toBe(true);
    expect(token.chainStartedAt).toEqual(now);
    // TENANT_STANDARD (placeholder, non definitif) : 24h absolu, 1h inactivite.
    expect(token.absoluteExpiresAt.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(token.inactivityExpiresAt.getTime() - now.getTime()).toBe(60 * 60 * 1000);
  });

  it("issueRotated COPIE le plafond absolu de la chaine tel quel — ne l_etend JAMAIS depuis 'now' de la rotation (invariant central de la fenetre glissante)", () => {
    const chainStart = new Date('2026-08-28T00:00:00.000Z');
    const first = RefreshToken.issueNewChain({
      id: mustSucceed(RefreshTokenId.create(uuidAt(4))),
      chainId: uuidAt(5),
      userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD',
      tokenHash: hashOf('secret-2'),
      sessionId: 's1',
      now: chainStart,
    });
    first.markRotated();

    const muchLater = new Date(chainStart.getTime() + 23 * 60 * 60 * 1000); // 23h plus tard, toujours < plafond 24h
    const second = RefreshToken.issueRotated({
      id: mustSucceed(RefreshTokenId.create(uuidAt(6))),
      previous: first,
      tokenHash: hashOf('secret-3'),
      sessionId: 's2',
      now: muchLater,
    });

    expect(second.chainStartedAt).toEqual(chainStart);
    expect(second.absoluteExpiresAt).toEqual(first.absoluteExpiresAt);
    expect(second.previousTokenId).toBe(first.id.toString());
    expect(second.chainId).toBe(first.chainId);
  });

  it("issueRotated plafonne inactivityExpiresAt par absoluteExpiresAt quand la fenetre d_inactivite depasserait le plafond absolu", () => {
    const chainStart = new Date('2026-08-28T00:00:00.000Z');
    const first = RefreshToken.issueNewChain({
      id: mustSucceed(RefreshTokenId.create(uuidAt(7))),
      chainId: uuidAt(8),
      userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD',
      tokenHash: hashOf('secret-4'),
      sessionId: 's1',
      now: chainStart,
    });
    first.markRotated();

    // A 30 minutes du plafond absolu (24h) : la fenetre d'inactivite standard (1h) le depasserait.
    const nearCeiling = new Date(first.absoluteExpiresAt.getTime() - 30 * 60 * 1000);
    const second = RefreshToken.issueRotated({
      id: mustSucceed(RefreshTokenId.create(uuidAt(9))),
      previous: first,
      tokenHash: hashOf('secret-5'),
      sessionId: 's2',
      now: nearCeiling,
    });

    expect(second.inactivityExpiresAt).toEqual(second.absoluteExpiresAt);
  });

  it('markRotated transitionne ACTIVE -> ROTATED', () => {
    const token = RefreshToken.issueNewChain({
      id: mustSucceed(RefreshTokenId.create(uuidAt(10))),
      chainId: uuidAt(11),
      userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD',
      tokenHash: hashOf('secret-6'),
      sessionId: 's1',
      now: new Date(),
    });
    expect(token.isActive()).toBe(true);
    token.markRotated();
    expect(token.isActive()).toBe(false);
    expect(token.status).toBe('ROTATED');
  });

  it('markRevoked transitionne vers REVOKED avec raison et horodatage', () => {
    const token = RefreshToken.issueNewChain({
      id: mustSucceed(RefreshTokenId.create(uuidAt(12))),
      chainId: uuidAt(13),
      userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD',
      tokenHash: hashOf('secret-7'),
      sessionId: 's1',
      now: new Date(),
    });
    const revokedAt = new Date('2026-08-28T05:00:00.000Z');
    token.markRevoked('REUSE_DETECTED', revokedAt);
    expect(token.status).toBe('REVOKED');
    expect(token.revokedReason).toBe('REUSE_DETECTED');
    expect(token.revokedAt).toEqual(revokedAt);
    expect(token.isActive()).toBe(false);
  });

  it('isWithinAbsoluteCeiling / isWithinInactivityWindow refletent les bornes calculees', () => {
    const chainStart = new Date('2026-08-28T00:00:00.000Z');
    const token = RefreshToken.issueNewChain({
      id: mustSucceed(RefreshTokenId.create(uuidAt(14))),
      chainId: uuidAt(15),
      userId,
      tenantId: null,
      membershipId: null,
      sensitivityCategory: 'TENANT_STANDARD',
      tokenHash: hashOf('secret-8'),
      sessionId: 's1',
      now: chainStart,
    });

    expect(token.isWithinAbsoluteCeiling(new Date(chainStart.getTime() + 23 * 60 * 60 * 1000))).toBe(true);
    expect(token.isWithinAbsoluteCeiling(new Date(chainStart.getTime() + 25 * 60 * 60 * 1000))).toBe(false);
    expect(token.isWithinInactivityWindow(new Date(chainStart.getTime() + 30 * 60 * 1000))).toBe(true);
    expect(token.isWithinInactivityWindow(new Date(chainStart.getTime() + 90 * 60 * 1000))).toBe(false);
  });
});
