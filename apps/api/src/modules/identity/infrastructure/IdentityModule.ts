import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../shared-kernel/application/UnitOfWork.js';
import type { OutboxEventHandler } from '../../../shared-kernel/application/OutboxEventHandler.js';
import { AuthenticateUserHandler } from '../application/commands/AuthenticateUser.js';
import { CloseSessionHandler } from '../application/commands/CloseSession.js';
import { ConfirmMfaEnrollmentHandler } from '../application/commands/ConfirmMfaEnrollment.js';
import { CreateUserAccountHandler } from '../application/commands/CreateUserAccount.js';
import { ForceMfaReEnrollmentHandler } from '../application/commands/ForceMfaReEnrollment.js';
import { GrantMembershipHandler } from '../application/commands/GrantMembership.js';
import { RegenerateMfaRecoveryCodesHandler } from '../application/commands/RegenerateMfaRecoveryCodes.js';
import { ResolveTenantContextHandler } from '../application/commands/ResolveTenantContext.js';
import { RevokeMembershipHandler } from '../application/commands/RevokeMembership.js';
import { StartMfaEnrollmentHandler } from '../application/commands/StartMfaEnrollment.js';
import { VerifyMfaChallengeHandler } from '../application/commands/VerifyMfaChallenge.js';
import { RefreshSessionHandler } from '../application/commands/RefreshSession.js';
import { createGrantOwnerMembershipOnSubscriptionStartedHandler } from '../application/services/GrantOwnerMembershipOnSubscriptionStarted.js';
import { SessionContextIssuer } from '../application/services/SessionContextIssuer.js';
import { ServerContextResolver } from '../application/services/ServerContextResolver.js';
import { RefreshTokenIssuer } from '../application/services/RefreshTokenIssuer.js';
import type { AuditTrail } from '../application/ports/AuditTrail.js';
import type { SessionAuditTrail } from '../application/ports/SessionAuditTrail.js';
import type { RoleRepository } from '../domain/ports/RoleRepository.js';
import type { MfaEnrollmentRepository } from '../domain/ports/MfaEnrollmentRepository.js';
import type { UserAccountRepository } from '../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../domain/ports/UserTenantMembershipRepository.js';
import type { RefreshTokenRepository } from '../domain/ports/RefreshTokenRepository.js';
import type { TenantAccessChecker } from '../application/ports/TenantAccessChecker.js';
import { PgUnitOfWork } from '../../../shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { PrismaMfaEnrollmentRepository } from './persistence/PrismaMfaEnrollmentRepository.js';
import { PrismaRoleRepository } from './persistence/PrismaRoleRepository.js';
import { PrismaUserAccountRepository } from './persistence/PrismaUserAccountRepository.js';
import { PrismaUserTenantMembershipRepository } from './persistence/PrismaUserTenantMembershipRepository.js';
import { PrismaRefreshTokenRepository } from './persistence/PrismaRefreshTokenRepository.js';
import { Argon2PasswordHasher } from './security/Argon2PasswordHasher.js';
import { AesGcmSecretCipher } from './security/AesGcmSecretCipher.js';
import { CryptoRecoveryCodeGenerator } from './security/CryptoRecoveryCodeGenerator.js';
import { HmacRecoveryCodeHasher } from './security/HmacRecoveryCodeHasher.js';
import { Rfc6238TotpService } from './security/Rfc6238TotpService.js';
import { CryptoRefreshTokenGenerator } from './security/CryptoRefreshTokenGenerator.js';
import { HmacRefreshTokenHasher } from './security/HmacRefreshTokenHasher.js';
import { RedisMfaBypassAttemptGuard } from './session/RedisMfaBypassAttemptGuard.js';
import { RedisSessionStore } from './session/RedisSessionStore.js';

export interface IdentityModuleMfaConfig {
  /** Cle AES-256 (32 octets) decodee depuis `MFA_SECRET_ENCRYPTION_KEY` (base64) — voir config/env.ts. */
  readonly secretEncryptionKey: Buffer;
  readonly secretEncryptionKeyId: string;
  readonly recoveryCodePepper: string;
  readonly recoveryCodePepperId: string;
  readonly totpIssuer: string;
}

