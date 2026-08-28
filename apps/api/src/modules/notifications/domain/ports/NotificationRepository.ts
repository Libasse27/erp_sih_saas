import type { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { Notification } from '../Notification.js';
import type { NotificationId } from '../value-objects/NotificationId.js';

export interface NotificationRepository {
  /**
   * Persiste une nouvelle notification. Retourne `false` (au lieu de lever ou d'ecraser) si la
   * contrainte d'unicite `(sourceEventId, channel, recipient)` est deja prise — reutilisation du
   * meme idiome que `PrismaSubscriptionRepository`/`PrismaPaymentRepository` (`createMany({
   * skipDuplicates: true })`, jamais un `create()` rattrapant un P2002, ADR-0007 §6) : seconde
   * ligne de defense d'idempotence, derriere `withOutboxIdempotency`, jamais la seule.
   * `recipient` fait partie de la cle : un meme evenement peut produire plusieurs notifications
   * legitimes sur le meme canal (un destinataire par administrateur resolu).
   */
  create(notification: Notification): Promise<boolean>;

  /**
   * `platform.Notification` est HORS RLS par construction (ADR-0007 §6) : `tenantId` est donc
   * OBLIGATOIRE ici, seule couche d'isolation restante — meme discipline que
   * `PrismaPaymentRepository.findById(id, tenantId)` (revue de securite etape 9/13, F1). Un id
   * seul, meme non devinable, ne doit jamais suffire a lire la ligne d'un autre tenant.
   */
  findById(id: NotificationId, tenantId: TenantId): Promise<Notification | null>;
}
