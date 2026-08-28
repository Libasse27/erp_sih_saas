import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { RefreshToken, type RefreshTokenRevocationReason, type RefreshTokenStatus } from '../../domain/RefreshToken.js';
import type { RefreshTokenRepository } from '../../domain/ports/RefreshTokenRepository.js';
import { RefreshTokenId } from '../../domain/value-objects/RefreshTokenId.js';
import { RefreshTokenHash } from '../../domain/value-objects/RefreshTokenHash.js';
import type { SessionSensitivityCategory } from '../../domain/value-objects/SessionSensitivityCategory.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';

interface RefreshTokenRow {
  id: string;
  chainId: string;
  userId: string;
  tenantId: string | null;
  membershipId: string | null;
  sensitivityCategory: string;
  tokenHash: string;
  status: string;
  sessionId: string;
  previousTokenId: string | null;
  chainStartedAt: Date;
  absoluteExpiresAt: Date;
  inactivityExpiresAt: Date;
  issuedAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/**
 * Repository `RefreshToken` — table `platform.RefreshToken`, HORS RLS (ADR-0006 §4, meme regime
 * que `MfaEnrollment` : aucune methode ne prend de `tenantId` en filtre, le refresh token est un
 * concept d'identite/session globale).
 *
 * `tryMarkRotatedIfActive` : `UPDATE ... WHERE token_hash = ? AND status = 'ACTIVE'` conditionnel
 * (ADR-0006 §5) — MEME pattern que `PrismaMfaEnrollmentRepository.reconcileRecoveryCodes` pour la
 * consommation d'un code de recuperation. `count === 0` signale qu'un autre writer a deja
 * transitionne cette ligne (course concurrente OU reutilisation) — l'appelant (voir
 * `RefreshTokenIssuer.rotate`) traite les deux cas identiquement (ADR-0006 §5, "en cas de doute,
 * reutilisation").
 */
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByHash(hash: RefreshTokenHash): Promise<RefreshToken | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.refreshToken.findUnique({ where: { tokenHash: hash.value } });
    return row === null ? null : this.toDomain(row);
  }

  async create(token: RefreshToken): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.refreshToken.create({
      data: {
        id: token.id.toString(),
        chainId: token.chainId,
        userId: token.userId.toString(),
        tenantId: token.tenantId?.toString() ?? null,
        membershipId: token.membershipId,
        sensitivityCategory: token.sensitivityCategory,
        tokenHash: token.tokenHash.value,
        status: token.status,
        sessionId: token.sessionId,
        previousTokenId: token.previousTokenId,
        chainStartedAt: token.chainStartedAt,
        absoluteExpiresAt: token.absoluteExpiresAt,
        inactivityExpiresAt: token.inactivityExpiresAt,
        issuedAt: token.issuedAt,
        revokedAt: token.revokedAt,
        revokedReason: token.revokedReason,
      },
    });
  }

  async tryMarkRotatedIfActive(hash: RefreshTokenHash, _now: Date): Promise<boolean> {
    const client = resolvePrismaClient(this.prisma);
    const result = await client.refreshToken.updateMany({
      where: { tokenHash: hash.value, status: 'ACTIVE' },
      data: { status: 'ROTATED' },
    });
    return result.count > 0;
  }

  /**
   * CORRECTIF SECURITE (revue independante, etape 8/13) : la lecture des `sessionId` a fermer
   * DOIT etre ATOMIQUE avec l'ecriture de la revocation elle-meme — jamais un `findMany` PUIS un
   * `updateMany` separes (deux allers-retours). Une rotation concurrente legitime peut committer
   * ENTRE les deux, inserant une nouvelle generation `ACTIVE` avec un NOUVEAU `sessionId` que le
   * `findMany` anterieur n'a jamais vu : ce `sessionId` ne serait alors JAMAIS ferme cote Redis,
   * laissant une session pleinement authentifiee vivante jusqu'a l'expiration de sa TTL malgre la
   * revocation de sa chaine en base (violation directe de la garantie ADR-0006 §6).
   *
   * `UPDATE ... RETURNING "session_id"` en une SEULE instruction ferme cette fenetre : sous
   * REPEAT COMMITTED (`PgUnitOfWork`), une instruction bloquee par le verrou de ligne d'une
   * transaction concurrente ne reprend qu'APRES le commit de cette derniere, et re-evalue alors
   * son propre `WHERE` contre l'etat fraichement committe — capturant donc aussi bien la ligne
   * QUE la rotation concurrente vient de committer, si elle correspond encore au filtre.
   */
  async revokeChain(chainId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<readonly string[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.$queryRaw<{ session_id: string }[]>`
      UPDATE "platform"."RefreshToken"
      SET "status" = 'REVOKED'::"platform"."RefreshTokenStatus",
          "revoked_at" = ${now},
          "revoked_reason" = ${reason}
      WHERE "chain_id" = ${chainId}::uuid
        AND "status" != 'REVOKED'::"platform"."RefreshTokenStatus"
      RETURNING "session_id"
    `;
    return [...new Set(rows.map((row) => row.session_id))];
  }

  async revokeChainBySessionId(sessionId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.refreshToken.findFirst({ where: { sessionId }, select: { chainId: true } });
    if (row === null) {
      return;
    }
    await this.revokeChain(row.chainId, reason, now);
  }

  async revokeAllForUser(userId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.refreshToken.updateMany({
      where: { userId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED', revokedAt: now, revokedReason: reason },
    });
  }

  async revokeAllForMembership(membershipId: string, reason: RefreshTokenRevocationReason, now: Date): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.refreshToken.updateMany({
      where: { membershipId, status: { not: 'REVOKED' } },
      data: { status: 'REVOKED', revokedAt: now, revokedReason: reason },
    });
  }

  private toDomain(row: RefreshTokenRow): RefreshToken {
    const id = assertValid(RefreshTokenId.create(row.id));
    const userId = assertValid(UserAccountId.create(row.userId));
    const tenantId = row.tenantId === null ? null : assertValid(TenantId.create(row.tenantId));
    return RefreshToken.reconstitute(id, {
      chainId: row.chainId,
      userId,
      tenantId,
      membershipId: row.membershipId,
      sensitivityCategory: row.sensitivityCategory as SessionSensitivityCategory,
      tokenHash: assertValid(RefreshTokenHash.create(row.tokenHash)),
      status: row.status as RefreshTokenStatus,
      sessionId: row.sessionId,
      previousTokenId: row.previousTokenId,
      chainStartedAt: row.chainStartedAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      inactivityExpiresAt: row.inactivityExpiresAt,
      issuedAt: row.issuedAt,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason as RefreshTokenRevocationReason | null,
    });
  }
}
