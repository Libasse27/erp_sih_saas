import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import { AuthenticateUserHandler } from '../application/commands/AuthenticateUser.js';
import { CloseSessionHandler } from '../application/commands/CloseSession.js';
import { CreateUserAccountHandler } from '../application/commands/CreateUserAccount.js';
import { GrantMembershipHandler } from '../application/commands/GrantMembership.js';
import { ResolveTenantContextHandler } from '../application/commands/ResolveTenantContext.js';
import { RevokeMembershipHandler } from '../application/commands/RevokeMembership.js';
import { ServerContextResolver } from '../application/services/ServerContextResolver.js';
import type { RoleRepository } from '../domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../domain/ports/UserTenantMembershipRepository.js';
import type { TenantAccessChecker } from '../application/ports/TenantAccessChecker.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { PrismaRoleRepository } from './persistence/PrismaRoleRepository.js';
import { PrismaUserAccountRepository } from './persistence/PrismaUserAccountRepository.js';
import { PrismaUserTenantMembershipRepository } from './persistence/PrismaUserTenantMembershipRepository.js';
import { Argon2PasswordHasher } from './security/Argon2PasswordHasher.js';
import { RedisSessionStore } from './session/RedisSessionStore.js';

export interface IdentityModule {
  readonly repositories: {
    readonly userAccounts: UserAccountRepository;
    readonly memberships: UserTenantMembershipRepository;
    readonly roles: RoleRepository;
  };
  readonly unitOfWork: UnitOfWork;
  readonly handlers: {
    readonly createUserAccount: CreateUserAccountHandler;
    readonly grantMembership: GrantMembershipHandler;
    readonly revokeMembership: RevokeMembershipHandler;
    readonly authenticateUser: AuthenticateUserHandler;
    readonly resolveTenantContext: ResolveTenantContextHandler;
    readonly closeSession: CloseSessionHandler;
  };
  /** Contexte serveur (Phase 0, etape 3) — voir application/services/ServerContextResolver.ts pour la justification de son emplacement dans Identity. */
  readonly serverContextResolver: ServerContextResolver;
}

/**
 * Cablage du module Identity + RBAC + UserTenantMembership (Phase 0, etape 2/13).
 *
 * `tenantAccessChecker` est fourni par l'appelant (composition-root.ts) : c'est un port
 * cross-module (voir application/ports/TenantAccessChecker.ts) dont l'implementation reelle
 * depend du module Tenant (Phase 0, etape 3) — Identity ne construit jamais lui-meme cette
 * implementation, pour ne jamais avoir a importer quoi que ce soit de `modules/tenant/`.
 */
export function buildIdentityModule(deps: {
  prisma: PrismaClient;
  redis: Redis;
  clock: Clock;
  idGenerator: IdGenerator;
  tenantAccessChecker: TenantAccessChecker;
}): IdentityModule {
  const userAccounts = new PrismaUserAccountRepository(deps.prisma);
  const memberships = new PrismaUserTenantMembershipRepository(deps.prisma, deps.clock, deps.idGenerator);
  const roles = new PrismaRoleRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);
  const passwordHasher = new Argon2PasswordHasher();
  const sessionStore = new RedisSessionStore(deps.redis);

  return {
    repositories: { userAccounts, memberships, roles },
    unitOfWork,
    handlers: {
      createUserAccount: new CreateUserAccountHandler(
        userAccounts,
        passwordHasher,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      grantMembership: new GrantMembershipHandler(
        userAccounts,
        memberships,
        roles,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      revokeMembership: new RevokeMembershipHandler(
        memberships,
        sessionStore,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      authenticateUser: new AuthenticateUserHandler(userAccounts, memberships, passwordHasher, unitOfWork),
      resolveTenantContext: new ResolveTenantContextHandler(
        userAccounts,
        memberships,
        roles,
        sessionStore,
        deps.tenantAccessChecker,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      closeSession: new CloseSessionHandler(sessionStore),
    },
    serverContextResolver: new ServerContextResolver(sessionStore),
  };
}
