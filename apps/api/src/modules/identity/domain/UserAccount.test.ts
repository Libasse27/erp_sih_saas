import { describe, expect, it } from 'vitest';
import { FixedClock, SequentialIdGenerator } from '../../../../test/identity/builders/testKit.js';
import { UserAccount } from './UserAccount.js';
import { Email } from './value-objects/Email.js';
import { PasswordHash } from './value-objects/PasswordHash.js';

describe('UserAccount', () => {
  it("porte l'identite globale sans tenantId et emet UserAccountCreated", () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const email = Email.create('medecin@hopital.sn').getValue();
    const passwordHash = PasswordHash.fromHash('hash').getValue();

    const account = UserAccount.register({ email, passwordHash, platformRole: 'NONE', clock, idGenerator });

    expect(account.email.equals(email)).toBe(true);
    expect(account.isSuperAdmin()).toBe(false);
    expect(account.createdAt).toEqual(new Date('2026-08-23T10:00:00Z'));

    const events = account.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('identity.user-account.created');
    expect(events[0]?.tenantId).toBeNull();
  });

  it('un SUPER_ADMIN est identifie par un statut plateforme explicite, pas par une inference implicite', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const account = UserAccount.register({
      email: Email.create('super-admin@plateforme.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'SUPER_ADMIN',
      clock,
      idGenerator,
    });

    expect(account.isSuperAdmin()).toBe(true);
  });

  it('pullDomainEvents vide la liste (appel unique)', () => {
    const clock = new FixedClock('2026-08-23T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const account = UserAccount.register({
      email: Email.create('x@y.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });

    account.pullDomainEvents();
    expect(account.pullDomainEvents()).toHaveLength(0);
  });
});
