import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import { Notification } from '../../../src/modules/notifications/domain/Notification.js';
import { NotificationId } from '../../../src/modules/notifications/domain/value-objects/NotificationId.js';
import { PrismaNotificationRepository } from '../../../src/modules/notifications/infrastructure/persistence/PrismaNotificationRepository.js';
import { createRawPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Isolation inter-tenant — `platform.Notification` (lacune B de l'audit de securite, Phase 0,
 * etape 12/13). MEME regime que `Payment`/`PlatformInvoice`/`Subscription`
 * (`paymentRepositoryTenantIsolation.test.ts`/`subscriptionRepositoryTenantIsolation.test.ts`) :
 * table du schema `platform`, AUCUNE politique RLS (ADR-0007 §6), isolation PUREMENT
 * APPLICATIVE portee par `PrismaNotificationRepository.findById(id, tenantId)` — voir
 * `domain/ports/NotificationRepository.ts`, qui documente explicitement `tenantId` comme "seule
 * couche d'isolation restante".
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Notification — isolation inter-tenant (schema platform, sans RLS)', () => {
  let prisma: PrismaClient;
  let rawClient: Client;
  let repository: PrismaNotificationRepository;

  const tenantAId = uniqueId();
  const tenantBId = uniqueId();
  let notificationAId: string;
  let notificationBId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    rawClient = await createRawPgClient();
    repository = new PrismaNotificationRepository(prisma);

    const now = new Date('2026-09-01T09:00:00Z');
    const tenantA = TenantId.create(tenantAId).getValue();
    const tenantB = TenantId.create(tenantBId).getValue();

    const notificationA = Notification.create({
      id: NotificationId.create(uniqueId()).getValue(),
      tenantId: tenantA,
      channel: 'EMAIL',
      recipient: 'admin-a@hopital.sn',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: uniqueId(),
      now,
    }).getValue();
    await repository.create(notificationA);
    notificationAId = notificationA.id.toString();

    const notificationB = Notification.create({
      id: NotificationId.create(uniqueId()).getValue(),
      tenantId: tenantB,
      channel: 'EMAIL',
      recipient: 'admin-b@hopital.sn',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: uniqueId(),
      now,
    }).getValue();
    await repository.create(notificationB);
    notificationBId = notificationB.id.toString();
  });

  afterAll(async () => {
    await rawClient.query('DELETE FROM "platform"."Notification" WHERE id = $1 OR id = $2', [
      notificationAId,
      notificationBId,
    ]);
    await rawClient.end();
    await prisma.$disconnect();
  });

  describe('REPOSITORY — PrismaNotificationRepository filtre explicitement par tenantId', () => {
    it("findById(notificationA, tenantB) renvoie null : un id valide d'un AUTRE tenant ne suffit jamais", async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await repository.findById(NotificationId.create(notificationAId).getValue(), tenantB);
      expect(result).toBeNull();
    });

    it("findById(notificationB, tenantA) renvoie null (symetrique)", async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await repository.findById(NotificationId.create(notificationBId).getValue(), tenantA);
      expect(result).toBeNull();
    });

    it('findById(notificationA, tenantA) retrouve la ligne du proprietaire legitime', async () => {
      const tenantA = TenantId.create(tenantAId).getValue();
      const result = await repository.findById(NotificationId.create(notificationAId).getValue(), tenantA);
      expect(result?.id.toString()).toBe(notificationAId);
      expect(result?.recipient).toBe('admin-a@hopital.sn');
    });

    it('findById(notificationB, tenantB) retrouve la ligne du proprietaire legitime', async () => {
      const tenantB = TenantId.create(tenantBId).getValue();
      const result = await repository.findById(NotificationId.create(notificationBId).getValue(), tenantB);
      expect(result?.id.toString()).toBe(notificationBId);
      expect(result?.recipient).toBe('admin-b@hopital.sn');
    });
  });

  describe('ABSENCE DE RLS — contraste deliberement demontre (ADR-0007 §6)', () => {
    it('une requete SQL brute SANS filtre tenant_id expose les DEUX tenants sur Notification', async () => {
      const result = await rawClient.query('SELECT tenant_id FROM "platform"."Notification" WHERE id = ANY($1)', [
        [notificationAId, notificationBId],
      ]);
      const tenantIdsVisible = result.rows.map((row: { tenant_id: string }) => row.tenant_id);
      expect(tenantIdsVisible).toEqual(expect.arrayContaining([tenantAId, tenantBId]));
    });
  });
});
