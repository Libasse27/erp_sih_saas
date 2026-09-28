import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { HealthFacilityCreated } from './events/HealthFacilityCreated.js';
import { HealthFacilityRenamed } from './events/HealthFacilityRenamed.js';
import type { FacilityName } from './value-objects/FacilityName.js';
import type { FacilityStatus } from './value-objects/FacilityStatus.js';

export class FacilityAlreadySuspendedError extends Error {
  constructor() {
    super('Cet etablissement est deja suspendu.');
    this.name = 'FacilityAlreadySuspendedError';
  }
}

export class FacilityAlreadyActiveError extends Error {
  constructor() {
    super('Cet etablissement est deja actif.');
    this.name = 'FacilityAlreadyActiveError';
  }
}

/**
 * Renommage demande vers un nom STRICTEMENT identique au nom courant (apres normalisation
 * `FacilityName`, donc comparaison insensible aux espaces superflus deja geree par le VO —
 * `trim()`, aucune autre normalisation). Convention retenue par coherence avec le seul precedent
 * du depot pour "changement demande explicitement vers une valeur identique a l'etat courant" :
 * `ProrationCalculator.calculateUpgradeProration()` (`NOT_AN_UPGRADE` quand `newPrice` n'est pas
 * strictement superieur a `oldPrice`) — un `Result.failure` NOMME, jamais un succes silencieux
 * sans evenement (ce dernier idiome, illustre par `Subscription.applyPlanUpgrade()`, couvre un cas
 * different : une RE-LIVRAISON at-least-once d'un evenement DEJA applique, pas une commande
 * utilisateur explicite portant sur une valeur inchangee).
 */
export class FacilityNameUnchangedError extends Error {
  constructor() {
    super('Le nouveau nom est identique au nom actuel.');
    this.name = 'FacilityNameUnchangedError';
  }
}

interface HealthFacilityProps {
  name: FacilityName;
  status: FacilityStatus;
  readonly createdAt: Date;
}

/**
 * Agregat racine du tenant (01-target-architecture.md §6.4, ADR-0001). Volontairement minimal :
 * cette etape (Phase 0, etape 3/13) porte sur l'isolation RLS, pas sur le modele metier complet
 * de l'etablissement — `FacilityType`, `Service`, `Building`, `Room`, `Bed` restent hors
 * perimetre (phases ulterieures).
 *
 * Choix structurant : `id` EST le `TenantId` (pas un identifiant distinct qui referencerait un
 * tenant separe). C'est la seule table du schema `public` ou la ligne représente le tenant
 * lui-meme plutot qu'une donnee appartenant a un tenant — voir le commentaire sur la colonne
 * `tenant_id` dupliquee dans le schema Prisma pour la consequence de ce choix sur le garde-fou
 * RLS generique (ADR-0001, Consequences).
 *
 * Statut volontairement minimal (`ACTIVE`/`SUSPENDED`) : aucun etat pilote par la
 * facturation/abonnement (type "mode degrade", O-03) n'est invente ici — ce sera la
 * responsabilite du futur module Subscription, qui composera avec ce statut sans le remplacer.
 */
export class HealthFacility extends AggregateRoot<TenantId> {
  private props: HealthFacilityProps;

  private constructor(id: TenantId, props: HealthFacilityProps) {
    super(id);
    this.props = props;
  }

  static create(params: {
    name: FacilityName;
    /**
     * Identifiant du `UserAccount` a l'origine du provisioning (ADR-0008 §9, amendement 1) —
     * PORTE UNIQUEMENT PAR L'EVENEMENT EMIS ICI (`HealthFacilityCreated.ownerUserId`), jamais
     * stocke sur cet agregat (voir le commentaire de tete de la classe : `HealthFacility` reste
     * volontairement minimal, `ACTIVE`/`SUSPENDED` uniquement). Deja valide comme un
     * `UserAccountId` EXISTANT par l'appelant (`CreateHealthFacilityHandler`, via le port
     * `UserAccountExistenceChecker`) — cette methode ne revalide pas l'existence, elle fait
     * seulement circuler la valeur vers l'evenement.
     */
    ownerUserId: string;
    clock: Clock;
    idGenerator: IdGenerator;
  }): HealthFacility {
    const idResult = TenantId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      // L'IdGenerator est cense produire un UUID v4 valide (UuidGenerator, crypto.randomUUID).
      // Une valeur invalide ici est un bug d'infrastructure, pas un echec metier attendu.
      throw new Error('IdGenerator a produit un identifiant invalide pour HealthFacility.');
    }
    const id = idResult.getValue();
    const facility = new HealthFacility(id, {
      name: params.name,
      status: 'ACTIVE',
      createdAt: params.clock.now(),
    });
    facility.addDomainEvent(
      HealthFacilityCreated.create({
        healthFacilityId: id.toString(),
        name: params.name.value,
        ownerUserId: params.ownerUserId,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return facility;
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: TenantId, props: HealthFacilityProps): HealthFacility {
    return new HealthFacility(id, props);
  }

  get name(): FacilityName {
    return this.props.name;
  }

  get status(): FacilityStatus {
    return this.props.status;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  isActive(): boolean {
    return this.props.status === 'ACTIVE';
  }

  suspend(): Result<void, FacilityAlreadySuspendedError> {
    if (this.props.status === 'SUSPENDED') {
      return Result.failure(new FacilityAlreadySuspendedError());
    }
    this.props.status = 'SUSPENDED';
    return Result.success(undefined);
  }

  reactivate(): Result<void, FacilityAlreadyActiveError> {
    if (this.props.status === 'ACTIVE') {
      return Result.failure(new FacilityAlreadyActiveError());
    }
    this.props.status = 'ACTIVE';
    return Result.success(undefined);
  }

  /**
   * Renomme l'etablissement (Phase 1, premier increment vertical, permission
   * `tenant-config:administer`). `newName` est deja un `FacilityName` VALIDE — la normalisation
   * (`trim`, non-vide, <= 200 caracteres) est ENTIEREMENT la responsabilite du VO
   * (`FacilityName.create()`), jamais redupliquee ici (regle d'escalade : reutiliser une regle
   * deja decidee, ne pas en inventer une seconde). Refuse explicitement (`FacilityNameUnchangedError`,
   * pas un succes silencieux) un renommage vers un nom strictement identique au nom courant —
   * voir le commentaire de tete de cette erreur pour la convention retenue. N'emet
   * `HealthFacilityRenamed` que sur un changement EFFECTIF.
   */
  rename(newName: FacilityName, clock: Clock, idGenerator: IdGenerator): Result<void, FacilityNameUnchangedError> {
    if (this.props.name.equals(newName)) {
      return Result.failure(new FacilityNameUnchangedError());
    }
    const previousName = this.props.name;
    this.props.name = newName;
    this.addDomainEvent(
      HealthFacilityRenamed.create({
        healthFacilityId: this.id.toString(),
        previousName: previousName.value,
        newName: newName.value,
        clock,
        idGenerator,
      }),
    );
    return Result.success(undefined);
  }
}
