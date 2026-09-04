import type { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import type { Notification } from '../../../src/modules/notifications/domain/Notification.js';
import type { NotificationRepository } from '../../../src/modules/notifications/domain/ports/NotificationRepository.js';
import type { NotificationId } from '../../../src/modules/notifications/domain/value-objects/NotificationId.js';
import type { RecipientDirectory } from '../../../src/modules/notifications/application/ports/RecipientDirectory.js';

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly byId = new Map<string, Notification>();
  private readonly idempotencyKeys = new Set<string>();

  async create(notification: Notification): Promise<boolean> {
    const key = `${notification.sourceEventId}::${notification.channel}::${notification.recipient}`;
    if (this.idempotencyKeys.has(key)) {
      return false;
    }
    this.idempotencyKeys.add(key);
    this.byId.set(notification.id.toString(), notification);
    return true;
  }

  async findById(id: NotificationId, tenantId: TenantId): Promise<Notification | null> {
    const notification = this.byId.get(id.toString()) ?? null;
    if (notification === null || notification.tenantId === null || !notification.tenantId.equals(tenantId)) {
      return null;
    }
    return notification;
  }

  all(): readonly Notification[] {
    return [...this.byId.values()];
  }
}

/** Fake en memoire de `RecipientDirectory` — un tenant seed() vers une liste d'emails, comportement restrictif par defaut (aucun destinataire) a l'image du reste du testKit du depot. */
export class InMemoryRecipientDirectory implements RecipientDirectory {
  private readonly byTenant = new Map<string, string[]>();
  private readonly superAdmins: { userId: string; email: string }[] = [];

  seed(tenantId: string, emails: readonly string[]): void {
    this.byTenant.set(tenantId, [...emails]);
  }

  /** Seed d'un `SUPER_ADMIN` actif (ADR-0005 Amendement 1, O-04 residu 4 — alerte break-glass). */
  seedSuperAdmin(userId: string, email: string): void {
    this.superAdmins.push({ userId, email });
  }

  async findTenantAdminEmails(tenantId: string): Promise<readonly string[]> {
    return this.byTenant.get(tenantId) ?? [];
  }

  async findActiveSuperAdminEmails(excludeUserId: string): Promise<readonly string[]> {
    return this.superAdmins.filter((entry) => entry.userId !== excludeUserId).map((entry) => entry.email);
  }
}
