import type { PrismaClient } from '@prisma/client';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { TenantAdminRecoveryRequest, type TenantAdminRecoveryRequestStatus } from '../../domain/TenantAdminRecoveryRequest.js';
import type { TenantAdminRecoveryRequestRepository } from '../../domain/ports/TenantAdminRecoveryRequestRepository.js';
import { TenantAdminRecoveryRequestId } from '../../domain/value-objects/TenantAdminRecoveryRequestId.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';

interface TenantAdminRecoveryRequestRow {
  id: string;
  tenantId: string;
  beneficiaryUserId: string;
  requestedByUserId: string;
  reason: string;
  status: string;
  approvedByUserId: string | null;
  requestedAt: Date;
  approvedAt: Date | null;
}

export class PrismaTenantAdminRecoveryRequestRepository implements TenantAdminRecoveryRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(request: TenantAdminRecoveryRequest): Promise<boolean> {
    const client = resolvePrismaClient(this.prisma);
    const id = request.id.toString();
    const current = await client.tenantAdminRecoveryRequest.findUnique({ where: { id }, select: { id: true } });
    if (current === null) {
      await client.tenantAdminRecoveryRequest.create({
        data: {
          id,
          tenantId: request.tenantId.toString(),
          beneficiaryUserId: request.beneficiaryUserId.toString(),
          requestedByUserId: request.requestedByUserId.toString(),
          reason: request.reason,
          status: request.status,
          requestedAt: request.requestedAt,
        },
      });
      return true;
    }
    if (request.status !== 'APPROVED' || request.approvedByUserId === null || request.approvedAt === null) {
      throw new Error('TenantAdminRecoveryRequestRepository.save : transition persistée invalide.');
    }
    const updated = await client.tenantAdminRecoveryRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        approvedByUserId: request.approvedByUserId.toString(),
        approvedAt: request.approvedAt,
      },
    });
    request.pullDomainEvents();
    return updated.count === 1;
  }

  async findById(id: TenantAdminRecoveryRequestId): Promise<TenantAdminRecoveryRequest | null> {
    const row = await resolvePrismaClient(this.prisma).tenantAdminRecoveryRequest.findUnique({ where: { id: id.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  private toDomain(row: TenantAdminRecoveryRequestRow): TenantAdminRecoveryRequest {
    return TenantAdminRecoveryRequest.reconstitute(assertValid(TenantAdminRecoveryRequestId.create(row.id)), {
      tenantId: assertValid(TenantId.create(row.tenantId)),
      beneficiaryUserId: assertValid(UserAccountId.create(row.beneficiaryUserId)),
      requestedByUserId: assertValid(UserAccountId.create(row.requestedByUserId)),
      reason: row.reason,
      status: row.status as TenantAdminRecoveryRequestStatus,
      approvedByUserId: row.approvedByUserId === null ? null : assertValid(UserAccountId.create(row.approvedByUserId)),
      requestedAt: row.requestedAt,
      approvedAt: row.approvedAt,
    });
  }
}
