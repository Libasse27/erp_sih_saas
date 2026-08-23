import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FakePasswordHasher,
  FixedClock,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Email } from '../../domain/value-objects/Email.js';
import { AuthenticateUserHandler } from './AuthenticateUser.js';

const TENANT_A = TenantId.create(uuidAt(3001)).getValue();
const TENANT_B = TenantId.create(uuidAt(3002)).getValue();

describe('AuthenticateUserHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let hasher: FakePasswordHasher;
  let handler: AuthenticateUserHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    hasher = new FakePasswordHasher();
    clock = new FixedClock('2026-08-23T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new AuthenticateUserHandler(accounts, memberships, hasher, new InMemoryUnitOfWork());
  });

  async function registerAccount(email: string, plainPassword: string): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create(email).getValue(),
      passwordHash: await hasher.hash(plainPassword),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    return account;
  }

  it('authentifie avec les bons identifiants et liste les tenants ou le membership est actif', async () => {
    const account = await registerAccount('medecin@hopital.sn', 'mot-de-passe-1');
    await memberships.save(
      UserTenantMembership.grant({
        userId: account.id,
        tenantId: TENANT_A,
        createdBy: account.id,
        initialRoleIds: [],
        clock,
        idGenerator,
      }),
      TENANT_A,
    );
    await memberships.save(
      UserTenantMembership.grant({
        userId: account.id,
        tenantId: TENANT_B,
        createdBy: account.id,
        initialRoleIds: [],
        clock,
        idGenerator,
      }),
      TENANT_B,
    );

    const result = await handler.execute({ email: 'medecin@hopital.sn', plainPassword: 'mot-de-passe-1' });

    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.isSuperAdmin).toBe(false);
    expect(new Set(value.activeTenantIds)).toEqual(new Set([TENANT_A.toString(), TENANT_B.toString()]));
  });

  it('un SUPER_ADMIN authentifie ne porte jamais de membership (activeTenantIds toujours vide)', async () => {
    const account = UserAccount.register({
      email: Email.create('super@plateforme.sn').getValue(),
      passwordHash: await hasher.hash('mdp-super'),
      platformRole: 'SUPER_ADMIN',
      clock,
      idGenerator,
    });
    await accounts.save(account);

    const result = await handler.execute({ email: 'super@plateforme.sn', plainPassword: 'mdp-super' });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().isSuperAdmin).toBe(true);
    expect(result.getValue().activeTenantIds).toEqual([]);
  });

  it('rejette un mot de passe incorrect avec une erreur generique', async () => {
    await registerAccount('user@hopital.sn', 'bon-mot-de-passe');
    const result = await handler.execute({ email: 'user@hopital.sn', plainPassword: 'mauvais-mot-de-passe' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_CREDENTIALS');
  });

  it('rejette un email inconnu avec la MEME erreur generique (anti-enumeration)', async () => {
    const result = await handler.execute({ email: 'inconnu@hopital.sn', plainPassword: 'quelconque123' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_CREDENTIALS');
  });
});