/** Etape 8/13 (ADR-0006 §4) — meme discipline que `IdentityModuleMfaConfig` : poivre HMAC exclusivement via l'environnement. */
export interface IdentityModuleRefreshTokenConfig {
  readonly hashPepper: string;
  readonly hashPepperId: string;
}

export interface IdentityModule {
  readonly repositories: {
    readonly userAccounts: UserAccountRepository;
    readonly memberships: UserTenantMembershipRepository;
    readonly roles: RoleRepository;
    readonly mfaEnrollments: MfaEnrollmentRepository;
    readonly refreshTokens: RefreshTokenRepository;
  };
  readonly unitOfWork: UnitOfWork;
  readonly handlers: {
    readonly createUserAccount: CreateUserAccountHandler;
    readonly grantMembership: GrantMembershipHandler;
    readonly revokeMembership: RevokeMembershipHandler;
    readonly authenticateUser: AuthenticateUserHandler;
    readonly resolveTenantContext: ResolveTenantContextHandler;
    readonly closeSession: CloseSessionHandler;
    readonly startMfaEnrollment: StartMfaEnrollmentHandler;
    readonly confirmMfaEnrollment: ConfirmMfaEnrollmentHandler;
    readonly verifyMfaChallenge: VerifyMfaChallengeHandler;
    readonly forceMfaReEnrollment: ForceMfaReEnrollmentHandler;
    readonly regenerateMfaRecoveryCodes: RegenerateMfaRecoveryCodesHandler;
    readonly refreshSession: RefreshSessionHandler;
  };
  /** Consommateurs Outbox exposes par ce module — cables UNIQUEMENT dans composition-root.ts. */
  readonly outboxHandlers: {
    /** Deuxieme etape chorographiee de la Saga de provisioning (ADR-0008 §1/§4/§9, resequencement F3 — revue de securite de l'etape 10/13) — consomme `subscription.subscription.started`, STRICTEMENT APRES que l'abonnement d'essai ait ete demarre (plus jamais en parallele de `subscription.startTrialSubscriptionOnHealthFacilityCreated`). */
    readonly grantOwnerMembershipOnSubscriptionStarted: OutboxEventHandler;
  };
  /** Contexte serveur (Phase 0, etape 3) — voir application/services/ServerContextResolver.ts pour la justification de son emplacement dans Identity. */
  readonly serverContextResolver: ServerContextResolver;
}

/**
 * Cablage du module Identity + RBAC + UserTenantMembership + MFA (Phase 0, etapes 2/13 et 7/13).
 *
 * `tenantAccessChecker` et `auditTrail` sont fournis par l'appelant (composition-root.ts) : ce
 * sont des ports cross-module (voir application/ports/TenantAccessChecker.ts et AuditTrail.ts)
 * dont l'implementation reelle depend respectivement du module Tenant et du module `audit` —
 * Identity ne construit jamais lui-meme ces implementations, pour ne jamais avoir a importer quoi
 * que ce soit de `modules/tenant/` ou `modules/audit/`.
 */
