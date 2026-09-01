import { describe, expect, it } from 'vitest';
import type { OutboxEventEnvelope } from '../../../../shared-kernel/application/OutboxEventHandler.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  idFor,
  InMemoryMembershipAuditTrail,
  InMemoryRoleRepository,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { GrantMembershipHandler } from '../commands/GrantMembership.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Role } from '../../domain/Role.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { createGrantOwnerMembershipOnSubscriptionStartedHandler } from './GrantOwnerMembershipOnSubscriptionStarted.js';

const TENANT_A = uuidAt(9101);

describe('GrantOwnerMembershipOnSubscriptionStarted (ADR-0008 §1/§4/§9, resequencement F3)', () => {
  async function build() {
    const accounts = new InMemoryUserAccountRepository();
    const memberships = new InMemoryUserTenantMembershipRepository();
    const roles = new InMemoryRoleRepository();
    const clock = new FixedClock('2026-08-28T00:00:00.000Z');
    const idGenerator = new SequentialIdGenerator();

    roles.seed(
      Role.system({
        id: idFor.role(1),
        code: 'ADMIN_ETABLISSEMENT',
        name: 'Administrateur etablissement',
        permissions: [Permission.create('facility:manage').getValue()],
      }),
    );

    const owner = UserAccount.register({
      email: Email.create('proprietaire@hopital.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(owner);

    const grantMembershipHandler = new GrantMembershipHandler(
      accounts,
      memberships,
      roles,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
      new InMemoryMembershipAuditTrail(),
    );
    const handler = createGrantOwnerMembershipOnSubscriptionStartedHandler({ grantMembershipHandler });
    return { handler, memberships, owner };
  }

  function envelope(ownerUserId: string, overrides: Partial<OutboxEventEnvelope> = {}): OutboxEventEnvelope {
    return {
      id: uuidAt(1),
      eventType: 'subscription.subscription.started',
      eventVersion: 1,
      aggregateId: uuidAt(2),
      tenantId: TENANT_A,
      occurredAt: new Date('2026-08-28T00:00:00.000Z'),
      payload: { planId: uuidAt(3), trialEndsAt: '2026-09-27T00:00:00.000Z', ownerUserId },
      ...overrides,
    };
  }

  it('accorde ADMIN_ETABLISSEMENT au proprietaire porte par SubscriptionStarted.ownerUserId', async () => {
    const { handler, memberships, owner } = await build();

    await handler(envelope(owner.id.toString()));

    const tenantId = TenantId.create(TENANT_A).getValue();
    const membership = await memberships.findActiveByUserAndTenant(owner.id, tenantId);
    expect(membership).not.toBeNull();
    expect(membership?.userId.equals(owner.id)).toBe(true);
  });

  it("leve si tenantId est absent de l'enveloppe", async () => {
    const { handler, owner } = await build();
    await expect(handler(envelope(owner.id.toString(), { tenantId: null }))).rejects.toThrow();
  });

  it('leve une erreur explicite (jamais silencieuse) si ownerUserId est absent du payload — jamais une identite devinee (ADR-0008 §9, amendement 1)', async () => {
    const { handler } = await build();
    await expect(
      handler(envelope('', { payload: { planId: uuidAt(3), trialEndsAt: null } })),
    ).rejects.toThrow();
  });

  it("redelivrance (meme evenement) : idempotent — MEMBERSHIP_ALREADY_EXISTS traite comme succes, aucun doublon", async () => {
    const { handler, memberships, owner } = await build();
    const env = envelope(owner.id.toString());

    await handler(env);
    await handler(env);

    const tenantId = TenantId.create(TENANT_A).getValue();
    expect(await memberships.countActive(tenantId)).toBe(1);
  });

  it('leve une erreur explicite si ownerUserId ne correspond a aucun UserAccount (anomalie — deja verifie par CreateHealthFacilityHandler en amont)', async () => {
    const { handler } = await build();
    await expect(handler(envelope(idFor.userAccount(999).toString()))).rejects.toThrow(/USER_NOT_FOUND/);
  });
});
