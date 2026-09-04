import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import {
  SuperAdminBreakGlassRequest,
  type SuperAdminBreakGlassRequestStatus,
} from '../../domain/SuperAdminBreakGlassRequest.js';
import type { SuperAdminBreakGlassRequestRepository } from '../../domain/ports/SuperAdminBreakGlassRequestRepository.js';
import { SuperAdminBreakGlassRequestId } from '../../domain/value-objects/SuperAdminBreakGlassRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';

interface SuperAdminBreakGlassRequestRow {
  id: string;
  requestedByUserId: string;
  subjectUserAccountId: string;
  reason: string;
  status: string;
  approvedByUserId: string | null;
  requestedAt: Date;
  approvedAt: Date | null;
}

/**
 * Repository `SuperAdminBreakGlassRequest` — table `platform.SuperAdminBreakGlassRequest`, HORS
 * RLS (ADR-0005 Amendement 1 : concept d'administration plateforme, jamais tenant-scope).
 *
 * `save()` : `create()` pour une nouvelle demande (statut `PENDING` a l'origine, retourne toujours
 * `true`) ; transition `PENDING -> APPROVED` par un `UPDATE ... WHERE status = 'PENDING'`
 * conditionnel — MEME idiome que `PrismaRefreshTokenRepository.tryMarkRotatedIfActive`/la
 * consommation d'un code de recuperation (ADR-0005 §3) : `count === 0` signale qu'un AUTRE
 * approbateur a deja fait gagner le quorum entre-temps (course concurrente sur l'approbation) —
 * retourne `false` (JAMAIS une exception, qui romprait la transaction Postgres en cours et
 * empecherait l'ecriture de l'entree d'audit DENIED correspondante dans la MEME transaction,
 * revue de securite independante de l'etape 12/13, correctif course d'approbation).
 */
export class PrismaSuperAdminBreakGlassRequestRepository implements SuperAdminBreakGlassRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(request: SuperAdminBreakGlassRequest): Promise<boolean> {
    const client = resolvePrismaClient(this.prisma);
    const idStr = request.id.toString();

    const existingRow = await client.superAdminBreakGlassRequest.findUnique({ where: { id: idStr }, select: { id: true } });

    if (existingRow === null) {
      await client.superAdminBreakGlassRequest.create({
        data: {
          id: idStr,
          requestedByUserId: request.requestedByUserId.toString(),
          subjectUserAccountId: request.subjectUserAccountId.toString(),
          reason: request.reason,
          status: request.status,
          approvedByUserId: request.approvedByUserId?.toString() ?? null,
          requestedAt: request.requestedAt,
          approvedAt: request.approvedAt,
        },
      });
    } else {
      const updateResult = await client.superAdminBreakGlassRequest.updateMany({
        where: { id: idStr, status: 'PENDING' },
        data: {
          status: request.status,
          approvedByUserId: request.approvedByUserId?.toString() ?? null,
          approvedAt: request.approvedAt,
        },
      });
      if (updateResult.count === 0) {
        // NE PAS ecrire les evenements de domaine deja accumules sur cet agregat (approbation
        // perdante) : `pullDomainEvents()` les vide neanmoins, pour ne jamais les rejouer sur un
        // futur appel `save()` de la MEME instance en memoire.
        request.pullDomainEvents();
        return false;
      }
    }

    await writeDomainEventsToOutbox(client, request.pullDomainEvents());
    return true;
  }

  async findById(id: SuperAdminBreakGlassRequestId): Promise<SuperAdminBreakGlassRequest | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.superAdminBreakGlassRequest.findUnique({ where: { id: id.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  private toDomain(row: SuperAdminBreakGlassRequestRow): SuperAdminBreakGlassRequest {
    return SuperAdminBreakGlassRequest.reconstitute(assertValid(SuperAdminBreakGlassRequestId.create(row.id)), {
      requestedByUserId: assertValid(UserAccountId.create(row.requestedByUserId)),
      subjectUserAccountId: assertValid(UserAccountId.create(row.subjectUserAccountId)),
      reason: row.reason,
      status: row.status as SuperAdminBreakGlassRequestStatus,
      approvedByUserId: row.approvedByUserId === null ? null : assertValid(UserAccountId.create(row.approvedByUserId)),
      requestedAt: row.requestedAt,
      approvedAt: row.approvedAt,
    });
  }
}
