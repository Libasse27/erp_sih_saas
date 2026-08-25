import { Prisma, type PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { Payment } from '../../domain/Payment.js';
import { PaymentConcurrencyConflictError, type PaymentRepository } from '../../domain/ports/PaymentRepository.js';
import { PaymentId } from '../../domain/value-objects/PaymentId.js';
import type { PaymentMethod } from '../../domain/value-objects/PaymentMethod.js';
import type { PaymentPurpose } from '../../domain/value-objects/PaymentPurpose.js';
import type { PaymentStatus } from '../../domain/value-objects/PaymentStatus.js';
import { PlatformInvoiceId } from '../../domain/value-objects/PlatformInvoiceId.js';

interface PaymentRow {
  id: string;
  tenantId: string;
  platformInvoiceId: string;
  subscriptionId: string;
  purpose: string;
  method: string;
  amount: number;
  status: string;
  providerTransactionId: string;
  initiatedAt: Date;
  confirmedAt: Date | null;
  version: number;
}

/**
 * Repository `Payment` — table `platform.Payment`, `tenant_id` colonne simple, SANS RLS
 * (ADR-0001 §3.3, meme regime que le reste de ce module). `findByProviderTransactionId`
 * n'accepte volontairement PAS de `tenantId` (voir domain/ports/PaymentRepository.ts) : c'est le
 * SEUL point d'entree webhook, le tenant n'est determine qu'APRES cette resolution.
 */
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Version optimiste lue en base, associee a l'INSTANCE `Payment` retournee par `toDomain()`
   * (jamais a son id : deux relectures successives du meme id produisent deux instances
   * DISTINCTES, chacune retenant la version qu'ELLE a lue — c'est ce qui permet a `save()` de
   * detecter qu'un AUTRE writer a ecrit entre-temps). `version` est PUREMENT technique
   * (verrouillage optimiste infrastructure) : ne fait pas partie de `PaymentProps` (voir
   * domain/Payment.ts, inchange par cette migration) et n'est donc connu QUE de ce repository.
   * Un `Payment` construit par `Payment.initiate()` (jamais passe par `toDomain()`) est absent de
   * cette map : traite comme version `0` (premiere ecriture, branche CREATE de `save()`).
   */
  private readonly versionsByInstance = new WeakMap<Payment, number>();

  async findById(id: PaymentId, tenantId: TenantId): Promise<Payment | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.payment.findFirst({ where: { id: id.toString(), tenantId: tenantId.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  async findByProviderTransactionId(providerTransactionId: string): Promise<Payment | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.payment.findUnique({ where: { providerTransactionId } });
    return row === null ? null : this.toDomain(row);
  }

  /**
   * CREATE vs UPDATE determine par un `findUnique({ where: { id } })` explicite AVANT toute
   * ecriture — pas d'`upsert()` atomique possible ici (contrairement au point P2002 ci-dessous,
   * qui lui reste sur un simple `create()`) : le controle de version optimiste DOIT etre applique
   * AVANT de decider la branche, un `upsert()` ne laisse pas ce point d'insertion.
   *
   * Branche CREATE : `version` demarre a 0, protegee par le meme mecanisme P2002 que
   * `PrismaPlatformInvoiceRepository.issue()` (meme regime "cle d'idempotence webhook",
   * `provider_transaction_id` UNIQUE) — un P2002 signifie qu'un AUTRE writer vient d'inserer une
   * ligne pour ce `providerTransactionId` : si c'est LA MEME ligne (meme `id`, course benigne
   * entre deux ecritures du meme `Payment`), rien a refaire (write idempotent, deja ecrit) ; si
   * c'est un `id` DIFFERENT, deux agregats `Payment` distincts pretendent au meme
   * `providerTransactionId` — anomalie reelle, jamais masquee.
   *
   * Branche UPDATE : `updateMany({ where: { id, version: expectedVersion } })` — conditionnee sur
   * la version LUE par CETTE instance (`versionsByInstance`). `count === 0` alors que la ligne
   * existe (verifiee juste avant) signifie qu'un AUTRE writer a deja incremente la version entre
   * notre lecture et notre ecriture : on NE l'ecrase PAS, on leve `PaymentConcurrencyConflictError`
   * (voir ce type) plutot que d'appliquer quand meme nos donnees perimees.
   */
  async save(payment: Payment, tenantId: TenantId): Promise<void> {
    if (!payment.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un Payment hors du tenant du contexte courant.");
    }
    const client = resolvePrismaClient(this.prisma);
    const idStr = payment.id.toString();
    const tenantIdStr = tenantId.toString();

    const existingRow = await client.payment.findUnique({ where: { id: idStr }, select: { id: true } });

    if (existingRow === null) {
      try {
        await client.payment.create({
          data: {
            id: idStr,
            tenantId: tenantIdStr,
            platformInvoiceId: payment.platformInvoiceId.toString(),
            subscriptionId: payment.subscriptionId,
            purpose: payment.purpose,
            method: payment.method,
            amount: payment.amount.amount,
            status: payment.status,
            providerTransactionId: payment.providerTransactionId,
            initiatedAt: payment.initiatedAt,
            confirmedAt: payment.confirmedAt,
            version: 0,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
        const conflicting = await client.payment.findUnique({
          where: { providerTransactionId: payment.providerTransactionId },
          select: { id: true },
        });
        if (conflicting === null) {
          // Ne devrait pas arriver (le P2002 vient forcement de cette contrainte, voir
          // PrismaPlatformInvoiceRepository.issue() pour la meme discipline) — remonte l'erreur
          // d'origine plutot que de masquer une incoherence.
          throw error;
        }
        if (conflicting.id !== idStr) {
          // Deux agregats Payment DISTINCTS pretendent au meme providerTransactionId : ne
          // devrait jamais arriver si le prestataire attribue des identifiants uniques — anomalie
          // reelle, jamais masquee.
          throw error;
        }
        // Course benigne : un autre writer concurrent vient d'inserer/mettre a jour EXACTEMENT
        // cette ligne juste avant nous — write idempotent, le contenu vise etait deja ecrit.
        // Aucun evenement a rejouer ici : celui qui a gagne la course a deja ecrit les siens.
        return;
      }
      // Version connue de CETTE instance des maintenant (evite qu'un futur `save()` ulterieur sur
      // le meme objet, apres mutation, se voie opposer a tort la version 0 perimee).
      this.versionsByInstance.set(payment, 0);
    } else {
      const expectedVersion = this.versionsByInstance.get(payment) ?? 0;
      const updateResult = await client.payment.updateMany({
        where: { id: idStr, version: expectedVersion },
        data: { status: payment.status, confirmedAt: payment.confirmedAt, version: { increment: 1 } },
      });
      if (updateResult.count === 0) {
        throw new PaymentConcurrencyConflictError(
          `Ecriture concurrente perdue sur Payment ${idStr} : version attendue ${expectedVersion} deja depassee par un autre writer.`,
        );
      }
      // La version DB vient d'etre incrementee par notre propre ecriture : refleter ce nouvel
      // etat sur l'instance pour qu'un save() ulterieur (meme objet, nouvelle mutation) parte de
      // la bonne version au lieu de rejouer celle, perimee, lue a l'origine.
      this.versionsByInstance.set(payment, expectedVersion + 1);
    }

    await writeDomainEventsToOutbox(client, payment.pullDomainEvents());
  }

  async listPendingInitiatedBefore(olderThan: Date): Promise<readonly Payment[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.payment.findMany({
      where: { status: 'PENDING', initiatedAt: { lte: olderThan } },
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: PaymentRow): Payment {
    const id = assertValid(PaymentId.create(row.id));
    const tenantId = assertValid(TenantId.create(row.tenantId));
    const platformInvoiceId = assertValid(PlatformInvoiceId.create(row.platformInvoiceId));
    const amount = assertValid(Money.fromXOF(row.amount));
    const payment = Payment.reconstitute(id, {
      tenantId,
      platformInvoiceId,
      subscriptionId: row.subscriptionId,
      purpose: row.purpose as PaymentPurpose,
      method: row.method as PaymentMethod,
      amount,
      status: row.status as PaymentStatus,
      providerTransactionId: row.providerTransactionId,
      initiatedAt: row.initiatedAt,
      confirmedAt: row.confirmedAt,
    });
    this.versionsByInstance.set(payment, row.version);
    return payment;
  }
}
