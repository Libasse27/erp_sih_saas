import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { HealthFacility } from '../../domain/HealthFacility.js';
import type { HealthFacilityRepository } from '../../domain/ports/HealthFacilityRepository.js';
import { FacilityName } from '../../domain/value-objects/FacilityName.js';
import type { UserAccountExistenceChecker } from '../ports/UserAccountExistenceChecker.js';
import type { ProvisioningAuditTrail } from '../ports/ProvisioningAuditTrail.js';

export interface CreateHealthFacilityCommand {
  readonly name: string;
  /**
   * Identifiant du `UserAccount` a l'origine du provisioning (ADR-0008 §9, amendement 1,
   * Phase 0 etape 10/13) — OBLIGATOIRE, jamais optionnel. Doit correspondre a un `UserAccount`
   * REELLEMENT EXISTANT (verifie via `UserAccountExistenceChecker`, voir plus bas) : ce champ
   * n'est JAMAIS une preuve d'autorite acceptee telle quelle depuis un client non authentifie —
   * sa provenance legitime est le `UserAccountId` fraichement cree par `CreateUserAccountHandler`
   * DANS LA MEME requete serveur (futur point d'entree HTTP d'inscription, hors perimetre de
   * cette Saga, voir ADR-0008 residu 1). Ne devient PAS une propriete persistante de
   * `HealthFacility` (voir HealthFacility.create()) : uniquement porte par
   * `HealthFacilityCreated.ownerUserId`, une donnee de CORRELATION du provisioning, jamais une
   * relation `User.tenantId`.
   */
  readonly ownerUserId: string;
}

export type CreateHealthFacilityError = 'INVALID_NAME' | 'INVALID_OWNER_USER_ID' | 'OWNER_ACCOUNT_NOT_FOUND';

export interface CreateHealthFacilityResult {
  readonly tenantId: string;
}

/**
 * Provisionne un nouvel etablissement, c'est-a-dire un nouveau tenant (01-target-architecture.md
 * §6.4). Cette commande ne couvre QUE la creation de l'agregat `HealthFacility` lui-meme — la
 * Saga complete de provisioning (compte admin, abonnement, paiement, seed de configuration,
 * §6.3) appartient a des etapes ulterieures (modules Subscription/Payment/Identity, chorographiees
 * via l'Outbox depuis `HealthFacilityCreated`, ADR-0008 §1/§4/§9).
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
 *
 * Validation de `ownerUserId` (ADR-0008 §9, amendement 1) : verifiee via le port cross-module
 * `UserAccountExistenceChecker` (jamais un import de `modules/identity/domain/`, regle
 * dependency-cruiser `no-cross-module-domain-import`) AVANT toute creation — "sans ownerUserId,
 * ou avec un ownerUserId ne correspondant a aucun UserAccount existant -> echec explicite, aucune
 * HealthFacility creee" (tests attendus ADR-0008). Une chaine VIDE est rejetee immediatement,
 * SANS appel au port (evite un aller-retour I/O pour un cas trivialement invalide) ; toute autre
 * valeur malformee (pas un UUID) est simplement traitee comme "compte introuvable" par le port —
 * ce module ne duplique jamais la logique de validation de format d'`UserAccountId`, propriete du
 * module Identity.
 */
export class CreateHealthFacilityHandler {
  constructor(
    private readonly repository: HealthFacilityRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly userAccountExistenceChecker: UserAccountExistenceChecker,
    private readonly provisioningAuditTrail: ProvisioningAuditTrail,
  ) {}

  async execute(
    command: CreateHealthFacilityCommand,
  ): Promise<Result<CreateHealthFacilityResult, CreateHealthFacilityError>> {
    const nameResult = FacilityName.create(command.name);
    if (nameResult.isFailure()) {
      return Result.failure('INVALID_NAME');
    }
    const name = nameResult.getValue();

    const ownerUserId = command.ownerUserId.trim();
    if (ownerUserId.length === 0) {
      return Result.failure('INVALID_OWNER_USER_ID');
    }

    const ownerExists = await this.userAccountExistenceChecker.exists(ownerUserId);
    if (!ownerExists) {
      return Result.failure('OWNER_ACCOUNT_NOT_FOUND');
    }

    const facility = HealthFacility.create({
      name,
      ownerUserId,
      clock: this.clock,
      idGenerator: this.idGenerator,
    });

    return this.unitOfWork.withTransaction(
      async () => {
        await this.repository.save(facility, facility.id);
        // ADR-0009 §2.2/§4 — ecrite DANS LA MEME transaction que la mutation de l'agregat.
        // `actorKind: 'SYSTEM'` : aucun acteur n'est threade jusqu'ici (aucune session
        // n'existe encore au moment de l'auto-inscription, voir le rapport de cette etape) ;
        // `subjectUserId: ownerUserId` reste renseigne (le sujet REEL de ce provisioning).
        await this.provisioningAuditTrail.record({
          eventType: 'PROVISIONING_FACILITY_CREATED',
          outcome: 'SUCCESS',
          tenantId: facility.id.toString(),
          actorKind: 'SYSTEM',
          actorUserId: null,
          subjectUserId: ownerUserId,
          targetType: 'HEALTH_FACILITY',
          targetId: facility.id.toString(),
          reason: null,
          sessionId: null,
          correlationId: null,
        });
        return Result.success({ tenantId: facility.id.toString() });
      },
      { tenantId: facility.id },
    );
  }
}
