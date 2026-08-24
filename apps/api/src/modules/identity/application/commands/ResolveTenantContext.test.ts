import { beforeEach, describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  idFor,
  InMemoryRoleRepository,
  InMemorySessionStore,
  InMemoryTenantAccessChecker,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Role } from '../../domain/Role.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { ResolveTenantContextHandler } from './ResolveTenantContext.js';
import type { TenantSessionContext } from '../ports/SessionStore.js';

const TENANT_A = TenantId.create(uuidAt(6001)).getValue();
const TENANT_B = TenantId.create(uuidAt(6002)).getValue();

function permission(code: string): Permission {
  return Permission.create(code).getValue();
}

describe('ResolveTenantContextHandler', () => {
  let accounts: InMemoryUserAccountRepository;
  let memberships: InMemoryUserTenantMembershipRepository;
  let roles: InMemoryRoleRepository;
  let sessions: InMemorySessionStore;
  let tenants: InMemoryTenantAccessChecker;
  let handler: ResolveTenantContextHandler;
  let clock: FixedClock;
  let idGenerator: SequentialIdGenerator;

  beforeEach(() => {
    accounts = new InMemoryUserAccountRepository();
    memberships = new InMemoryUserTenantMembershipRepository();
    roles = new InMemoryRoleRepository();
    sessions = new InMemorySessionStore();
    tenants = new InMemoryTenantAccessChecker();
    // Les tenants utilises par la grande majorite des scenarios de cette suite existent deja
    // (le comportement "tenant absent" a sa propre suite dediee ci-dessous, sur un tenant non
    // seed ici).
    tenants.seed(TENANT_A);
    tenants.seed(TENANT_B);
    clock = new FixedClock('2026-08-23T10:00:00Z');
    idGenerator = new SequentialIdGenerator();
    handler = new ResolveTenantContextHandler(
      accounts,
      memberships,
      roles,
      sessions,
      tenants,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );
  });

  async function registerStandardUser(): Promise<UserAccount> {
    const account = UserAccount.register({
      email: Email.create('user@hopital.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(account);
    return account;
  }

  it('un utilisateur avec deux memberships actifs dans deux etablissements peut selectionner l_un OU l_autre', async () => {
    const account = await registerStandardUser();
    const medecin = Role.system({ id: idFor.role(1), code: 'MEDECIN', name: 'Medecin', permissions: [permission('patient:read')] });
    roles.seed(medecin);

    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_A, createdBy: account.id, initialRoleIds: [medecin.id], clock, idGenerator }),
      TENANT_A,
    );
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_B, createdBy: account.id, initialRoleIds: [medecin.id], clock, idGenerator }),
      TENANT_B,
    );

    const resultA = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    const resultB = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: TENANT_B.toString() } });

    expect(resultA.isSuccess()).toBe(true);
    expect(resultB.isSuccess()).toBe(true);
    const sessionA = resultA.getValue().session as TenantSessionContext;
    const sessionB = resultB.getValue().session as TenantSessionContext;
    expect(sessionA.tenantId).toBe(TENANT_A.toString());
    expect(sessionB.tenantId).toBe(TENANT_B.toString());
  });

  it('calcule les permissions effectives et requiresMfa a partir des roles du membership', async () => {
    const account = await registerStandardUser();
    const infirmier = Role.system({ id: idFor.role(2), code: 'INFIRMIER', name: 'Infirmier', permissions: [permission('patient:read')] });
    const adminTenant = Role.system({ id: idFor.role(3), code: 'ADMIN_ETABLISSEMENT', name: 'Admin', permissions: [permission('membership:administer')] });
    roles.seed(infirmier);
    roles.seed(adminTenant);

    await memberships.save(
      UserTenantMembership.grant({
        userId: account.id,
        tenantId: TENANT_A,
        createdBy: account.id,
        initialRoleIds: [infirmier.id, adminTenant.id],
        clock,
        idGenerator,
      }),
      TENANT_A,
    );

    const result = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isSuccess()).toBe(true);
    const session = result.getValue().session as TenantSessionContext;
    expect(new Set(session.permissionCodes)).toEqual(new Set(['patient:read', 'membership:administer']));
    expect(session.requiresMfa).toBe(true);
  });

  it("refuse un tenantId qui ne correspond a aucun HealthFacility existant (TENANT_NOT_FOUND avant meme la verification du membership)", async () => {
    const account = await registerStandardUser();
    const ghostTenant = TenantId.create(uuidAt(6099)).getValue();
    // Volontairement NON seed dans `tenants` : simule un tenant inexistant (ou un membership
    // orphelin d'un tenant supprime par une voie hors perimetre de ce module).
    const medecin = Role.system({ id: idFor.role(5), code: 'MEDECIN', name: 'Medecin', permissions: [permission('patient:read')] });
    roles.seed(medecin);
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: ghostTenant, createdBy: account.id, initialRoleIds: [medecin.id], clock, idGenerator }),
      ghostTenant,
    );

    const result = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: ghostTenant.toString() } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('TENANT_NOT_FOUND');
  });

  it("refuse l'ouverture d'un NOUVEAU contexte pour un tenant SUSPENDED, meme avec un membership actif valide (arbitrage architecte, 2026-08-24)", async () => {
    const account = await registerStandardUser();
    const suspendedTenant = TenantId.create(uuidAt(6098)).getValue();
    tenants.seed(suspendedTenant, 'SUSPENDED');
    const medecin = Role.system({ id: idFor.role(6), code: 'MEDECIN', name: 'Medecin', permissions: [permission('patient:read')] });
    roles.seed(medecin);
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: suspendedTenant, createdBy: account.id, initialRoleIds: [medecin.id], clock, idGenerator }),
      suspendedTenant,
    );

    const result = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: suspendedTenant.toString() } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('TENANT_SUSPENDED');
  });

  it('refuse un tenantId dont l_utilisateur n_est pas membre', async () => {
    const account = await registerStandardUser();
    const result = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
  });

  it('refuse un contexte pour un membership revoque', async () => {
    const account = await registerStandardUser();
    const membership = UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_A, createdBy: account.id, initialRoleIds: [], clock, idGenerator });
    membership.revoke(clock, idGenerator);
    await memberships.save(membership, TENANT_A);

    const result = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
  });

  it('un contexte PLATFORM exige platformRole = SUPER_ADMIN', async () => {
    const account = await registerStandardUser();
    const result = await handler.execute({ userId: account.id.toString(), intent: { kind: 'PLATFORM' } });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('NOT_SUPER_ADMIN');
  });

  it('un SUPER_ADMIN ouvre un contexte PLATFORM avec requiresMfa toujours vrai', async () => {
    const superAdmin = UserAccount.register({
      email: Email.create('super@plateforme.sn').getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'SUPER_ADMIN',
      clock,
      idGenerator,
    });
    await accounts.save(superAdmin);

    const result = await handler.execute({ userId: superAdmin.id.toString(), intent: { kind: 'PLATFORM' } });
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().session.requiresMfa).toBe(true);
  });

  it("le changement d'etablissement ferme le contexte courant et en ouvre un nouveau, sans etat partage", async () => {
    const account = await registerStandardUser();
    const roleA = Role.system({ id: idFor.role(4), code: 'MEDECIN', name: 'Medecin', permissions: [permission('patient:read')] });
    roles.seed(roleA);
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_A, createdBy: account.id, initialRoleIds: [roleA.id], clock, idGenerator }),
      TENANT_A,
    );
    await memberships.save(
      UserTenantMembership.grant({ userId: account.id, tenantId: TENANT_B, createdBy: account.id, initialRoleIds: [roleA.id], clock, idGenerator }),
      TENANT_B,
    );

    const first = await handler.execute({ userId: account.id.toString(), intent: { kind: 'TENANT', tenantId: TENANT_A.toString() } });
    const firstSessionId = first.getValue().session.sessionId;
    expect(await sessions.get(firstSessionId)).not.toBeNull();

    const second = await handler.execute({
      userId: account.id.toString(),
      intent: { kind: 'TENANT', tenantId: TENANT_B.toString() },
      previousSessionId: firstSessionId,
    });

    expect(second.isSuccess()).toBe(true);
    const secondSession = second.getValue().session as TenantSessionContext;
    expect(secondSession.sessionId).not.toBe(firstSessionId);
    expect(secondSession.tenantId).toBe(TENANT_B.toString());
    // L'ancien contexte est ferme (plus dans le store) : aucun etat partage entre les deux.
    expect(await sessions.get(firstSessionId)).toBeNull();
    expect(await sessions.get(secondSession.sessionId)).not.toBeNull();
  });
});
