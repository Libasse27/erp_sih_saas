import { describe, expect, it } from 'vitest';
import { TenantId } from '../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Result } from '../../src/shared-kernel/domain/Result.js';
import { SYSTEM_ROLE_CATALOG, type SystemRoleDefinition } from '../../src/modules/identity/domain/SystemRoleCatalog.js';
import { authorizeAuditRead } from '../../src/modules/audit/application/AuthorizeAuditRead.js';
import type { AuditReadPrincipal } from '../../src/modules/audit/application/AuditReadPrincipal.js';
import { ForceMfaReEnrollmentHandler, type ForceMfaReEnrollmentError } from '../../src/modules/identity/application/commands/ForceMfaReEnrollment.js';
import { MfaEnrollment } from '../../src/modules/identity/domain/MfaEnrollment.js';
import { UserAccount } from '../../src/modules/identity/domain/UserAccount.js';
import { UserTenantMembership } from '../../src/modules/identity/domain/UserTenantMembership.js';
import { Email } from '../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { EncryptedTotpSecret } from '../../src/modules/identity/domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../src/modules/identity/domain/value-objects/RecoveryCodeHash.js';
import type { TenantSessionContext } from '../../src/modules/identity/application/ports/SessionStore.js';
import {
  buildTestRefreshTokenIssuer,
  FixedClock,
  idFor,
  InMemoryAuditTrail,
  InMemoryMfaEnrollmentRepository,
  InMemoryRoleRepository,
  InMemorySessionStore,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  InMemoryUserTenantMembershipRepository,
  SequentialIdGenerator,
  uuidAt,
} from '../identity/builders/testKit.js';

/**
 * Matrice RBAC exhaustive (Phase 0, etape 12/13 — lacune A de l'audit de securite) : preuve
 * SYSTEMATIQUE que, pour CHAQUE operation protegee par une permission existant reellement dans
 * le code, CHAQUE role systeme du catalogue (`SystemRoleCatalog.ts`, source de verite unique) qui
 * ne porte PAS la permission requise se voit refuser cette operation, et que le (ou les) role(s)
 * qui la portent l'obtiennent. Critere de sortie commun a toute phase (roadmap
 * §"Criteres de sortie communs" : "RBAC — Chaque role non autorise est refuse sur chaque
 * operation").
 *
 * Perimetre couvert : les DEUX SEULES operations reellement gardees par une verification de
 * permission a ce stade du depot (verifie par recherche exhaustive de
 * `permissionCodes.includes(...)` dans src/) :
 *   1. `audit:read` — `authorizeAuditRead` (module audit), exposee par `GET /api/v1/audit-entries`.
 *   2. `mfa:reset` — `ForceMfaReEnrollmentHandler.isAuthorized` (module identity), non encore
 *      exposee par un endpoint HTTP interactif (voir le rapport de l'etape 7/13), mais deja une
 *      operation metier reelle et gardee.
 * `GrantMembershipHandler`/`RevokeMembershipHandler` ne portent AUCUNE verification de permission
 * a ce stade (aucun endpoint interactif ne les invoque encore — seuls la Saga de provisioning et
 * des appels systeme le font) : les inclure ici produirait une matrice qui teste une regle qui
 * n'existe pas dans le code, contrairement a la consigne "base-toi sur le catalogue de permissions
 * REEL". A etendre des qu'un endpoint de gestion interactive des memberships/roles sera livre.
 *
 * `SUPER_ADMIN` est EXCLU de la boucle : il n'est JAMAIS rattache via un `UserTenantMembership`
 * (voir `SystemRoleCatalog.ts` et `UserAccount.ts` — son autorisation plateforme decoule de
 * `principal.kind === 'PLATFORM'`, jamais d'une permission testee dans une session TENANT). Le
 * bypass PLATFORM des deux operations ci-dessous est deja couvert par des tests dedies
 * (`auditQueryIsolation.test.ts`, `ForceMfaReEnrollment.test.ts` — cas "succes (acteur PLATFORM...)")
 * et n'a pas a etre reteste ici : cette matrice porte specifiquement sur les 17 roles TENANT.
 *
 * Aucune I/O (doublures en memoire uniquement, memes classes REELLES que
 * `ForceMfaReEnrollment.test.ts`/`tenantAccessCheckerComposition.test.ts`) — la regle de decision
 * est testee, pas la persistance (deja couverte par `mfaEnrollmentRepository.test.ts`,
 * `auditHttpIsolation.test.ts`, etc.).
 */

const TENANT_ROLES: readonly SystemRoleDefinition[] = SYSTEM_ROLE_CATALOG.filter(
  (role) => role.code !== 'SUPER_ADMIN',
);

describe('Garde-fou catalogue — la matrice ne peut pas degenerer silencieusement', () => {
  it('le catalogue systeme contient bien 18 roles, dont 17 attribuables via UserTenantMembership', () => {
    expect(SYSTEM_ROLE_CATALOG).toHaveLength(18);
    expect(TENANT_ROLES).toHaveLength(17);
  });

  it('au moins un role TENANT porte audit:read et au moins un porte mfa:reset (sinon la matrice refuserait tout, faussement verte)', () => {
    expect(TENANT_ROLES.some((role) => role.permissionCodes.includes('audit:read'))).toBe(true);
    expect(TENANT_ROLES.some((role) => role.permissionCodes.includes('mfa:reset'))).toBe(true);
  });
});

