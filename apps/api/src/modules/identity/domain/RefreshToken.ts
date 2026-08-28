import { Entity } from '../../../shared-kernel/domain/Entity.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { resolveSessionDurationPolicy } from './SessionDurationTuning.js';
import { RefreshTokenId } from './value-objects/RefreshTokenId.js';
import type { RefreshTokenHash } from './value-objects/RefreshTokenHash.js';
import type { SessionSensitivityCategory } from './value-objects/SessionSensitivityCategory.js';
import type { UserAccountId } from './value-objects/UserAccountId.js';

export type RefreshTokenStatus = 'ACTIVE' | 'ROTATED' | 'REVOKED';

/**
 * Raison de revocation d'une chaine — vocabulaire ferme, jamais un texte libre (contrairement au
 * `reason` de `ForceMfaReEnrollment`, qui documente un motif humain) : ADR-0006 §6/§9.
 */
export type RefreshTokenRevocationReason =
  | 'LOGOUT'
  | 'CONTEXT_SWITCHED'
  | 'MEMBERSHIP_REVOKED'
  | 'MFA_RE_ENROLLMENT_FORCED'
  | 'REUSE_DETECTED'
  | 'ABSOLUTE_CEILING_EXCEEDED'
  | 'INACTIVITY_TIMEOUT'
  | 'CONTEXT_NO_LONGER_AVAILABLE';

interface RefreshTokenProps {
  readonly chainId: string;
  readonly userId: UserAccountId;
  readonly tenantId: TenantId | null;
  readonly membershipId: string | null;
  readonly sensitivityCategory: SessionSensitivityCategory;
  readonly tokenHash: RefreshTokenHash;
  status: RefreshTokenStatus;
  sessionId: string;
  readonly previousTokenId: string | null;
  readonly chainStartedAt: Date;
  readonly absoluteExpiresAt: Date;
  inactivityExpiresAt: Date;
  readonly issuedAt: Date;
  revokedAt: Date | null;
  revokedReason: RefreshTokenRevocationReason | null;
}

/**
 * Une generation de refresh token au sein d'une chaine de rotation (O-06.5, ADR-0006 §5). Chaque
 * utilisation consomme la ligne courante (`status: 'ACTIVE' -> 'ROTATED'`) et en cree une
 * NOUVELLE, chainee par `chainId`/`previousTokenId` — jamais de mutation en place de la ligne
 * active elle-meme (meme doctrine que le remplacement de session, O-05.1).
 *
 * `absoluteExpiresAt` est fixe a la CREATION DE LA CHAINE (`issueNewChain`) et copie tel quel a
 * chaque rotation (`issueRotated`) : la fenetre glissante ne doit jamais pouvoir repousser le
 * plafond absolu. `inactivityExpiresAt` est recalcule a chaque rotation, plafonne par
 * `absoluteExpiresAt`.
 *
 * N'est PAS un `AggregateRoot` : aucun evenement de domaine n'est emis (l'audit `SESSION` est
 * ecrit directement par l'application, dans la transaction courante — ADR-0006 §8, meme
 * raisonnement qu'ADR-0005 §5 pour `AuditEntry`) — une simple `Entity`, persistee et interrogee
 * comme sa propre unite (jamais interne a un autre agregat).
 */
export class RefreshToken extends Entity<RefreshTokenId> {
  private props: RefreshTokenProps;

  private constructor(id: RefreshTokenId, props: RefreshTokenProps) {
    super(id);
    this.props = props;
  }

  static issueNewChain(params: {
    id: RefreshTokenId;
    chainId: string;
    userId: UserAccountId;
    tenantId: TenantId | null;
    membershipId: string | null;
    sensitivityCategory: SessionSensitivityCategory;
    tokenHash: RefreshTokenHash;
    sessionId: string;
    now: Date;
  }): RefreshToken {
    const policy = resolveSessionDurationPolicy(params.sensitivityCategory);
    const absoluteExpiresAt = new Date(params.now.getTime() + policy.absoluteCeilingSeconds * 1000);
    const inactivityExpiresAt = capAt(new Date(params.now.getTime() + policy.inactivitySeconds * 1000), absoluteExpiresAt);
    return new RefreshToken(params.id, {
      chainId: params.chainId,
      userId: params.userId,
      tenantId: params.tenantId,
      membershipId: params.membershipId,
      sensitivityCategory: params.sensitivityCategory,
      tokenHash: params.tokenHash,
      status: 'ACTIVE',
      sessionId: params.sessionId,
      previousTokenId: null,
      chainStartedAt: params.now,
      absoluteExpiresAt,
      inactivityExpiresAt,
      issuedAt: params.now,
      revokedAt: null,
      revokedReason: null,
    });
  }

