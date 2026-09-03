import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import { MfaEnrollmentConfirmed } from './events/MfaEnrollmentConfirmed.js';
import { MfaEnrollmentStarted } from './events/MfaEnrollmentStarted.js';
import { MfaFactorLockedOut } from './events/MfaFactorLockedOut.js';
import { MfaFactorReplaced } from './events/MfaFactorReplaced.js';
import { MfaReEnrollmentForced } from './events/MfaReEnrollmentForced.js';
import { MfaRecoveryCodeConsumed } from './events/MfaRecoveryCodeConsumed.js';
import { MfaRecoveryCodesExhausted } from './events/MfaRecoveryCodesExhausted.js';
import { MfaRecoveryCodesRegenerated } from './events/MfaRecoveryCodesRegenerated.js';
import { MfaRecoveryCode } from './MfaRecoveryCode.js';
import { MFA_LOCKOUT_DURATION_MS, MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS } from './MfaTuning.js';
import { MfaEnrollmentId } from './value-objects/MfaEnrollmentId.js';
import type { MfaEnrollmentStatus } from './value-objects/MfaEnrollmentStatus.js';
import type { MfaFactorType } from './value-objects/MfaFactorType.js';
import { MfaRecoveryCodeId } from './value-objects/MfaRecoveryCodeId.js';
import type { EncryptedTotpSecret } from './value-objects/EncryptedTotpSecret.js';
import type { RecoveryCodeHash } from './value-objects/RecoveryCodeHash.js';
import type { UserAccountId } from './value-objects/UserAccountId.js';

interface MfaEnrollmentProps {
  readonly userId: UserAccountId;
  status: MfaEnrollmentStatus;
  factorType: MfaFactorType;
  activeSecret: EncryptedTotpSecret | null;
  pendingSecret: EncryptedTotpSecret | null;
  recoveryCodes: MfaRecoveryCode[];
  lastAcceptedTimeStep: number | null;
  /**
   * DISTINCT de `lastAcceptedTimeStep` (pose UNIQUEMENT par `confirmEnrollment`, jamais lu par
   * `registerSuccessfulChallenge`) — decouple l'anti-rejeu du CHALLENGE de connexion de celui de
   * la CONFIRMATION d'enrolement. Revue de securite independante de l'etape 12/13, finding AC-1 :
   * sans ce champ separe, confirmer l'enrolement PUIS se connecter dans la MEME fenetre TOTP de
   * 30s rejetait a tort le premier challenge comme "code deja utilise", cassant le parcours
   * nominal (register -> mfa_required -> enroll -> confirm -> login/challenge -> session).
   */
  lastAcceptedChallengeTimeStep: number | null;
  consecutiveFailedAttempts: number;
  lockedUntil: Date | null;
  activatedAt: Date | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

export type BeginReEnrollmentError = 'ENROLLMENT_ALREADY_ACTIVE';
export type ConfirmEnrollmentError = 'NO_PENDING_FACTOR';
export type RegisterSuccessfulChallengeError = 'CODE_ALREADY_USED';
export type ConsumeRecoveryCodeError = 'RECOVERY_CODE_NOT_FOUND' | 'RECOVERY_CODE_ALREADY_CONSUMED';
export type RegenerateRecoveryCodesError = 'ENROLLMENT_NOT_ACTIVE';
export type ForceReEnrollmentError = 'REASON_REQUIRED';

/**
 * Agregat racine du second facteur d'authentification (ADR-0005). Lie a `UserAccount` PAR
 * IDENTIFIANT UNIQUEMENT (`userId`) — jamais charge dans le meme agregat (voir ADR-0005 §1 pour
 * la justification complete : chemin de connexion, rythmes d'ecriture, SRP, cycle de vie).
 *
 * Modelise "facteur courant + facteur en attente" DANS LE MEME agregat pour rendre
 * structurellement impossible une fenetre ou un compte soumis au MFA n'aurait plus aucun
 * facteur pendant un remplacement (ADR-0005 §1).
 *
 * INVARIANT NON NEGOCIABLE (O-04.5) : cet agregat n'expose et n'exposera JAMAIS de methode de
 * desactivation. Le seul chemin de sortie d'un facteur actif est `forceReEnrollment`, qui
 * replace TOUJOURS le compte en etat `RESET_REQUIRED` — jamais un etat "MFA non requis".
 */
export class MfaEnrollment extends AggregateRoot<MfaEnrollmentId> {
  private props: MfaEnrollmentProps;

