import { Result } from '../../../../shared-kernel/domain/Result.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import type { AuditEntryRepository } from '../../domain/ports/AuditEntryRepository.js';
import type { AuditEntryHasher } from '../../domain/ports/AuditEntryHasher.js';
import { AuditChainKey } from '../../domain/value-objects/AuditChainKey.js';
import { buildAuditEntryCanonicalPayload } from '../../domain/AuditEntryCanonicalPayload.js';
import type { AuditReadPrincipal } from '../AuditReadPrincipal.js';

export type RequestedChain = { readonly kind: 'PLATFORM' } | { readonly kind: 'TENANT'; readonly tenantId: string };

export type VerifyAuditChainIntegrityError = 'FORBIDDEN' | 'INVALID_QUERY';

export interface VerifyAuditChainIntegrityResult {
  readonly chainKey: string;
  readonly verifiedCount: number;
  /** Entrees "pre-chaine" (`entry_hash IS NULL`) — COMPTEES et SIGNALEES, jamais ignorees en silence (ADR-0009 §5.3). */
  readonly preChainCount: number;
  /** `null` = chaine integre sur tout le segment parcouru. Sinon, premiere `chainSequence` dont l'empreinte/chainage ne correspond plus. */
  readonly firstBrokenSequence: number | null;
}

/** Taille de lot bornee pour la lecture par lots de `readChainSegment` (ADR-0009 §5.4 : "lecture seule, aucun effet de bord... par lots bornes"). */
const CHAIN_SEGMENT_BATCH_SIZE = 500;

/**
 * Query handler de VERIFICATION d'integrite de chaine (ADR-0009 §5.4) — lecture seule, AUCUN
 * effet de bord. Soumis au MEME perimetre d'isolation que la lecture (§9) : un principal `TENANT`
 * ne peut verifier que SA PROPRE chaine ; un principal `PLATFORM` peut verifier n'importe quelle
 * chaine (tenant arbitraire ou plateforme — decision complementaire validee par le responsable
 * technique). N'est PAS expose en HTTP a cette etape (B2, §5.4) — reserve a un futur usage
 * outillage/CLI.
 */
export class VerifyAuditChainIntegrityHandler {
  constructor(
    private readonly repository: AuditEntryRepository,
    private readonly hasher: AuditEntryHasher,
  ) {}

  async execute(
    principal: AuditReadPrincipal,
    requestedChain: RequestedChain,
  ): Promise<Result<VerifyAuditChainIntegrityResult, VerifyAuditChainIntegrityError>> {
    let chainKey: AuditChainKey;

    if (principal.kind === 'TENANT') {
      if (requestedChain.kind === 'PLATFORM' || requestedChain.tenantId !== principal.tenantId) {
        return Result.failure('FORBIDDEN');
      }
      const tenantIdResult = TenantId.create(principal.tenantId);
      if (tenantIdResult.isFailure()) {
        throw new Error(`VerifyAuditChainIntegrityHandler : AuditReadPrincipal.tenantId invalide ("${principal.tenantId}").`);
      }
      chainKey = AuditChainKey.forTenant(tenantIdResult.getValue());
    } else if (requestedChain.kind === 'PLATFORM') {
      chainKey = AuditChainKey.platform();
    } else {
      const tenantIdResult = TenantId.create(requestedChain.tenantId);
      if (tenantIdResult.isFailure()) {
        return Result.failure('INVALID_QUERY');
      }
      chainKey = AuditChainKey.forTenant(tenantIdResult.getValue());
    }

    const preChainCount = await this.repository.countUnchained(chainKey);

    let verifiedCount = 0;
    let firstBrokenSequence: number | null = null;
    let expectedPreviousHash: string | null = null;
    let fromSequence = 0;

    outer: for (;;) {
      const segment = await this.repository.readChainSegment(chainKey, fromSequence, CHAIN_SEGMENT_BATCH_SIZE);
      if (segment.length === 0) {
        break;
      }
      for (const entry of segment) {
        const sequence = entry.chainSequence;
        if (sequence === null || entry.entryHash === null) {
          // Ne devrait pas arriver : `readChainSegment` filtre `chain_sequence >= fromSequence`,
          // structurellement exclusif des lignes "pre-chaine" (NULL). Une incoherence ici trahit
          // un bug du repository, pas un echec metier attendu.
          throw new Error('VerifyAuditChainIntegrityHandler : entree sans chainSequence/entryHash renvoyee par readChainSegment.');
        }
        if (entry.previousEntryHash !== expectedPreviousHash) {
          firstBrokenSequence = sequence;
          break outer;
        }
        const canonicalPayload = buildAuditEntryCanonicalPayload({
          id: entry.id.toString(),
          chainKey: chainKey.toString(),
          chainSequence: sequence,
          previousEntryHash: entry.previousEntryHash,
          category: entry.category,
          eventType: entry.eventType,
          outcome: entry.outcome,
          tenantId: entry.tenantId,
          actorKind: entry.actorKind,
          actorUserId: entry.actorUserId,
          actorRoleCodes: entry.actorRoleCodes,
          subjectUserId: entry.subjectUserId,
          targetType: entry.targetType,
          targetId: entry.targetId,
          reason: entry.reason,
          sessionRef: entry.sessionRef,
          correlationId: entry.correlationId,
          occurredAt: entry.occurredAt,
        });
        const recomputedHash = this.hasher.hash(canonicalPayload);
        if (recomputedHash !== entry.entryHash) {
          firstBrokenSequence = sequence;
          break outer;
        }
        expectedPreviousHash = entry.entryHash;
        verifiedCount += 1;
      }
      // Correctif securite 2026-09-01 (vulnerabilite ELEVEE, revue independante) : la sortie de
      // boucle NE DOIT JAMAIS comparer `segment.length` a `CHAIN_SEGMENT_BATCH_SIZE` — rien ne
      // garantit que le repository serve un lot de cette taille exacte (voir
      // `PrismaAuditEntryRepository.readChainSegment`, dont la borne reelle est independante de
      // cette constante). La SEULE condition d'arret correcte, quel que soit le lot reellement
      // servi, est un segment VIDE (deja testee en tete de boucle, `segment.length === 0`) : tant
      // qu'une iteration renvoie au moins une ligne, il peut en exister d'autres au-dela.
      const lastEntry = segment[segment.length - 1];
      fromSequence = (lastEntry?.chainSequence ?? 0) + 1;
    }

    return Result.success({ chainKey: chainKey.toString(), verifiedCount, preChainCount, firstBrokenSequence });
  }
}
