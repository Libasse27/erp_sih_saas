import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { UserTenantMembershipId } from '../../domain/value-objects/UserTenantMembershipId.js';
import type { SessionStore } from '../ports/SessionStore.js';
import type { RefreshTokenIssuer } from '../services/RefreshTokenIssuer.js';
import type { MembershipAuditTrail } from '../ports/MembershipAuditTrail.js';

export interface RevokeMembershipCommand {
  readonly membershipId: string;
  readonly tenantId: string;
}

export type RevokeMembershipError =
  | 'INVALID_MEMBERSHIP_ID'
  | 'INVALID_TENANT_ID'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_ALREADY_REVOKED';

/**
 * Revocation d'un membership (O-05, regle derivee non optionnelle) : interdit immediatement
 * l'ouverture d'un nouveau contexte pour ce tenant (garanti par
 * `UserTenantMembershipRepository.findActiveByUserAndTenant`, filtre sur `status = ACTIVE`) et
 * invalide les contextes de session deja ouverts pour ce membership.
 */
export class RevokeMembershipHandler {
  constructor(
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly sessionStore: SessionStore,
    private readonly refreshTokenIssuer: RefreshTokenIssuer,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly membershipAuditTrail: MembershipAuditTrail,
  ) {}

  async execute(command: RevokeMembershipCommand): Promise<Result<void, RevokeMembershipError>> {
    const membershipIdResult = UserTenantMembershipId.create(command.membershipId);
    if (membershipIdResult.isFailure()) {
      return Result.failure('INVALID_MEMBERSHIP_ID');
    }
    const tenantIdResult = TenantId.create(command.tenantId);
    if (tenantIdResult.isFailure()) {
      return Result.failure('INVALID_TENANT_ID');
    }
    const membershipId = membershipIdResult.getValue();
    const tenantId = tenantIdResult.getValue();

    const outcome = await this.unitOfWork.withTransaction(async () => {
      const membership = await this.membershipRepository.findById(membershipId, tenantId);
      if (membership === null) {
        return Result.failure<void, RevokeMembershipError>('MEMBERSHIP_NOT_FOUND');
      }
      const revokeResult = membership.revoke(this.clock, this.idGenerator);
      if (revokeResult.isFailure()) {
        return Result.failure<void, RevokeMembershipError>('MEMBERSHIP_ALREADY_REVOKED');
      }
      await this.membershipRepository.save(membership, tenantId);

      // ADR-0009 §2.2/§4 — meme transaction que la mutation de l'agregat. `actorKind: 'SYSTEM'` :
      // aucun appelant de production n'invoque aujourd'hui cette commande (aucun endpoint
      // interactif de gestion de membership n'existe encore, voir le rapport de cette etape) —
      // contrairement a `GrantMembershipHandler` (qui recoit deja un `createdBy` reel), aucun
      // identifiant d'acteur n'est disponible ici.
      await this.membershipAuditTrail.record({
        eventType: 'MEMBERSHIP_REVOKED',
        outcome: 'SUCCESS',
        tenantId: tenantId.toString(),
        actorKind: 'SYSTEM',
        actorUserId: null,
        actorRoleCodes: [],
        subjectUserId: membership.userId.toString(),
        targetId: membershipId.toString(),
        reason: null,
        sessionId: null,
        correlationId: null,
      });

      return Result.success<void, RevokeMembershipError>(undefined);
    }, { tenantId });

    if (outcome.isSuccess()) {
      // ORDRE DELIBERE (correctif securite, revue independante) : revoquer les chaines de refresh
      // AVANT de vider l'index de sessions Redis — voir CloseSessionHandler pour le raisonnement
      // complet (fail-closed : un refresh concurrent qui commit APRES la revocation Postgres mais
      // AVANT le nettoyage Redis echoue proprement, jamais l'inverse).
      await this.refreshTokenIssuer.revokeAllForMembership(membershipId.toString(), 'MEMBERSHIP_REVOKED');
      await this.sessionStore.deleteAllForMembership(membershipId.toString());
    }
    return outcome;
  }
}
