import { describe, expect, it } from 'vitest';
import { FixedClock, idFor, mustFail, mustSucceed, SequentialIdGenerator } from '../../../../test/identity/builders/testKit.js';
import { MfaEnrollment } from './MfaEnrollment.js';
import { MFA_LOCKOUT_DURATION_MS, MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS } from './MfaTuning.js';
import { EncryptedTotpSecret } from './value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from './value-objects/RecoveryCodeHash.js';

function secret(n: number): EncryptedTotpSecret {
  return mustSucceed(EncryptedTotpSecret.create(`v1.k1.iv${n}.tag${n}.cipher${n}`));
}

function recoveryHash(n: number): RecoveryCodeHash {
  return mustSucceed(RecoveryCodeHash.create(`v1.p1.hash${n}`));
}

function startEnrollment(clock: FixedClock, idGenerator: SequentialIdGenerator): MfaEnrollment {
  return MfaEnrollment.start({ userId: idFor.userAccount(1), pendingSecret: secret(1), clock, idGenerator });
}

describe('MfaEnrollment', () => {
  it('start() cree un enrolement PENDING_ACTIVATION et emet MfaEnrollmentStarted', () => {
    const clock = new FixedClock('2026-08-26T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const enrollment = startEnrollment(clock, idGenerator);

    expect(enrollment.status).toBe('PENDING_ACTIVATION');
    expect(enrollment.isActive()).toBe(false);
    expect(enrollment.pendingSecret).not.toBeNull();
    expect(enrollment.activeSecret).toBeNull();
    const events = enrollment.pullDomainEvents();
    expect(events.map((e) => e.eventType)).toEqual(['identity.mfa-enrollment.started']);
  });

  describe('confirmEnrollment', () => {
    it("refuse l'activation sans facteur en attente (NO_PENDING_FACTOR)", () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });
      enrollment.pullDomainEvents();

      const result = enrollment.confirmEnrollment({
        timeStep: 2,
        recoveryCodes: [recoveryHash(2)],
        clock,
        idGenerator,
      });

      // pendingSecret est desormais null (deja confirme) : NO_PENDING_FACTOR.
      expect(mustFail(result)).toBe('NO_PENDING_FACTOR');
    });

    it('active le facteur, memorise le pas de temps, et emet MfaEnrollmentConfirmed a la premiere activation', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.pullDomainEvents();

      const result = enrollment.confirmEnrollment({
        timeStep: 42,
        recoveryCodes: [recoveryHash(1), recoveryHash(2)],
        clock,
        idGenerator,
      });

      expect(result.isSuccess()).toBe(true);
      expect(enrollment.status).toBe('ACTIVE');
      expect(enrollment.isActive()).toBe(true);
      expect(enrollment.activeSecret).not.toBeNull();
      expect(enrollment.pendingSecret).toBeNull();
      expect(enrollment.lastAcceptedTimeStep).toBe(42);
      expect(enrollment.recoveryCodes).toHaveLength(2);
      const events = enrollment.pullDomainEvents();
      expect(events.map((e) => e.eventType)).toEqual(['identity.mfa-enrollment.confirmed']);
    });

    it('emet MfaFactorReplaced (pas MfaEnrollmentConfirmed) lors dune reactivation apres RESET_REQUIRED', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });
      enrollment.pullDomainEvents();

      enrollment.forceReEnrollment({ requestedByUserId: idFor.userAccount(2).toString(), reason: 'compte compromis', clock, idGenerator });
      enrollment.pullDomainEvents();
      expect(enrollment.status).toBe('RESET_REQUIRED');

      const beginResult = enrollment.beginReEnrollment({ pendingSecret: secret(2), clock });
      expect(beginResult.isSuccess()).toBe(true);

      const confirmResult = enrollment.confirmEnrollment({
        timeStep: 100,
        recoveryCodes: [recoveryHash(3)],
        clock,
        idGenerator,
      });
      expect(confirmResult.isSuccess()).toBe(true);
      const events = enrollment.pullDomainEvents();
      expect(events.map((e) => e.eventType)).toEqual(['identity.mfa-enrollment.factor-replaced']);
    });
  });

  it('beginReEnrollment refuse de remplacer un facteur deja ACTIVE (ENROLLMENT_ALREADY_ACTIVE)', () => {
    const clock = new FixedClock('2026-08-26T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const enrollment = startEnrollment(clock, idGenerator);
    enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });

    const result = enrollment.beginReEnrollment({ pendingSecret: secret(2), clock });
    expect(mustFail(result)).toBe('ENROLLMENT_ALREADY_ACTIVE');
  });

  describe('registerSuccessfulChallenge — anti-rejeu', () => {
    it('refuse un pas de temps deja accepte ou anterieur (CODE_ALREADY_USED)', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 10, recoveryCodes: [recoveryHash(1)], clock, idGenerator });

      const replaySame = enrollment.registerSuccessfulChallenge({ timeStep: 10, clock });
      expect(mustFail(replaySame)).toBe('CODE_ALREADY_USED');

      const replayEarlier = enrollment.registerSuccessfulChallenge({ timeStep: 5, clock });
      expect(mustFail(replayEarlier)).toBe('CODE_ALREADY_USED');

      const accepted = enrollment.registerSuccessfulChallenge({ timeStep: 11, clock });
      expect(accepted.isSuccess()).toBe(true);
      expect(enrollment.lastAcceptedTimeStep).toBe(11);
    });
  });

  describe('verrouillage anti-brute-force', () => {
    it(`verrouille apres ${MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS} echecs consecutifs et emet MfaFactorLockedOut`, () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });
      enrollment.pullDomainEvents();

      for (let i = 0; i < MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS - 1; i += 1) {
        enrollment.registerFailedChallenge(clock, idGenerator);
      }
      expect(enrollment.isLocked(clock.now())).toBe(false);

      enrollment.registerFailedChallenge(clock, idGenerator);
      expect(enrollment.isLocked(clock.now())).toBe(true);
      expect(enrollment.isChallengeable(clock.now())).toBe(false);
      const events = enrollment.pullDomainEvents();
      expect(events.map((e) => e.eventType)).toEqual(['identity.mfa-enrollment.factor-locked-out']);
    });

    it(`se deverrouille automatiquement apres ${MFA_LOCKOUT_DURATION_MS / 60000} minutes`, () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });

      for (let i = 0; i < MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS; i += 1) {
        enrollment.registerFailedChallenge(clock, idGenerator);
      }
      expect(enrollment.isLocked(clock.now())).toBe(true);

      clock.advanceMs(MFA_LOCKOUT_DURATION_MS - 1);
      expect(enrollment.isLocked(clock.now())).toBe(true);

      clock.advanceMs(2);
      expect(enrollment.isLocked(clock.now())).toBe(false);
      expect(enrollment.isChallengeable(clock.now())).toBe(true);
    });

    it('un succes reinitialise le compteur d_echecs consecutifs', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });

      enrollment.registerFailedChallenge(clock, idGenerator);
      enrollment.registerFailedChallenge(clock, idGenerator);
      expect(enrollment.consecutiveFailedAttempts).toBe(2);

      enrollment.registerSuccessfulChallenge({ timeStep: 2, clock });
      expect(enrollment.consecutiveFailedAttempts).toBe(0);
    });
  });

  describe('consumeRecoveryCode', () => {
    it('un code de recuperation est consommable une seule fois (au niveau agregat)', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1), recoveryHash(2)], clock, idGenerator });
      enrollment.pullDomainEvents();

      const first = enrollment.consumeRecoveryCode({ hash: recoveryHash(1), clock, idGenerator });
      expect(first.isSuccess()).toBe(true);
      expect(enrollment.pullDomainEvents().map((e) => e.eventType)).toEqual(['identity.mfa-enrollment.recovery-code-consumed']);

      const second = enrollment.consumeRecoveryCode({ hash: recoveryHash(1), clock, idGenerator });
      expect(mustFail(second)).toBe('RECOVERY_CODE_ALREADY_CONSUMED');
    });

    it('refuse un code inconnu (RECOVERY_CODE_NOT_FOUND)', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });

      const result = enrollment.consumeRecoveryCode({ hash: recoveryHash(99), clock, idGenerator });
      expect(mustFail(result)).toBe('RECOVERY_CODE_NOT_FOUND');
    });

    it('emet MfaRecoveryCodesExhausted quand le DERNIER code disponible est consomme', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });
      enrollment.pullDomainEvents();

      enrollment.consumeRecoveryCode({ hash: recoveryHash(1), clock, idGenerator });
      const events = enrollment.pullDomainEvents().map((e) => e.eventType);
      expect(events).toEqual([
        'identity.mfa-enrollment.recovery-code-consumed',
        'identity.mfa-enrollment.recovery-codes-exhausted',
      ]);
    });
  });

  describe('regenerateRecoveryCodes', () => {
    it('refuse sur un enrolement non ACTIVE (ENROLLMENT_NOT_ACTIVE)', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);

      const result = enrollment.regenerateRecoveryCodes({ hashes: [recoveryHash(1)], clock, idGenerator });
      expect(mustFail(result)).toBe('ENROLLMENT_NOT_ACTIVE');
    });

    it('remplace INTEGRALEMENT le jeu de codes et emet MfaRecoveryCodesRegenerated', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });
      enrollment.pullDomainEvents();

      const result = enrollment.regenerateRecoveryCodes({ hashes: [recoveryHash(10), recoveryHash(11)], clock, idGenerator });
      expect(result.isSuccess()).toBe(true);
      expect(enrollment.recoveryCodes).toHaveLength(2);
      expect(enrollment.recoveryCodes.some((c) => c.matches(recoveryHash(1)))).toBe(false);
      expect(enrollment.pullDomainEvents().map((e) => e.eventType)).toEqual([
        'identity.mfa-enrollment.recovery-codes-regenerated',
      ]);
    });
  });

  describe('forceReEnrollment', () => {
    it('refuse un motif vide (REASON_REQUIRED)', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1)], clock, idGenerator });

      const result = enrollment.forceReEnrollment({ requestedByUserId: idFor.userAccount(2).toString(), reason: '   ', clock, idGenerator });
      expect(mustFail(result)).toBe('REASON_REQUIRED');
      expect(enrollment.status).toBe('ACTIVE');
    });

    it('replace TOUJOURS le compte en RESET_REQUIRED (jamais un etat "MFA non requis") et revoque le facteur + les codes', () => {
      const clock = new FixedClock('2026-08-26T10:00:00Z');
      const idGenerator = new SequentialIdGenerator();
      const enrollment = startEnrollment(clock, idGenerator);
      enrollment.confirmEnrollment({ timeStep: 1, recoveryCodes: [recoveryHash(1), recoveryHash(2)], clock, idGenerator });
      enrollment.pullDomainEvents();

      const result = enrollment.forceReEnrollment({
        requestedByUserId: idFor.userAccount(2).toString(),
        reason: 'perte du telephone, identite verifiee en agence',
        clock,
        idGenerator,
      });

      expect(result.isSuccess()).toBe(true);
      expect(enrollment.status).toBe('RESET_REQUIRED');
      expect(enrollment.isActive()).toBe(false);
      expect(enrollment.isChallengeable(clock.now())).toBe(false);
      expect(enrollment.activeSecret).toBeNull();
      expect(enrollment.recoveryCodes).toHaveLength(0);
      const events = enrollment.pullDomainEvents();
      expect(events.map((e) => e.eventType)).toEqual(['identity.mfa-enrollment.re-enrollment-forced']);
      // Le motif n'est JAMAIS porte par l'evenement de domaine (ADR-0005 §6) — seul AuditEntry le
      // recoit (voir application/commands/ForceMfaReEnrollment.ts).
      expect((events[0] as unknown as { reason?: unknown }).reason).toBeUndefined();
    });
  });

  it("n'expose aucune methode disable/deactivate (O-04.5 : aucune desactivation silencieuse)", () => {
    const prototype = MfaEnrollment.prototype as unknown as Record<string, unknown>;
    expect(typeof prototype['disable']).toBe('undefined');
    expect(typeof prototype['deactivate']).toBe('undefined');
    expect(typeof prototype['disableMfa']).toBe('undefined');
  });
});