describe('Matrice RBAC — GET /api/v1/audit-entries (permission audit:read, authorizeAuditRead)', () => {
  function principalFor(role: SystemRoleDefinition): AuditReadPrincipal {
    return {
      kind: 'TENANT',
      actorUserId: uuidAt(1),
      tenantId: uuidAt(2),
      roleCodes: [role.code],
      permissionCodes: role.permissionCodes,
    };
  }

  for (const role of TENANT_ROLES) {
    const expectAllowed = role.permissionCodes.includes('audit:read');
    it(`${role.code} — ${expectAllowed ? 'AUTORISE' : 'REFUSE'} (permissionCodes du catalogue : [${role.permissionCodes.join(', ')}])`, () => {
      const result = authorizeAuditRead(principalFor(role), null);
      expect(result.isSuccess()).toBe(expectAllowed);
      if (!expectAllowed) {
        expect(result.isFailure() && result.getError()).toBe('MISSING_PERMISSION');
      }
    });
  }

  it("un membership sans aucun role assigne (permissionCodes vide) est refuse — deni par defaut, jamais un acces implicite", () => {
    const principal: AuditReadPrincipal = {
      kind: 'TENANT',
      actorUserId: uuidAt(1),
      tenantId: uuidAt(2),
      roleCodes: [],
      permissionCodes: [],
    };
    const result = authorizeAuditRead(principal, null);
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('MISSING_PERMISSION');
  });
});

describe('Matrice RBAC — ForceMfaReEnrollment (permission mfa:reset, module identity)', () => {
  async function checkMfaReset(role: SystemRoleDefinition): Promise<Result<void, ForceMfaReEnrollmentError>> {
    const clock = new FixedClock('2026-09-01T09:00:00Z');
    const idGenerator = new SequentialIdGenerator();
    const accounts = new InMemoryUserAccountRepository();
    const memberships = new InMemoryUserTenantMembershipRepository();
    // Vide (aucun seed) : le sujet de ce test n'a JAMAIS de role assigne (`initialRoleIds: []`
    // ci-dessous) — la nouvelle verification admin-sur-admin (ADR-0005 Amendement 1) ne peut donc
    // jamais se declencher ici, cette matrice reste isolee sur la seule permission `mfa:reset`.
    const roles = new InMemoryRoleRepository();
    const mfaEnrollments = new InMemoryMfaEnrollmentRepository();
    const sessions = new InMemorySessionStore();
    const auditTrail = new InMemoryAuditTrail();
    const handler = new ForceMfaReEnrollmentHandler(
      sessions,
      accounts,
      memberships,
      roles,
      mfaEnrollments,
      buildTestRefreshTokenIssuer({ clock, idGenerator }),
      auditTrail,
      new InMemoryUnitOfWork(),
      clock,
      idGenerator,
    );

    const tenantId = uuidAt(9500);
    const tenant = TenantId.create(tenantId).getValue();

    // Sujet : compte reel, membre ACTIF du meme tenant que l'acteur (condition F-1 deja prouvee
    // par ForceMfaReEnrollment.test.ts — ici neutralisee pour isoler UNIQUEMENT la verification de
    // permission), avec un facteur MFA deja ACTIVE (seul etat que `forceReEnrollment` accepte).
    const subject = UserAccount.register({
      email: Email.create(`sujet-${role.code.toLowerCase()}@hopital.sn`).getValue(),
      passwordHash: PasswordHash.fromHash('hash').getValue(),
      platformRole: 'NONE',
      clock,
      idGenerator,
    });
    await accounts.save(subject);
    const membership = UserTenantMembership.grant({
      userId: subject.id,
      tenantId: tenant,
      createdBy: subject.id,
      initialRoleIds: [],
      clock,
      idGenerator,
    });
    await memberships.save(membership, tenant);
    const enrollment = MfaEnrollment.start({
      userId: subject.id,
      pendingSecret: EncryptedTotpSecret.create('v1.k1.iv.tag.cipher').getValue(),
      clock,
      idGenerator,
    });
    enrollment.confirmEnrollment({
      timeStep: 1,
      recoveryCodes: [RecoveryCodeHash.create('v1.p1.h').getValue()],
      clock,
      idGenerator,
    });
    mfaEnrollments.seed(enrollment);

    // Acteur : session TENANT du MEME tenant, step-up MFA deja satisfait (sinon FORBIDDEN pour une
    // raison independante de la permission testee), porteuse UNIQUEMENT des permissionCodes reels
    // du role du catalogue.
    const actorSession: TenantSessionContext = {
      sessionId: `acteur-${role.code}`,
      kind: 'TENANT',
      userId: idFor.userAccount(999).toString(),
      tenantId,
      membershipId: idFor.membership(1).toString(),
      roleCodes: [role.code],
      permissionCodes: role.permissionCodes,
      requiresMfa: true,
      mfaSatisfiedAt: clock.now().toISOString(),
      issuedAt: clock.now().toISOString(),
      sensitivityCategory: 'TENANT_MFA_REQUIRED',
      absoluteExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await sessions.create(actorSession);

    return handler.execute({
      subjectUserAccountId: subject.id.toString(),
      actorSessionId: actorSession.sessionId,
      reason: 'matrice RBAC — verification systematique (etape 12/13)',
    });
  }

  for (const role of TENANT_ROLES) {
    const expectAllowed = role.permissionCodes.includes('mfa:reset');
    it(`${role.code} — ${expectAllowed ? 'AUTORISE' : 'REFUSE'} (permissionCodes du catalogue : [${role.permissionCodes.join(', ')}])`, async () => {
      const result = await checkMfaReset(role);
      expect(result.isSuccess()).toBe(expectAllowed);
      if (!expectAllowed) {
        expect(result.isFailure() && result.getError()).toBe('FORBIDDEN');
      }
    });
  }
});
