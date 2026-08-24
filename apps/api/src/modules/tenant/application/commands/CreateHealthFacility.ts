import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { HealthFacility } from '../../domain/HealthFacility.js';
import type { HealthFacilityRepository } from '../../domain/ports/HealthFacilityRepository.js';
import { FacilityName } from '../../domain/value-objects/FacilityName.js';

export interface CreateHealthFacilityCommand {
  readonly name: string;
}

export type CreateHealthFacilityError = 'INVALID_NAME';

export interface CreateHealthFacilityResult {
  readonly tenantId: string;
}

/**
 * Provisionne un nouvel etablissement, c'est-a-dire un nouveau tenant (01-target-architecture.md
 * §6.4). Cette commande ne couvre QUE la creation de l'agregat `HealthFacility` lui-meme — la
 * Saga complete de provisioning (compte admin, abonnement, paiement, seed de configuration,
 * §6.3) appartient a des etapes ulterieures (modules Subscription/Payment, hors perimetre ici).
 *
 * Amorçage RLS (ADR-0001 couche 4) — a lire avant de modifier cette methode :
 * la politique `tenant_isolation` sur `HealthFacility` s'applique aussi a l'INSERT (WITH CHECK
 * derive du USING, faute de clause WITH CHECK explicite — voir migration SQL). Autrement dit,
 * `app.tenant_id` DOIT deja correspondre a la ligne qu'on s'apprete a inserer AVANT le premier
 * INSERT, alors meme que ce tenant n'existe encore nulle part. C'est le probleme classique
 * d'amorçage RLS : il n'existe aucune ligne existante depuis laquelle "decouvrir" un tenant_id.
 * La resolution retenue ici est identique au reste du code (UserAccount.register,
 * UserTenantMembership.grant) : l'identifiant est genere COTE APPLICATIF, de maniere synchrone
 * et sans I/O (IdGenerator = UUID v4, jamais une sequence DB), avant l'ouverture de la
 * transaction. Une fois `facility.id` connu, il sert a la fois d'identite de l'agregat ET de
 * contexte RLS (`{ tenantId: facility.id }`) pour LA MEME transaction qui va l'inserer — aucune
 * fenetre ou une ligne existe sans que `app.tenant_id` la couvre deja.
 */
export class CreateHealthFacilityHandler {
  constructor(
    private readonly repository: HealthFacilityRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: CreateHealthFacilityCommand,
  ): Promise<Result<CreateHealthFacilityResult, CreateHealthFacilityError>> {
    const nameResult = FacilityName.create(command.name);
    if (nameResult.isFailure()) {
      return Result.failure('INVALID_NAME');
    }
    const name = nameResult.getValue();

    const facility = HealthFacility.create({ name, clock: this.clock, idGenerator: this.idGenerator });

    return this.unitOfWork.withTransaction(
      async () => {
        await this.repository.save(facility, facility.id);
        return Result.success({ tenantId: facility.id.toString() });
      },
      { tenantId: facility.id },
    );
  }
}