  private constructor(id: MfaEnrollmentId, props: MfaEnrollmentProps) {
    super(id);
    this.props = props;
  }

  static start(params: {
    userId: UserAccountId;
    pendingSecret: EncryptedTotpSecret;
    clock: Clock;
    idGenerator: IdGenerator;
  }): MfaEnrollment {
    const idResult = MfaEnrollmentId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      // Meme raisonnement que UserAccount.register() : l'IdGenerator est cense produire un UUID
      // v4 valide — une valeur invalide ici est un bug d'infrastructure, pas un echec metier attendu.
      throw new Error('IdGenerator a produit un identifiant invalide pour MfaEnrollment.');
    }
    const id = idResult.getValue();
    const now = params.clock.now();
    const enrollment = new MfaEnrollment(id, {
      userId: params.userId,
      status: 'PENDING_ACTIVATION',
      factorType: 'TOTP',
      activeSecret: null,
      pendingSecret: params.pendingSecret,
      recoveryCodes: [],
      lastAcceptedTimeStep: null,
      lastAcceptedChallengeTimeStep: null,
      consecutiveFailedAttempts: 0,
      lockedUntil: null,
      activatedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    enrollment.addDomainEvent(
      MfaEnrollmentStarted.create({
        enrollmentId: id.toString(),
        userAccountId: params.userId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return enrollment;
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: MfaEnrollmentId, props: MfaEnrollmentProps): MfaEnrollment {
    return new MfaEnrollment(id, props);
  }

  /**
   * (Re)demarre un enrolement sur un agregat EXISTANT (facteur jamais confirme, ou
   * `RESET_REQUIRED` apres `forceReEnrollment`). Refuse tant que le facteur courant est `ACTIVE`
   * (O-04.5 : pas de remplacement silencieux par l'utilisateur lui-meme — seul
   * `forceReEnrollment`, par un tiers habilite, sort d'un etat `ACTIVE`).
   */
  beginReEnrollment(params: { pendingSecret: EncryptedTotpSecret; clock: Clock }): Result<void, BeginReEnrollmentError> {
    if (this.props.status === 'ACTIVE') {
      return Result.failure('ENROLLMENT_ALREADY_ACTIVE');
    }
    this.props.pendingSecret = params.pendingSecret;
    this.props.updatedAt = params.clock.now();
    return Result.success(undefined);
  }

  /**
   * Active le facteur `pendingSecret` (deja verifie par un code TOTP valide cote application,
   * via le port `TotpService` — voir `ConfirmMfaEnrollment`/`RegenerateMfaRecoveryCodes`) et
   * remplace L'INTEGRALITE du jeu de codes de recuperation.
   *
   * Distingue `MfaEnrollmentConfirmed` (toute premiere activation de ce compte, `activatedAt`
   * jamais renseigne avant cet appel) de `MfaFactorReplaced` (ré-enrolement apres
   * `RESET_REQUIRED` — ce compte a deja ete actif par le passe).
   */
  confirmEnrollment(params: {
    timeStep: number;
    recoveryCodes: readonly RecoveryCodeHash[];
    clock: Clock;
    idGenerator: IdGenerator;
  }): Result<void, ConfirmEnrollmentError> {
    if (this.props.pendingSecret === null) {
      return Result.failure('NO_PENDING_FACTOR');
    }
    const wasReplacement = this.props.activatedAt !== null;
    const now = params.clock.now();

    this.props.activeSecret = this.props.pendingSecret;
    this.props.pendingSecret = null;
    this.props.status = 'ACTIVE';
    this.props.activatedAt = now;
    this.props.updatedAt = now;
    this.props.lastAcceptedTimeStep = params.timeStep;
    this.props.consecutiveFailedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.recoveryCodes = params.recoveryCodes.map((hash) =>
      MfaRecoveryCode.issue({ id: this.nextRecoveryCodeId(params.idGenerator), hash, createdAt: now }),
    );

    this.addDomainEvent(
      wasReplacement
        ? MfaFactorReplaced.create({
            enrollmentId: this.id.toString(),
            userAccountId: this.props.userId.toString(),
            clock: params.clock,
            idGenerator: params.idGenerator,
          })
        : MfaEnrollmentConfirmed.create({
            enrollmentId: this.id.toString(),
            userAccountId: this.props.userId.toString(),
            clock: params.clock,
            idGenerator: params.idGenerator,
          }),
    );
    return Result.success(undefined);
  }

  /**
   * Enregistre un code TOTP valide (deja verifie cote application). Refuse le REJEU d'un pas de
   * temps deja accepte ou anterieur PAR UN CHALLENGE PRECEDENT (`lastAcceptedChallengeTimeStep`)
   * — anti-rejeu structurel, independant de la fenetre de derive appliquee par
   * `TotpService.verify()`. Compteur DISTINCT de celui pose par `confirmEnrollment`
   * (`lastAcceptedTimeStep`) : le premier challenge qui suit une confirmation peut reutiliser le
   * MEME code/pas de temps que celui utilise pour confirmer (AC-1 — voir le commentaire de
   * `lastAcceptedChallengeTimeStep` sur `MfaEnrollmentProps`), seul le rejeu ENTRE DEUX CHALLENGES
   * reste bloque.
   */
  registerSuccessfulChallenge(params: { timeStep: number; clock: Clock }): Result<void, RegisterSuccessfulChallengeError> {
    if (this.props.lastAcceptedChallengeTimeStep !== null && params.timeStep <= this.props.lastAcceptedChallengeTimeStep) {
      return Result.failure('CODE_ALREADY_USED');
    }
    this.props.lastAcceptedChallengeTimeStep = params.timeStep;
    this.props.consecutiveFailedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.updatedAt = params.clock.now();
    return Result.success(undefined);
  }

  /** Incremente le compteur d'echecs ; verrouille temporairement au seuil (`MfaTuning.ts`). */
  registerFailedChallenge(clock: Clock, idGenerator: IdGenerator): void {
    this.props.consecutiveFailedAttempts += 1;
    this.props.updatedAt = clock.now();
    if (this.props.consecutiveFailedAttempts >= MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS) {
      this.props.lockedUntil = new Date(clock.now().getTime() + MFA_LOCKOUT_DURATION_MS);
      this.addDomainEvent(
        MfaFactorLockedOut.create({
          enrollmentId: this.id.toString(),
          userAccountId: this.props.userId.toString(),
          clock,
          idGenerator,
        }),
      );
    }
  }

  /** Consomme un code de recuperation a usage unique (jamais de recharge partielle — ADR-0005 §3). */
  consumeRecoveryCode(params: {
    hash: RecoveryCodeHash;
    clock: Clock;
    idGenerator: IdGenerator;
  }): Result<void, ConsumeRecoveryCodeError> {
    const code = this.props.recoveryCodes.find((candidate) => candidate.matches(params.hash));
    if (code === undefined) {
      return Result.failure('RECOVERY_CODE_NOT_FOUND');
    }
    if (code.isConsumed()) {
      return Result.failure('RECOVERY_CODE_ALREADY_CONSUMED');
    }
    const now = params.clock.now();
    code.consume(now);
    this.props.consecutiveFailedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.updatedAt = now;
    this.addDomainEvent(
      MfaRecoveryCodeConsumed.create({
        enrollmentId: this.id.toString(),
        userAccountId: this.props.userId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    if (this.props.recoveryCodes.every((candidate) => candidate.isConsumed())) {
      this.addDomainEvent(
        MfaRecoveryCodesExhausted.create({
          enrollmentId: this.id.toString(),
          userAccountId: this.props.userId.toString(),
          clock: params.clock,
          idGenerator: params.idGenerator,
        }),
      );
    }
    return Result.success(undefined);
  }

  /** Remplace L'INTEGRALITE du jeu de codes — exige une preuve TOTP fraiche verifiee EN AMONT par l'appelant (step-up, O-06.3). */
  regenerateRecoveryCodes(params: {
    hashes: readonly RecoveryCodeHash[];
    clock: Clock;
    idGenerator: IdGenerator;
  }): Result<void, RegenerateRecoveryCodesError> {
    if (this.props.status !== 'ACTIVE') {
      return Result.failure('ENROLLMENT_NOT_ACTIVE');
    }
    const now = params.clock.now();
    this.props.recoveryCodes = params.hashes.map((hash) =>
      MfaRecoveryCode.issue({ id: this.nextRecoveryCodeId(params.idGenerator), hash, createdAt: now }),
    );
    this.props.updatedAt = now;
    this.addDomainEvent(
      MfaRecoveryCodesRegenerated.create({
        enrollmentId: this.id.toString(),
        userAccountId: this.props.userId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return Result.success(undefined);
  }

  /**
   * SEUL chemin de sortie d'un facteur `ACTIVE` (O-04.5). Exige un motif non vide, replace
   * TOUJOURS le compte en `RESET_REQUIRED` (jamais "MFA non requis"), revoque immediatement le
   * facteur et tous les codes de recuperation courants. `activatedAt` N'EST PAS reinitialise :
   * il reste la trace que ce compte a deja ete actif par le passe, utilisee par
   * `confirmEnrollment` pour distinguer `MfaEnrollmentConfirmed` de `MfaFactorReplaced`.
   */
  forceReEnrollment(params: {
    requestedByUserId: string;
    reason: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): Result<void, ForceReEnrollmentError> {
    if (params.reason.trim().length === 0) {
      return Result.failure('REASON_REQUIRED');
    }
    const now = params.clock.now();
    this.props.status = 'RESET_REQUIRED';
    this.props.activeSecret = null;
    this.props.pendingSecret = null;
    this.props.recoveryCodes = [];
    this.props.lastAcceptedTimeStep = null;
    this.props.lastAcceptedChallengeTimeStep = null;
    this.props.consecutiveFailedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.updatedAt = now;
    this.addDomainEvent(
      MfaReEnrollmentForced.create({
        enrollmentId: this.id.toString(),
        userAccountId: this.props.userId.toString(),
        requestedByUserId: params.requestedByUserId,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return Result.success(undefined);
  }

  /** Vrai si un challenge (TOTP ou code de recuperation) peut etre tente MAINTENANT. */
  isChallengeable(now: Date): boolean {
    if (this.props.status !== 'ACTIVE') {
      return false;
    }
    return !this.isLocked(now);
  }

  isActive(): boolean {
    return this.props.status === 'ACTIVE';
  }

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && now < this.props.lockedUntil;
  }

  private nextRecoveryCodeId(idGenerator: IdGenerator): MfaRecoveryCodeId {
    const idResult = MfaRecoveryCodeId.create(idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour MfaRecoveryCode.');
    }
    return idResult.getValue();
  }

  get userId(): UserAccountId {
    return this.props.userId;
  }

  get status(): MfaEnrollmentStatus {
    return this.props.status;
  }

  get factorType(): MfaFactorType {
    return this.props.factorType;
  }

  get activeSecret(): EncryptedTotpSecret | null {
    return this.props.activeSecret;
  }

  get pendingSecret(): EncryptedTotpSecret | null {
    return this.props.pendingSecret;
  }

  get recoveryCodes(): readonly MfaRecoveryCode[] {
    return this.props.recoveryCodes;
  }

  get lastAcceptedTimeStep(): number | null {
    return this.props.lastAcceptedTimeStep;
  }

  get lastAcceptedChallengeTimeStep(): number | null {
    return this.props.lastAcceptedChallengeTimeStep;
  }

  get consecutiveFailedAttempts(): number {
    return this.props.consecutiveFailedAttempts;
  }

  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }

  get activatedAt(): Date | null {
    return this.props.activatedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
