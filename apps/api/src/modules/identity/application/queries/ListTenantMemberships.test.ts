import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryRoleRepository,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/identity/builders/testKit.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Role } from '../../domain/Role.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { UserTenantMembership } from '../../domain/UserTenantMembership.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { Permission } from '../../domain/value-objects/Permission.js';
import { RoleId } from '../../domain/value-objects/RoleId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import { encodeMembershipCursor } from '../../domain/MembershipCursor.js';
import type { MembershipAdminPrincipal } from '../MembershipAdminPrincipal.js';
import { ListTenantMembershipsHandler } from './ListTenantMemberships.js';

const TENANT_ID = uuidAt(1);
const OTHER_TENANT_ID = uuidAt(2);
const ACTOR_ID = uuidAt(3);

function principalFor(tenantId: string, permissionCodes: readonly string[]): MembershipAdminPrincipal {
  return { kind: 'TENANT', actorUserId: ACTOR_ID, tenantId, roleCodes: ['ADMIN_ETABLISSEMENT'], permissionCodes };
}

describe('ListTenantMembershipsHandler', () => {
  function buildFixture() {
    const clock = new FixedClock('2026-09-28T10:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const userAccounts = new InMemoryUserAccountRepository();
    const memberships = new InMemoryUserTenantMembershipRepository();
    const roles = new InMemoryRoleRepository();
    const unitOfWork = new InMemoryUnitOfWork();
    const handler = new ListTenantMembershipsHandler(memberships, userAccounts, roles, unitOfWork);

    const medecinRole = Role.system({
      id: RoleId.create(uuidAt(9001)).getValue(),
      code: 'MEDECIN',
      name: 'Medecin',
      permissions: [Permission.create('patient:read').getValue()],
    });
    roles.seed(medecinRole);

    return { clock, idGenerator, userAccounts, memberships, roles, unitOfWork, handler, medecinRole };
  }

  async function seedMember(
    fixture: ReturnType<typeof buildFixture>,
    params: { emailLocalPart: string; tenantId: string; roleIds?: readonly RoleId[] },
  ): Promise<{ userId: string; membershipId: string }> {
    const account = UserAccount.register({
      email: Email.create(`${params.emailLocalPart}@hopital-test.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock: fixture.clock,
      idGenerator: fixture.idGenerator,
    });
    await fixture.userAccounts.save(account);

    const tenant = TenantId.create(params.tenantId).getValue();
    const membership = UserTenantMembership.grant({
      userId: account.id,
      tenantId: tenant,
      createdBy: account.id,
      initialRoleIds: params.roleIds ?? [],
      clock: fixture.clock,
      idGenerator: fixture.idGenerator,
    });
    await fixture.memberships.save(membership, tenant);

    return { userId: account.id.toString(), membershipId: membership.id.toString() };
  }

  it('retourne les memberships du tenant courant, enrichis d_email et de roleCodes, pour une session TENANT autorisee', async () => {
    const fixture = buildFixture();
    const seeded = await seedMember(fixture, {
      emailLocalPart: 'medecin-un',
      tenantId: TENANT_ID,
      roleIds: [fixture.medecinRole.id],
    });

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: null,
      limit: 50,
    });

    expect(result.isSuccess()).toBe(true);
    const page = result.getValue();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      membershipId: seeded.membershipId,
      userId: seeded.userId,
      email: 'medecin-un@hopital-test.sn',
      roleCodes: ['MEDECIN'],
      status: 'ACTIVE',
      joinedAt: new Date('2026-09-28T10:00:00Z'),
      leftAt: null,
    });
    expect(page.nextCursor).toBeNull();
    // Lecture tenant-scopee : DOIT passer par une transaction positionnant app.tenant_id (RLS).
    expect(fixture.unitOfWork.lastContext?.tenantId?.equals(TenantId.create(TENANT_ID).getValue())).toBe(true);
  });

  it('ne retourne JAMAIS les memberships d_un AUTRE tenant, meme presents dans le meme repository', async () => {
    const fixture = buildFixture();
    await seedMember(fixture, { emailLocalPart: 'membre-a', tenantId: TENANT_ID });
    await seedMember(fixture, { emailLocalPart: 'membre-b', tenantId: OTHER_TENANT_ID });

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: null,
      limit: 50,
    });

    expect(result.isSuccess()).toBe(true);
    const page = result.getValue();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.email).toBe('membre-a@hopital-test.sn');
  });

  it('filtre par status : seuls les memberships du statut demande sont retournes', async () => {
    const fixture = buildFixture();
    await seedMember(fixture, { emailLocalPart: 'actif', tenantId: TENANT_ID });

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      status: 'REVOKED',
      cursor: null,
      limit: 50,
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().items).toHaveLength(0);
  });

  it('refuse (FORBIDDEN) une session TENANT sans membership:administer', async () => {
    const fixture = buildFixture();
    await seedMember(fixture, { emailLocalPart: 'peu-importe', tenantId: TENANT_ID });

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['cash-register:open']),
      cursor: null,
      limit: 50,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('refuse EXPLICITEMENT (FORBIDDEN) une session PLATFORM', async () => {
    const fixture = buildFixture();

    const result = await fixture.handler.execute({
      principal: { kind: 'PLATFORM', actorUserId: ACTOR_ID },
      cursor: null,
      limit: 50,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');
  });

  it('refuse (INVALID_QUERY) une limite hors bornes (0), jamais un plafonnement silencieux', async () => {
    const fixture = buildFixture();

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: null,
      limit: 0,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_QUERY');
  });

  it('refuse (INVALID_QUERY) une limite hors bornes (201), jamais un plafonnement silencieux', async () => {
    const fixture = buildFixture();

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: null,
      limit: 201,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_QUERY');
  });

  it('refuse (INVALID_QUERY) un curseur malforme — jamais une exception non geree', async () => {
    const fixture = buildFixture();

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: 'curseur-invalide-non-base64json',
      limit: 50,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_QUERY');
  });

  it('pagine par curseur keyset : une deuxieme page reprend exactement ou la premiere s_est arretee', async () => {
    const fixture = buildFixture();
    const first = await seedMember(fixture, { emailLocalPart: 'page-un', tenantId: TENANT_ID });
    fixture.clock.advanceMs(1000);
    const second = await seedMember(fixture, { emailLocalPart: 'page-deux', tenantId: TENANT_ID });

    const firstPage = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: null,
      limit: 1,
    });
    expect(firstPage.isSuccess()).toBe(true);
    const firstPageValue = firstPage.getValue();
    expect(firstPageValue.items).toHaveLength(1);
    // Tri le plus recent en premier (meme convention que ListAuditEntries) : "page-deux" (joignit
    // en dernier) sort avant "page-un".
    expect(firstPageValue.items[0]?.userId).toBe(second.userId);
    expect(firstPageValue.nextCursor).not.toBeNull();

    const secondPage = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: firstPageValue.nextCursor,
      limit: 1,
    });
    expect(secondPage.isSuccess()).toBe(true);
    const secondPageValue = secondPage.getValue();
    expect(secondPageValue.items).toHaveLength(1);
    expect(secondPageValue.items[0]?.userId).toBe(first.userId);
    expect(secondPageValue.nextCursor).toBeNull();
  });

  it(
    'leve une erreur (invariant viole, jamais une degradation silencieuse) quand un membership ne correspond a aucun UserAccount',
    async () => {
      const fixture = buildFixture();
      const tenant = TenantId.create(TENANT_ID).getValue();
      const orphanMembership = UserTenantMembership.grant({
        userId: UserAccount.register({
          email: Email.create('fantome@hopital-test.sn').getValue(),
          passwordHash: PasswordHash.fromHash('hash').getValue(),
          platformRole: 'NONE',
          clock: fixture.clock,
          idGenerator: fixture.idGenerator,
        }).id,
        tenantId: tenant,
        createdBy: UserAccountId.create(uuidAt(777)).getValue(),
        initialRoleIds: [],
        clock: fixture.clock,
        idGenerator: fixture.idGenerator,
      });
      // Le UserAccount n'est PAS sauvegarde ici, volontairement — reproduit l'invariant viole
      // (corruption de donnees, jamais un cas metier attendu).
      await fixture.memberships.save(orphanMembership, tenant);

      await expect(
        fixture.handler.execute({
          principal: principalFor(TENANT_ID, ['membership:administer']),
          cursor: null,
          limit: 50,
        }),
      ).rejects.toThrow(/aucun UserAccount pour membership.userId/);
    },
  );

  it('un curseur valide pointant deja au-dela du dernier membership (tri DESC) ne fait pas planter la pagination — page vide', async () => {
    const fixture = buildFixture();
    await seedMember(fixture, { emailLocalPart: 'seul-membre', tenantId: TENANT_ID });

    // Tri `(joinedAt DESC, id DESC)` : un curseur tres ANCIEN signifie "j_ai deja vu tout ce qui
    // est plus recent" — la page suivante ne contient donc que des lignes ENCORE PLUS anciennes,
    // ici aucune.
    const farPastCursor = encodeMembershipCursor({ joinedAt: '2000-01-01T00:00:00.000Z', id: uuidAt(1) });

    const result = await fixture.handler.execute({
      principal: principalFor(TENANT_ID, ['membership:administer']),
      cursor: farPastCursor,
      limit: 50,
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().items).toHaveLength(0);
  });
});