export function buildIdentityModule(deps: {
  prisma: PrismaClient;
  redis: Redis;
  clock: Clock;
  idGenerator: IdGenerator;
  tenantAccessChecker: TenantAccessChecker;
  auditTrail: AuditTrail;
  sessionAuditTrail: SessionAuditTrail;
  mfa: IdentityModuleMfaConfig;
  refreshToken: IdentityModuleRefreshTokenConfig;
}): IdentityModule {
  const userAccounts = new PrismaUserAccountRepository(deps.prisma);
  const memberships = new PrismaUserTenantMembershipRepository(deps.prisma, deps.clock, deps.idGenerator);
  const roles = new PrismaRoleRepository(deps.prisma);
  const mfaEnrollments = new PrismaMfaEnrollmentRepository(deps.prisma);
  const refreshTokens = new PrismaRefreshTokenRepository(deps.prisma);
  const unitOfWork = new PgUnitOfWork(deps.prisma);
  const passwordHasher = new Argon2PasswordHasher();
  const sessionStore = new RedisSessionStore(deps.redis);
  const mfaBypassAttemptGuard = new RedisMfaBypassAttemptGuard(deps.redis);

  const secretCipher = new AesGcmSecretCipher(deps.mfa.secretEncryptionKey, deps.mfa.secretEncryptionKeyId);
  const totpService = new Rfc6238TotpService(secretCipher, deps.mfa.totpIssuer);
  const recoveryCodeHasher = new HmacRecoveryCodeHasher(deps.mfa.recoveryCodePepper, deps.mfa.recoveryCodePepperId);
  const recoveryCodeGenerator = new CryptoRecoveryCodeGenerator(recoveryCodeHasher);

  const refreshTokenGenerator = new CryptoRefreshTokenGenerator();
  const refreshTokenHasher = new HmacRefreshTokenHasher(deps.refreshToken.hashPepper, deps.refreshToken.hashPepperId);

  const sessionContextIssuer = new SessionContextIssuer(
    userAccounts,
    memberships,
    roles,
    deps.tenantAccessChecker,
    mfaEnrollments,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );
  const refreshTokenIssuer = new RefreshTokenIssuer(
    refreshTokens,
    refreshTokenGenerator,
    refreshTokenHasher,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );

  const grantMembership = new GrantMembershipHandler(
    userAccounts,
    memberships,
    roles,
    unitOfWork,
    deps.clock,
    deps.idGenerator,
  );

  return {
    repositories: { userAccounts, memberships, roles, mfaEnrollments, refreshTokens },
    unitOfWork,
    handlers: {
      createUserAccount: new CreateUserAccountHandler(
        userAccounts,
        passwordHasher,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      grantMembership,
      revokeMembership: new RevokeMembershipHandler(
        memberships,
        sessionStore,
        refreshTokenIssuer,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      authenticateUser: new AuthenticateUserHandler(userAccounts, memberships, passwordHasher, unitOfWork),
      resolveTenantContext: new ResolveTenantContextHandler(sessionContextIssuer, sessionStore, refreshTokenIssuer),
      closeSession: new CloseSessionHandler(sessionStore, refreshTokenIssuer),
      refreshSession: new RefreshSessionHandler(
        refreshTokenIssuer,
        refreshTokens,
        sessionContextIssuer,
        sessionStore,
        deps.sessionAuditTrail,
        unitOfWork,
        deps.clock,
      ),
      startMfaEnrollment: new StartMfaEnrollmentHandler(
        sessionStore,
        userAccounts,
        mfaEnrollments,
        totpService,
        deps.auditTrail,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      confirmMfaEnrollment: new ConfirmMfaEnrollmentHandler(
        sessionStore,
        mfaEnrollments,
        totpService,
        recoveryCodeGenerator,
        deps.auditTrail,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      verifyMfaChallenge: new VerifyMfaChallengeHandler(
        sessionStore,
        mfaEnrollments,
        totpService,
        recoveryCodeHasher,
        sessionContextIssuer,
        refreshTokenIssuer,
        deps.auditTrail,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      forceMfaReEnrollment: new ForceMfaReEnrollmentHandler(
        sessionStore,
        userAccounts,
        memberships,
        mfaEnrollments,
        refreshTokenIssuer,
        deps.auditTrail,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
      regenerateMfaRecoveryCodes: new RegenerateMfaRecoveryCodesHandler(
        sessionStore,
        mfaEnrollments,
        totpService,
        recoveryCodeGenerator,
        deps.auditTrail,
        unitOfWork,
        deps.clock,
        deps.idGenerator,
      ),
    },
    outboxHandlers: {
      grantOwnerMembershipOnSubscriptionStarted: createGrantOwnerMembershipOnSubscriptionStartedHandler({
        grantMembershipHandler: grantMembership,
      }),
    },
    serverContextResolver: new ServerContextResolver(sessionStore, mfaBypassAttemptGuard, deps.auditTrail),
  };
}
