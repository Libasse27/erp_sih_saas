import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { RefreshToken, type RefreshTokenRevocationReason } from '../../domain/RefreshToken.js';
import type { RefreshTokenRepository } from '../../domain/ports/RefreshTokenRepository.js';
import type { RefreshTokenGenerator } from '../../domain/ports/RefreshTokenGenerator.js';
import type { RefreshTokenHasher } from '../../domain/ports/RefreshTokenHasher.js';
import { RefreshTokenId } from '../../domain/value-objects/RefreshTokenId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { SessionContext } from '../ports/SessionStore.js';

export type RefreshTokenValidationOutcome =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'REUSE_DETECTED'; readonly record: RefreshToken }
  | { readonly kind: 'CHAIN_ALREADY_REVOKED'; readonly record: RefreshToken }
  | { readonly kind: 'ABSOLUTE_CEILING_EXCEEDED'; readonly record: RefreshToken }
  | { readonly kind: 'INACTIVITY_TIMEOUT_EXCEEDED'; readonly record: RefreshToken }
  | { readonly kind: 'VALID'; readonly record: RefreshToken };

/**
 * Orchestration du cycle de vie d'une chaine de refresh token (O-06.5, ADR-0006 §5-§6). Ne gere
 * JAMAIS l'audit lui-meme (voir `RefreshSessionHandler`/handlers appelants : meme separation des
 * responsabilites que `SessionContextIssuer`, qui ne journalise pas non plus — c'est l'appelant
 * qui connait le contexte d'acteur/sujet necessaire a une entree d'audit honnete).
 */
