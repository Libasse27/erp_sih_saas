import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { SuperAdminBreakGlassApproved } from './events/SuperAdminBreakGlassApproved.js';
import { SuperAdminBreakGlassRequested } from './events/SuperAdminBreakGlassRequested.js';
import { UserAccountId } from './value-objects/UserAccountId.js';
import type { SuperAdminBreakGlassRequestId } from './value-objects/SuperAdminBreakGlassRequestId.js';

export class RequesterCannotTargetSelfError extends Error {
  constructor() {
    super("Un SUPER_ADMIN ne peut pas demander sa propre recuperation break-glass (A ne peut jamais etre B).");
    this.name = 'RequesterCannotTargetSelfError';
  }
}

export class BreakGlassReasonRequiredError extends Error {
  constructor() {
    super('Un motif est obligatoire pour une demande de recuperation break-glass.');
    this.name = 'BreakGlassReasonRequiredError';
  }
}

export class RequestNotPendingError extends Error {
  constructor() {
    super('Cette demande de recuperation break-glass a deja ete approuvee.');
    this.name = 'RequestNotPendingError';
  }
}

export class ApproverCannotTargetSelfError extends Error {
  constructor() {
    super('Le sujet dune demande de recuperation break-glass ne peut jamais approuver sa propre demande (A ne peut jamais etre C).');
    this.name = 'ApproverCannotTargetSelfError';
  }
}

export class ApproverCannotBeRequesterError extends Error {
  constructor() {
    super('Le demandeur dune recuperation break-glass ne peut jamais approuver sa propre demande (B ne peut jamais etre C).');
    this.name = 'ApproverCannotBeRequesterError';
  }
}

export type RequestBreakGlassError = RequesterCannotTargetSelfError | BreakGlassReasonRequiredError;
export type ApproveBreakGlassError = RequestNotPendingError | ApproverCannotTargetSelfError | ApproverCannotBeRequesterError;

export type SuperAdminBreakGlassRequestStatus = 'PENDING' | 'APPROVED';

interface SuperAdminBreakGlassRequestProps {
  readonly requestedByUserId: UserAccountId;
  readonly subjectUserAccountId: UserAccountId;
  readonly reason: string;
  status: SuperAdminBreakGlassRequestStatus;
  approvedByUserId: UserAccountId | null;
  readonly requestedAt: Date;
  approvedAt: Date | null;
}

/**
 * Recuperation break-glass d'un `SUPER_ADMIN` ayant perdu son facteur TOTP et epuise ses codes de
 * recuperation (ADR-0005 Amendement 1, O-04 residu 4 — jusqu'ici un verrouillage DEFINITIF, sans
 * mecanisme de contournement, cf. ADR-0005 § Residus original point 4).
 *
 * QUORUM STRICT DE DEUX `SUPER_ADMIN` DISTINCTS, JAMAIS UN APPROBATEUR UNIQUE : ces invariants
 * sont verifies ICI (domaine), pas seulement au niveau des handlers applicatifs (qui verifient en
 * plus des faits que le domaine ne peut pas connaitre — session PLATFORM, step-up MFA de
 * l'approbateur) — defense en profondeur, meme discipline que le reste du module `identity`.
 * Aucun chemin de code, ici ou ailleurs, ne permet a un unique acteur d'auto-approuver sa propre
 * demande ou celle dont il est le sujet, y compris quand seuls deux `SUPER_ADMIN` existent sur la
 * plateforme (ce cas reste un runbook operationnel hors bande, jamais une bascule applicative).
 */
export class SuperAdminBreakGlassRequest extends AggregateRoot<SuperAdminBreakGlassRequestId> {
  private props: SuperAdminBreakGlassRequestProps;

  private constructor(id: SuperAdminBreakGlassRequestId, props: SuperAdminBreakGlassRequestProps) {
    super(id);
    this.props = props;
  }

  static request(params: {
    id: SuperAdminBreakGlassRequestId;
    requestedByUserId: UserAccountId;
    subjectUserAccountId: UserAccountId;
    reason: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): Result<SuperAdminBreakGlassRequest, RequestBreakGlassError> {
    if (params.requestedByUserId.equals(params.subjectUserAccountId)) {
      return Result.failure(new RequesterCannotTargetSelfError());
    }
    const reason = params.reason.trim();
    if (reason.length === 0) {
      return Result.failure(new BreakGlassReasonRequiredError());
    }
    const now = params.clock.now();
    const request = new SuperAdminBreakGlassRequest(params.id, {
      requestedByUserId: params.requestedByUserId,
      subjectUserAccountId: params.subjectUserAccountId,
      reason,
      status: 'PENDING',
      approvedByUserId: null,
      requestedAt: now,
      approvedAt: null,
    });
    request.addDomainEvent(
      SuperAdminBreakGlassRequested.create({
        requestId: params.id.toString(),
        requestedByUserId: params.requestedByUserId.toString(),
        subjectUserAccountId: params.subjectUserAccountId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return Result.success(request);
  }

  approve(params: { approverUserId: UserAccountId; clock: Clock; idGenerator: IdGenerator }): Result<void, ApproveBreakGlassError> {
    if (this.props.status !== 'PENDING') {
      return Result.failure(new RequestNotPendingError());
    }
    if (params.approverUserId.equals(this.props.subjectUserAccountId)) {
      return Result.failure(new ApproverCannotTargetSelfError());
    }
    if (params.approverUserId.equals(this.props.requestedByUserId)) {
      return Result.failure(new ApproverCannotBeRequesterError());
    }
    const now = params.clock.now();
    this.props.status = 'APPROVED';
    this.props.approvedByUserId = params.approverUserId;
    this.props.approvedAt = now;
    this.addDomainEvent(
      SuperAdminBreakGlassApproved.create({
        requestId: this.id.toString(),
        requestedByUserId: this.props.requestedByUserId.toString(),
        approvedByUserId: params.approverUserId.toString(),
        subjectUserAccountId: this.props.subjectUserAccountId.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return Result.success(undefined);
  }

  static reconstitute(id: SuperAdminBreakGlassRequestId, props: SuperAdminBreakGlassRequestProps): SuperAdminBreakGlassRequest {
    return new SuperAdminBreakGlassRequest(id, props);
  }

  get requestedByUserId(): UserAccountId {
    return this.props.requestedByUserId;
  }

  get subjectUserAccountId(): UserAccountId {
    return this.props.subjectUserAccountId;
  }

  get reason(): string {
    return this.props.reason;
  }

  get status(): SuperAdminBreakGlassRequestStatus {
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
