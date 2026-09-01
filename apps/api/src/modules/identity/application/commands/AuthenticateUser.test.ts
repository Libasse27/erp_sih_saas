import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FakePasswordHasher,
  FixedClock,
  InMemoryMfaBypassAttemptGuard,
  InMemorySessionAuditTrail,
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
  let sessionAuditTrail: InMemorySessionAuditTrail;
  let loginFailureAttemptGuard: InMemoryMfaBypassAttemptGuard;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    hasher = new FakePasswordHasher();
    clock = new FixedClock('2026-08-23T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    sessionAuditTrail = new InMemorySessionAuditTrail();
    loginFailureAttemptGuard = new InMemoryMfaBypassAttemptGuard();
    handler = new AuthenticateUserHandler(
      accounts,
      memberships,
      hasher,
      new InMemoryUnitOfWork(),
      sessionAuditTrail,
      loginFailureAttemptGuard,
    );
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

  it('ecrit SESSION_LOGIN_SUCCEEDED (ADR-0009 §2.1) a une authentification reussie', async () => {
    await registerAccount('medecin2@hopital.sn', 'mot-de-passe-2');

    await handler.execute({ email: 'medecin2@hopital.sn', plainPassword: 'mot-de-passe-2' });

    expect(sessionAuditTrail.records).toHaveLength(1);
    expect(sessionAuditTrail.records[0]).toMatchObject({ eventType: 'SESSION_LOGIN_SUCCEEDED', outcome: 'SUCCESS', tenantId: null });
  });

  it('ecrit SESSION_LOGIN_FAILED (compte existant) sur mot de passe incorrect, une seule fois par fenetre de dedup', async () => {
    await registerAccount('medecin3@hopital.sn', 'bon-mdp');

    await handler.execute({ email: 'medecin3@hopital.sn', plainPassword: 'mauvais' });
    await handler.execute({ email: 'medecin3@hopital.sn', plainPassword: 'mauvais-encore' });

    expect(sessionAuditTrail.records).toHaveLength(1);
    expect(sessionAuditTrail.records[0]).toMatchObject({ eventType: 'SESSION_LOGIN_FAILED', outcome: 'FAILURE' });
  });

  it("n'ecrit AUCUNE entree pour un identifiant inconnu (minimisation, ADR-0009 §2.1)", async () => {
    await handler.execute({ email: 'inconnu2@hopital.sn', plainPassword: 'quelconque' });
    expect(sessionAuditTrail.records).toHaveLength(0);
  });
});
