import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import type { UserAccountId } from './value-objects/UserAccountId.js';
import type { TenantAdminRecoveryRequestId } from './value-objects/TenantAdminRecoveryRequestId.js';

export class TenantAdminRecoveryAlreadyApprovedError extends Error {
  constructor() {
    super("La demande de récupération d'accès a déjà été approuvée.");
    this.name = 'TenantAdminRecoveryAlreadyApprovedError';
  }
}

export class TenantAdminRecoveryRequesterCannotApproveError extends Error {
  constructor() {
    super("Le demandeur ne peut pas approuver sa propre récupération d'accès.");
    this.name = 'TenantAdminRecoveryRequesterCannotApproveError';
  }
}

export type ApproveTenantAdminRecoveryError =
  | TenantAdminRecoveryAlreadyApprovedError
  | TenantAdminRecoveryRequesterCannotApproveError;

export type TenantAdminRecoveryRequestStatus = 'PENDING' | 'APPROVED';

interface TenantAdminRecoveryRequestProps {
  readonly tenantId: TenantId;
  readonly beneficiaryUserId: UserAccountId;
  readonly requestedByUserId: UserAccountId;
  readonly reason: string;
  status: TenantAdminRecoveryRequestStatus;
  approvedByUserId: UserAccountId | null;
  readonly requestedAt: Date;
  approvedAt: Date | null;
}

/**
 * Récupération de l'accès administrateur d'un tenant, distincte du break-glass MFA plateforme.
 * L'agrégat impose le contrôle applicatif à deux personnes : approbateur différent du demandeur.
 * Les deux vérifications d'identité supplémentaires sont hors bande et ne sont pas prétendues
 * vérifiées par cet agrégat (voir 03-open-decisions.md).
 */
export class TenantAdminRecoveryRequest extends AggregateRoot<TenantAdminRecoveryRequestId> {
  private props: TenantAdminRecoveryRequestProps;

  private constructor(id: TenantAdminRecoveryRequestId, props: TenantAdminRecoveryRequestProps) {
    super(id);
    this.props = props;
  }

  static request(params: {
    id: TenantAdminRecoveryRequestId;
    tenantId: TenantId;
    beneficiaryUserId: UserAccountId;
    requestedByUserId: UserAccountId;
    reason: string;
    clock: Clock;
  }): Result<TenantAdminRecoveryRequest, 'REASON_REQUIRED'> {
    const reason = params.reason.trim();
    if (reason.length === 0) {
      return Result.failure('REASON_REQUIRED');
    }
    const request = new TenantAdminRecoveryRequest(params.id, {
      tenantId: params.tenantId,
      beneficiaryUserId: params.beneficiaryUserId,
      requestedByUserId: params.requestedByUserId,
      reason,
      status: 'PENDING',
      approvedByUserId: null,
      requestedAt: params.clock.now(),
      approvedAt: null,
    });
    // Pas de DomainEvent : demande et approbation sont auditées directement dans leur transaction,
    // sans notification ni effet asynchrone décidé à ce stade.
    return Result.success(request);
  }

  approve(params: {
    approverUserId: UserAccountId;
    clock: Clock;
  }): Result<void, ApproveTenantAdminRecoveryError> {
    if (this.props.status !== 'PENDING') {
      return Result.failure(new TenantAdminRecoveryAlreadyApprovedError());
    }
    if (params.approverUserId.equals(this.props.requestedByUserId)) {
      return Result.failure(new TenantAdminRecoveryRequesterCannotApproveError());
    }
    this.props.status = 'APPROVED';
    this.props.approvedByUserId = params.approverUserId;
    this.props.approvedAt = params.clock.now();
    return Result.success(undefined);
  }

  static reconstitute(id: TenantAdminRecoveryRequestId, props: TenantAdminRecoveryRequestProps): TenantAdminRecoveryRequest {
    return new TenantAdminRecoveryRequest(id, props);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get beneficiaryUserId(): UserAccountId {
    return this.props.beneficiaryUserId;
  }

  get requestedByUserId(): UserAccountId {
    return this.props.requestedByUserId;
  }

  get reason(): string {
    return this.props.reason;
  }

  get status(): TenantAdminRecoveryRequestStatus {
    return this.props.status;
  }

  get approvedByUserId(): UserAccountId | null {
    return this.props.approvedByUserId;
  }

  get requestedAt(): Date {
    return this.props.requestedAt;
  }

  get approvedAt(): Date | null {
    return this.props.approvedAt;
  }
}
