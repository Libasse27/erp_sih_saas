import { Entity } from '../../../shared-kernel/domain/Entity.js';
import type { MfaRecoveryCodeId } from './value-objects/MfaRecoveryCodeId.js';
import type { RecoveryCodeHash } from './value-objects/RecoveryCodeHash.js';

interface MfaRecoveryCodeProps {
  readonly hash: RecoveryCodeHash;
  readonly createdAt: Date;
  consumedAt: Date | null;
}

/**
 * Entite INTERNE de l'agregat `MfaEnrollment` (ADR-0005 §1) — jamais chargee ni sauvegardee
 * independamment de sa racine. Consommable uniquement via `MfaEnrollment.consumeRecoveryCode()` :
 * aucune methode publique de ce type ne mute l'etat sans passer par la racine (invariant
 * d'agregat standard).
 */
export class MfaRecoveryCode extends Entity<MfaRecoveryCodeId> {
  private props: MfaRecoveryCodeProps;

  /**
   * TRANSIENT (jamais persistee, jamais reconstituee) : vraie SI ET SEULEMENT SI `consume()` a
   * ete appelee sur CETTE instance en memoire. Distingue, cote repository, "je viens de muter ce
   * code dans cette meme transaction" de "ce code etait deja consomme au chargement" — revue de
   * securite independante de l'etape 12/13, AC-A : sans cette distinction,
   * `PrismaMfaEnrollmentRepository.reconcileRecoveryCodes` ne pouvait discriminer un REJEU
   * sequentiel (legitime, aucune ecriture necessaire) d'une VRAIE course concurrente entre deux
   * writers dont les horodatages tomberaient par malchance sur la MEME milliseconde — un simple
   * `code.consumedAt === current.consumedAt` masquerait ce second cas.
   */
  private mutatedInThisInstance = false;

  private constructor(id: MfaRecoveryCodeId, props: MfaRecoveryCodeProps) {
    super(id);
    this.props = props;
  }

  static issue(params: { id: MfaRecoveryCodeId; hash: RecoveryCodeHash; createdAt: Date }): MfaRecoveryCode {
    return new MfaRecoveryCode(params.id, { hash: params.hash, createdAt: params.createdAt, consumedAt: null });
  }

  static reconstitute(id: MfaRecoveryCodeId, props: MfaRecoveryCodeProps): MfaRecoveryCode {
    return new MfaRecoveryCode(id, props);
  }

  get hash(): RecoveryCodeHash {
    return this.props.hash;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get consumedAt(): Date | null {
    return this.props.consumedAt;
  }

  isConsumed(): boolean {
    return this.props.consumedAt !== null;
  }

  matches(hash: RecoveryCodeHash): boolean {
    return this.props.hash.equals(hash);
  }

  /** Package-visible en pratique (appelable depuis n'importe quel module TS) mais documente comme reserve a `MfaEnrollment` — jamais appele depuis l'application. */
  consume(now: Date): void {
    this.props.consumedAt = now;
    this.mutatedInThisInstance = true;
  }

  /** Voir le commentaire de `mutatedInThisInstance` — usage reserve a `PrismaMfaEnrollmentRepository.reconcileRecoveryCodes`. */
  wasConsumedInThisInstance(): boolean {
    return this.mutatedInThisInstance;
  }
}
