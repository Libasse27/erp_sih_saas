import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { PlanId } from './value-objects/PlanId.js';
import type { PlanCode } from './value-objects/PlanCode.js';
import type { PlanLimits } from './value-objects/PlanLimits.js';
import type { PlanName } from './value-objects/PlanName.js';

interface PlanProps {
  readonly code: PlanCode;
  readonly name: PlanName;
  readonly limits: PlanLimits;
  readonly createdAt: Date;
}

/**
 * Catalogue global de forfaits (`Plan`), niveau plateforme — schema `platform`, HORS RLS tenant
 * (ADR-0001 §3.3, 01-target-architecture.md §6.3). Gere par le Super Admin ; en pratique, cette
 * etape (Phase 0, etape 4/13) alimente le catalogue V1 fige par un seed idempotent
 * (`infrastructure/seed/seedSubscriptionCatalog.ts`), pas par une commande d'administration —
 * aucune commande `CreatePlan`/`UpdatePlanLimits` n'est demandee par cette etape, donc aucune
 * n'est ajoutee (YAGNI, cf. regle d'escalade du system prompt : ne pas etendre le perimetre).
 *
 * `Plan` ne porte aucun tarif : voir `PlanPrice.ts` pour la raison de cette separation
 * (01-target-architecture.md §6.3 — "modifier un tarif n'affecte jamais retroactivement un
 * abonnement en cours").
 *
 * Pas de `features[]` : mentionne dans l'architecture cible mais non specifie ni demande par le
 * reliquat O-02 ferme le 2026-08-24 — ne pas inventer son contenu.
 */
export class Plan extends AggregateRoot<PlanId> {
  private readonly props: PlanProps;

  private constructor(id: PlanId, props: PlanProps) {
    super(id);
    this.props = props;
  }

  static create(params: {
    code: PlanCode;
    name: PlanName;
    limits: PlanLimits;
    clock: Clock;
    idGenerator: IdGenerator;
  }): Plan {
    const idResult = PlanId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      throw new Error('IdGenerator a produit un identifiant invalide pour Plan.');
    }
    return new Plan(idResult.getValue(), {
      code: params.code,
      name: params.name,
      limits: params.limits,
      createdAt: params.clock.now(),
    });
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: PlanId, props: PlanProps): Plan {
    return new Plan(id, props);
  }

  get code(): PlanCode {
    return this.props.code;
  }

  get name(): PlanName {
    return this.props.name;
  }

  get limits(): PlanLimits {
    return this.props.limits;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
