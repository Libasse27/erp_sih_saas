import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/shared-kernel/infrastructure/SystemClock.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import type { OutboxEventEnvelope } from '../../../src/shared-kernel/application/OutboxEventHandler.js';
import { buildIdentityModule, type IdentityModule } from '../../../src/modules/identity/infrastructure/IdentityModule.js';
import type { TenantAccessChecker } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import { seedPermissionCatalog, seedSystemRoles } from '../../../src/modules/identity/infrastructure/seed/seedIdentityCatalog.js';
import { buildTenantModule, type TenantModule } from '../../../src/modules/tenant/infrastructure/TenantModule.js';
import type { UserAccountExistenceChecker } from '../../../src/modules/tenant/application/ports/UserAccountExistenceChecker.js';
import { buildSubscriptionModule, type SubscriptionModule } from '../../../src/modules/subscription/infrastructure/SubscriptionModule.js';
import { PrismaUserAccountRepository } from '../../../src/modules/identity/infrastructure/persistence/PrismaUserAccountRepository.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { InMemoryAuditTrail, InMemorySessionAuditTrail } from '../../identity/builders/testKit.js';
import { createTestRedisClient, uniqueEmail, uniqueFacilityName } from '../../identity/integration/dbTestHelpers.js';
import { PrismaNotificationRepository } from '../../../src/modules/notifications/infrastructure/persistence/PrismaNotificationRepository.js';
import { createSendWelcomeEmailOnSubscriptionStartedHandler } from '../../../src/modules/notifications/application/services/SendWelcomeEmailOnSubscriptionStarted.js';
import { createSendPlanChangeConfirmationOnPlanChangedHandler } from '../../../src/modules/notifications/application/services/SendPlanChangeConfirmationOnPlanChanged.js';
import type { RecipientDirectory } from '../../../src/modules/notifications/application/ports/RecipientDirectory.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Preuve bout en bout (ADR-0007 §1/§4) que les DEUX consommateurs Outbox reels de Notifications
 * resolvent correctement leur destinataire contre de VRAIES donnees Identity/Tenant — pas les
 * fakes en memoire (`InMemoryRecipientDirectory`/`InMemoryUserTenantMembershipRepository`) deja
 * couverts par les tests unitaires de `SendWelcomeEmailOnSubscriptionStarted.test.ts`/
 * `SendPlanChangeConfirmationOnPlanChanged.test.ts`. Reproduit fidelement
 * `IdentityModuleBackedRecipientDirectory` de `composition-root.ts` (meme convention que
 * `test/identity/integration/identityFlow.test.ts` §"L'adaptateur cross-module ci-dessous...") :
 * duplique plutot qu'importe, pour ne pas faire dependre ce test du reste du cablage applicatif.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Notifications — consommateurs Outbox Subscription contre Identity/Tenant reels', () => {
  let prisma: PrismaClient;
  let redis: Redis;
  let identity: IdentityModule;
  let tenantModule: TenantModule;
  let subscriptionModule: SubscriptionModule;
  let notificationRepository: PrismaNotificationRepository;
  let unitOfWork: PgUnitOfWork;
  let recipientDirectory: RecipientDirectory;
  let rawClient: Awaited<ReturnType<typeof createRawPgClient>>;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    redis = createTestRedisClient();
    rawClient = await createRawPgClient();
    unitOfWork = new PgUnitOfWork(prisma);
    notificationRepository = new PrismaNotificationRepository(prisma);

    // Reproduit fidelement `IdentityModuleBackedUserAccountExistenceChecker` de
    // composition-root.ts (ADR-0008 §9, amendement 1) — voir le meme commentaire dans
    // serverContextPropagation.test.ts.
    const userAccountsForExistenceCheck = new PrismaUserAccountRepository(prisma);
    const userAccountExistenceChecker: UserAccountExistenceChecker = {
      exists: async (userId: string) => {
        const idResult = UserAccountId.create(userId);
        if (idResult.isFailure()) {
          return false;
        }
        return (await userAccountsForExistenceCheck.findById(idResult.getValue())) !== null;
      },
    };
    tenantModule = buildTenantModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator(), userAccountExistenceChecker });
    subscriptionModule = buildSubscriptionModule({ prisma, clock: new SystemClock(), idGenerator: new UuidGenerator() });
    // Compose Subscription depuis ADR-0008 §3 (etape 10/13) — voir composition-root.ts. Ce
    // fichier n'exerce jamais `resolveTenantContext` directement (il invoque les consommateurs
    // Outbox de Notifications avec une enveloppe fabriquee a la main), donc aucun test existant
    // ne depend de cette branche — mise a jour uniquement pour rester fidele a
    // TenantModuleBackedAccessChecker (meme discipline "duplique plutot qu'importe" que les
    // autres tests d'integration de ce depot).
    const tenantAccessChecker: TenantAccessChecker = {
      checkAccess: async (tenantId) => {
        const facility = await tenantModule.repositories.healthFacilities.findByTenantId(tenantId);
        if (facility === null) {
          return 'NOT_FOUND';
        }
        if (!facility.isActive()) {
          return 'SUSPENDED';
        }
        const activeSubscription = await subscriptionModule.repositories.subscriptions.findByTenantId(tenantId);
        return activeSubscription === null ? 'NOT_FOUND' : 'ACCESSIBLE';
      },
    };
    identity = buildIdentityModule({
      prisma,
      redis,
      clock: new SystemClock(),
      idGenerator: new UuidGenerator(),
      tenantAccessChecker,
      auditTrail: new InMemoryAuditTrail(),
      sessionAuditTrail: new InMemorySessionAuditTrail(),
      mfa: {
        secretEncryptionKey: Buffer.alloc(32, 4),
        secretEncryptionKeyId: 'k1',
        recoveryCodePepper: 'notification-consumers-test-recovery-pepper-32c',
        recoveryCodePepperId: 'p1',
        totpIssuer: 'SIH-TEST',
      },
      refreshToken: {
        hashPepper: 'notification-consumers-test-refresh-token-pepper-32c',
        hashPepperId: 'p1',
      },
    });

    await seedPermissionCatalog(prisma);
    await seedSystemRoles(identity.repositories.roles);

    // Reproduit fidelement IdentityModuleBackedRecipientDirectory de composition-root.ts.
    recipientDirectory = {
      findTenantAdminEmails: async (tenantIdValue: string): Promise<readonly string[]> => {
        const tenantIdResult = TenantId.create(tenantIdValue);
        if (tenantIdResult.isFailure()) {
          throw new Error(`tenantId invalide : "${tenantIdValue}".`);
        }
        const tenantIdVo = tenantIdResult.getValue();
        const adminRole = await identity.repositories.roles.findSystemRoleByCode('ADMIN_ETABLISSEMENT');
        if (adminRole === null) {
          return [];
        }
        const memberships = await identity.unitOfWork.withTransaction(
          () => identity.repositories.memberships.listActiveByTenantAndRole(tenantIdVo, adminRole.id),
          { tenantId: tenantIdVo },
        );
        const emails: string[] = [];
        for (const membership of memberships) {
          const account = await identity.repositories.userAccounts.findById(membership.userId);
          if (account !== null) {
            emails.push(account.email.value);
          }
        }
        return emails;
      },
    };
  });

  afterAll(async () => {
    await rawClient.end();
    await prisma.$disconnect();
    redis.disconnect();
  });

  async function createAccount(prefix: string): Promise<{ userId: string; email: string }> {
    const email = uniqueEmail(prefix);
    const result = await identity.handlers.createUserAccount.execute({
      email,
      plainPassword: 'mot-de-passe-suffisant-1',
      platformRole: 'NONE',
    });
    if (result.isFailure()) {
      throw new Error(`Echec creation compte: ${result.getError()}`);
    }
    return { userId: result.getValue().userAccountId, email };
  }

  /** `ownerUserId` (ADR-0008 §9, amendement 1) : compte "proprietaire" JETABLE, distinct des comptes ADMIN_ETABLISSEMENT crees ensuite par chaque test via `grantAdmin`. */
  async function createFacilityTenantId(): Promise<string> {
    const owner = await createAccount('facility-owner');
    const result = await tenantModule.handlers.createHealthFacility.execute({
      name: uniqueFacilityName('Etablissement Notif'),
      ownerUserId: owner.userId,
    });
    if (result.isFailure()) {
      throw new Error(`Echec creation etablissement: ${result.getError()}`);
    }
    return result.getValue().tenantId;
  }

  async function grantAdmin(userId: string, tenantId: string): Promise<string> {
    const grant = await identity.handlers.grantMembership.execute({
      userId,
      tenantId,
      createdBy: userId,
      initialRoleCodes: ['ADMIN_ETABLISSEMENT'],
    });
    if (grant.isFailure()) {
      throw new Error(`Echec octroi membership: ${grant.getError()}`);
    }
    return grant.getValue().membershipId;
  }

  function buildSubscriptionStartedEnvelope(tenantId: string): OutboxEventEnvelope {
    return {
      id: uniqueId(),
      eventType: 'subscription.subscription.started',
      eventVersion: 1,
      aggregateId: uniqueId(),
      tenantId,
      occurredAt: new Date('2026-08-28T09:00:00Z'),
      payload: { tenantId, planId: uniqueId() },
    };
  }

  function buildPlanChangedEnvelope(tenantId: string): OutboxEventEnvelope {
    return {
      id: uniqueId(),
      eventType: 'subscription.subscription.plan-changed',
      eventVersion: 1,
      aggregateId: uniqueId(),
      tenantId,
      occurredAt: new Date('2026-08-28T09:00:00Z'),
      payload: { tenantId, fromPlanId: uniqueId(), toPlanId: uniqueId() },
    };
  }

  it('SubscriptionStarted reel : cree une Notification EMAIL PENDING pour chaque ADMIN_ETABLISSEMENT reellement rattache au tenant', async () => {
    const tenantId = await createFacilityTenantId();
    const admin1 = await createAccount('welcome-admin1');
    const admin2 = await createAccount('welcome-admin2');
    await grantAdmin(admin1.userId, tenantId);
    await grantAdmin(admin2.userId, tenantId);

    const handler = createSendWelcomeEmailOnSubscriptionStartedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork,
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
    });

    const envelope = buildSubscriptionStartedEnvelope(tenantId);
    await handler(envelope);

    const rows = await rawClient.query(
      'SELECT recipient, channel, template_kind AS "templateKind", status, tenant_id AS "tenantId" FROM "platform"."Notification" WHERE source_event_id = $1 ORDER BY recipient',
      [envelope.id],
    );
    expect(rows.rowCount).toBe(2);
    const recipients = rows.rows.map((row: { recipient: string }) => row.recipient).sort();
    expect(recipients).toEqual([admin1.email, admin2.email].sort());
    for (const row of rows.rows as Array<{ channel: string; templateKind: string; status: string; tenantId: string }>) {
      expect(row.channel).toBe('EMAIL');
      expect(row.templateKind).toBe('SUBSCRIPTION_WELCOME');
      expect(row.status).toBe('PENDING');
      expect(row.tenantId).toBe(tenantId);
    }
  });

  it('SubscriptionPlanChanged reel : cree une Notification EMAIL PENDING par ADMIN_ETABLISSEMENT, gabarit SUBSCRIPTION_PLAN_CHANGED', async () => {
    const tenantId = await createFacilityTenantId();
    const admin = await createAccount('plan-changed-admin');
    await grantAdmin(admin.userId, tenantId);

    const handler = createSendPlanChangeConfirmationOnPlanChangedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork,
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
    });

    const envelope = buildPlanChangedEnvelope(tenantId);
    await handler(envelope);

    const rows = await rawClient.query(
      'SELECT recipient, template_kind AS "templateKind" FROM "platform"."Notification" WHERE source_event_id = $1',
      [envelope.id],
    );
    expect(rows.rowCount).toBe(1);
    expect((rows.rows[0] as { recipient: string }).recipient).toBe(admin.email);
    expect((rows.rows[0] as { templateKind: string }).templateKind).toBe('SUBSCRIPTION_PLAN_CHANGED');
  });

  it('double livraison Outbox du MEME evenement (at-least-once) : jamais une seconde Notification par destinataire', async () => {
    const tenantId = await createFacilityTenantId();
    const admin = await createAccount('double-delivery-admin');
    await grantAdmin(admin.userId, tenantId);

    const handler = createSendWelcomeEmailOnSubscriptionStartedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork,
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
    });

    const envelope = buildSubscriptionStartedEnvelope(tenantId);
    await handler(envelope);
    await handler(envelope);

    const rows = await rawClient.query('SELECT id FROM "platform"."Notification" WHERE source_event_id = $1', [envelope.id]);
    expect(rows.rowCount).toBe(1);
  });

  it("un membership REVOQUE avant l'evenement n'est jamais notifie — listActiveByTenantAndRole filtre reellement sur status = ACTIVE", async () => {
    const tenantId = await createFacilityTenantId();
    const admin = await createAccount('revoked-admin');
    const membershipId = await grantAdmin(admin.userId, tenantId);

    const revoke = await identity.handlers.revokeMembership.execute({ membershipId, tenantId });
    expect(revoke.isSuccess()).toBe(true);

    const handler = createSendWelcomeEmailOnSubscriptionStartedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork,
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
    });

    const envelope = buildSubscriptionStartedEnvelope(tenantId);
    await handler(envelope);

    const rows = await rawClient.query('SELECT id FROM "platform"."Notification" WHERE source_event_id = $1', [envelope.id]);
    expect(rows.rowCount).toBe(0);
  });

  it('aucun ADMIN_ETABLISSEMENT sur le tenant : no-op silencieux, jamais une erreur de traitement (rien a reessayer)', async () => {
    const tenantId = await createFacilityTenantId();
    const nonAdmin = await createAccount('non-admin');
    await identity.handlers.grantMembership.execute({
      userId: nonAdmin.userId,
      tenantId,
      createdBy: nonAdmin.userId,
      initialRoleCodes: ['MEDECIN'],
    });

    const handler = createSendWelcomeEmailOnSubscriptionStartedHandler({
      notificationRepository,
      recipientDirectory,
      unitOfWork,
      idGenerator: new UuidGenerator(),
      clock: new SystemClock(),
    });

    const envelope = buildSubscriptionStartedEnvelope(tenantId);
    await expect(handler(envelope)).resolves.toBeUndefined();

    const rows = await rawClient.query('SELECT id FROM "platform"."Notification" WHERE source_event_id = $1', [envelope.id]);
    expect(rows.rowCount).toBe(0);
  });
});