  /**
   * Nouvelle generation continuant la chaine de `previous` (deja marquee `ROTATED` par
   * l'appelant, voir `markRotated`). `absoluteExpiresAt`/`chainStartedAt` sont COPIES tels quels
   * (jamais recalcules) — voir la doc de classe.
   */
  static issueRotated(params: { id: RefreshTokenId; previous: RefreshToken; tokenHash: RefreshTokenHash; sessionId: string; now: Date }): RefreshToken {
    const previousProps = params.previous.props;
    const policy = resolveSessionDurationPolicy(previousProps.sensitivityCategory);
    const inactivityExpiresAt = capAt(
      new Date(params.now.getTime() + policy.inactivitySeconds * 1000),
      previousProps.absoluteExpiresAt,
    );
    return new RefreshToken(params.id, {
      chainId: previousProps.chainId,
      userId: previousProps.userId,
      tenantId: previousProps.tenantId,
      membershipId: previousProps.membershipId,
      sensitivityCategory: previousProps.sensitivityCategory,
      tokenHash: params.tokenHash,
      status: 'ACTIVE',
      sessionId: params.sessionId,
      previousTokenId: params.previous.id.toString(),
      chainStartedAt: previousProps.chainStartedAt,
      absoluteExpiresAt: previousProps.absoluteExpiresAt,
      inactivityExpiresAt,
      issuedAt: params.now,
      revokedAt: null,
      revokedReason: null,
    });
  }

  static reconstitute(id: RefreshTokenId, props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(id, props);
  }

  /** Transition locale de l'instance APRES que le repository a confirme la transition atomique en base (voir `RefreshTokenRepository.tryMarkRotatedIfActive`). */
  markRotated(): void {
    this.props.status = 'ROTATED';
  }

  markRevoked(reason: RefreshTokenRevocationReason, now: Date): void {
    this.props.status = 'REVOKED';
    this.props.revokedAt = now;
    this.props.revokedReason = reason;
  }

  isActive(): boolean {
    return this.props.status === 'ACTIVE';
  }

  isWithinAbsoluteCeiling(now: Date): boolean {
    return now.getTime() < this.props.absoluteExpiresAt.getTime();
  }

  isWithinInactivityWindow(now: Date): boolean {
    return now.getTime() < this.props.inactivityExpiresAt.getTime();
  }

  get chainId(): string {
    return this.props.chainId;
  }

  get userId(): UserAccountId {
    return this.props.userId;
  }

  get tenantId(): TenantId | null {
    return this.props.tenantId;
  }

  get membershipId(): string | null {
    return this.props.membershipId;
  }

  get sensitivityCategory(): SessionSensitivityCategory {
    return this.props.sensitivityCategory;
  }

  get tokenHash(): RefreshTokenHash {
    return this.props.tokenHash;
  }

  get status(): RefreshTokenStatus {
    return this.props.status;
  }

  get sessionId(): string {
    return this.props.sessionId;
  }

  get previousTokenId(): string | null {
    return this.props.previousTokenId;
  }

  get chainStartedAt(): Date {
    return this.props.chainStartedAt;
  }

  get absoluteExpiresAt(): Date {
    return this.props.absoluteExpiresAt;
  }

  get inactivityExpiresAt(): Date {
    return this.props.inactivityExpiresAt;
  }

  get issuedAt(): Date {
    return this.props.issuedAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get revokedReason(): RefreshTokenRevocationReason | null {
    return this.props.revokedReason;
  }
}

function capAt(candidate: Date, ceiling: Date): Date {
  return candidate.getTime() > ceiling.getTime() ? ceiling : candidate;
}