export class RefreshTokenIssuer {
  constructor(
    private readonly repository: RefreshTokenRepository,
    private readonly generator: RefreshTokenGenerator,
    private readonly hasher: RefreshTokenHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  /** Demarre une NOUVELLE chaine pour une session fraichement emise. `null` pour `MFA_PENDING` (ADR-0006 §7 : aucune chaine n'est jamais issue d'une session en attente de second facteur). */
  async issueChain(session: SessionContext): Promise<{ raw: string } | null> {
    if (session.kind === 'MFA_PENDING') {
      return null;
    }
    const raw = this.generator.generate();
    const record = RefreshToken.issueNewChain({
      id: this.nextId(),
      chainId: this.idGenerator.generate(),
      userId: assertUserId(session.userId),
      tenantId: session.kind === 'TENANT' ? assertTenantId(session.tenantId) : null,
      membershipId: session.kind === 'TENANT' ? session.membershipId : null,
      sensitivityCategory: session.sensitivityCategory,
      tokenHash: this.hasher.hash(raw),
      sessionId: session.sessionId,
      now: this.clock.now(),
    });
    await this.unitOfWork.withTransaction(() => this.repository.create(record));
    return { raw };
  }

  /**
   * Lecture + validation SEULE (ADR-0006 §5-6, "Décision" §6/§9) — n'ecrit RIEN en base. Distingue
   * cinq issues d'echec (jamais un seul code generique) pour permettre a l'appelant de choisir
   * la raison de revocation ET l'evenement d'audit appropries.
   *
   * `REUSE_DETECTED` (statut `ROTATED`) et `CHAIN_ALREADY_REVOKED` (statut `REVOKED`) sont
   * DELIBEREMENT distingues (correctif apres relecture de cette ADR) : un statut `ROTATED` prouve
   * qu'une generation DEJA CONSOMMEE est represente — un rejeu veritable (ADR-0006 §6). Un statut
   * `REVOKED` signifie que la chaine a deja ete fermee pour une raison quelconque, SOUVENT benigne
   * (deconnexion explicite, changement de contexte tenant, revocation de membership) — la
   * requalifier en "reutilisation" a chaque tentative post-logout inonderait le journal
   * `SESSION_REFRESH_REUSE_DETECTED` d'entrees non representatives d'une attaque, sapant sa valeur
   * de signal. `CHAIN_ALREADY_REVOKED` ne redeclenche ni revocation (deja faite, idempotente de
   * toute facon) ni nouvelle entree d'audit.
   */
  async validateForRotation(rawToken: string): Promise<RefreshTokenValidationOutcome> {
    const hash = this.hasher.hash(rawToken);
    const record = await this.unitOfWork.withTransaction(() => this.repository.findByHash(hash));
    if (record === null) {
      return { kind: 'NOT_FOUND' };
    }
    if (record.status === 'ROTATED') {
      return { kind: 'REUSE_DETECTED', record };
    }
    if (record.status === 'REVOKED') {
      return { kind: 'CHAIN_ALREADY_REVOKED', record };
    }
    const now = this.clock.now();
    if (!record.isWithinAbsoluteCeiling(now)) {
      return { kind: 'ABSOLUTE_CEILING_EXCEEDED', record };
    }
    if (!record.isWithinInactivityWindow(now)) {
      return { kind: 'INACTIVITY_TIMEOUT_EXCEEDED', record };
    }
    return { kind: 'VALID', record };
  }

  /**
   * Rotation atomique APRES que `validateForRotation` a renvoye `VALID` ET que le nouveau
   * contexte de session a ete resolu avec succes (ordre impose par `RefreshSessionHandler` : ne
   * jamais consommer la ligne active avant de savoir que le renouvellement va reellement
   * aboutir). `tryMarkRotatedIfActive` peut malgre tout echouer ici : une requete CONCURRENTE a
   * gagne la course sur l'ecriture entre la lecture de validation et cet appel (ADR-0006 §5,
   * nuance explicite). Retourne `null` dans ce cas — CE N'EST PAS une reutilisation (la chaine
   * reste valide, prolongee par la requete gagnante) : l'appelant DOIT repondre par un echec
   * propre et NON PUNITIF (`CONCURRENT_REFRESH_CONFLICT`), sans revoquer la chaine ni journaliser
   * d'evenement `SESSION_*`, sous peine de deconnecter la requete gagnante pour un usage
   * parfaitement legitime (deux onglets, double-clic).
   */
  async completeRotation(params: { previous: RefreshToken; newSessionId: string }): Promise<{ raw: string; record: RefreshToken } | null> {
    const now = this.clock.now();
    const raw = this.generator.generate();
    const next = RefreshToken.issueRotated({
      id: this.nextId(),
      previous: params.previous,
      tokenHash: this.hasher.hash(raw),
      sessionId: params.newSessionId,
      now,
    });
    const rotated = await this.unitOfWork.withTransaction(async () => {
      const flipped = await this.repository.tryMarkRotatedIfActive(params.previous.tokenHash, now);
      if (!flipped) {
        return false;
      }
      await this.repository.create(next);
      return true;
    });
    return rotated ? { raw, record: next } : null;
  }

  /** Retourne les `sessionId` DISTINCTS de la chaine revoquee (voir `RefreshTokenRepository.revokeChain`) — l'appelant reste responsable de les fermer cote `SessionStore`. */
  async revokeChain(chainId: string, reason: RefreshTokenRevocationReason): Promise<readonly string[]> {
    return this.unitOfWork.withTransaction(() => this.repository.revokeChain(chainId, reason, this.clock.now()));
  }

  async revokeChainBySessionId(sessionId: string, reason: RefreshTokenRevocationReason): Promise<void> {
    await this.unitOfWork.withTransaction(() =>
      this.repository.revokeChainBySessionId(sessionId, reason, this.clock.now()),
    );
  }

  async revokeAllForUser(userId: string, reason: RefreshTokenRevocationReason): Promise<void> {
    await this.unitOfWork.withTransaction(() => this.repository.revokeAllForUser(userId, reason, this.clock.now()));
  }

  async revokeAllForMembership(membershipId: string, reason: RefreshTokenRevocationReason): Promise<void> {
    await this.unitOfWork.withTransaction(() =>
      this.repository.revokeAllForMembership(membershipId, reason, this.clock.now()),
    );
  }

  private nextId(): RefreshTokenId {
    const idResult = RefreshTokenId.create(this.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour RefreshToken.');
    }
    return idResult.getValue();
  }
}

function assertUserId(value: string): UserAccountId {
  const result = UserAccountId.create(value);
  if (result.isFailure()) {
    // Un SessionContext porte toujours un userId deja valide (produit par SessionContextIssuer) —
    // une valeur invalide ici trahirait une corruption du stockage de session, pas un echec metier.
    throw new Error(`RefreshTokenIssuer : userId de session invalide ("${value}").`);
  }
  return result.getValue();
}

function assertTenantId(value: string): TenantId {
  const result = TenantId.create(value);
  if (result.isFailure()) {
    throw new Error(`RefreshTokenIssuer : tenantId de session invalide ("${value}").`);
  }
  return result.getValue();
}
