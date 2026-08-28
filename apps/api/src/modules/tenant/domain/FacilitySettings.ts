import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import { Result } from '../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { FacilityConfigurationSeeded } from './events/FacilityConfigurationSeeded.js';
import { ProvisioningCompleted } from './events/ProvisioningCompleted.js';
import { FacilitySettingsId } from './value-objects/FacilitySettingsId.js';

export class ProvisioningAlreadyCompletedError extends Error {
  constructor() {
    super('Le provisioning de cet etablissement est deja marque termine.');
    this.name = 'ProvisioningAlreadyCompletedError';
  }
}

interface FacilitySettingsProps {
  readonly tenantId: TenantId;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly phoneCountryCode: string;
  readonly createdAt: Date;
  provisioningCompletedAt: Date | null;
}

/**
 * Configuration technique minimale d'un tenant, semee automatiquement en fin de Saga de
 * provisioning (ADR-0008 §10, amendement 1, Phase 0 etape 10/13) : parametres regionaux `fr-SN`,
 * fuseau horaire `Africa/Dakar`, devise `XOF`, indicatif telephonique `+221`. AUCUN CONTENU
 * METIER HOSPITALIER (services, batiments, catalogue d'actes) — perimetre strictement celui du
 * §6.4 de 01-target-architecture.md pour ce qui releve de Phase 1, non anticipe ici.
 *
 * `provisioningCompletedAt` — DECISION PROPRE A CETTE IMPLEMENTATION, NON NOMMEMENT COUVERTE PAR
 * L'ADR (a signaler a l'architecte, voir rapport de fin de tache) : simple MARQUEUR D'IDEMPOTENCE
 * pour la derniere etape de la Saga (`StartOnboarding` -> `ProvisioningCompleted`, ADR-0008 §11),
 * porte ICI plutot que sur `HealthFacility` pour ne jamais tenter `TenantModuleBackedAccessChecker`
 * de le consulter par raccourci (ADR-0008 §3/§11 : l'acces reste TOUJOURS derive dynamiquement de
 * `HealthFacility`/`Subscription`, jamais de cet indicateur de progression de Saga — verifie par
 * un test dedie, voir ProvisioningSaga.integration.test.ts). Reutilise `FacilitySettings` plutot
 * que d'introduire un troisieme agregat pour porter un seul champ : la ligne existe deja au moment
 * ou cette etape s'execute (elle est creee par l'etape precedente de la MEME Saga), et le
 * find-by-tenant necessaire a l'idempotence de la derniere etape est deja fourni par
 * `FacilitySettingsRepository.findByTenantId()`.
 */
export class FacilitySettings extends AggregateRoot<FacilitySettingsId> {
  private props: FacilitySettingsProps;

  private constructor(id: FacilitySettingsId, props: FacilitySettingsProps) {
    super(id);
    this.props = props;
  }

  static create(params: { tenantId: TenantId; clock: Clock; idGenerator: IdGenerator }): FacilitySettings {
    const idResult = FacilitySettingsId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      // L'IdGenerator est cense produire un UUID v4 valide — une valeur invalide ici est un bug
      // d'infrastructure, pas un echec metier attendu (meme raisonnement que HealthFacility.create()).
      throw new Error('IdGenerator a produit un identifiant invalide pour FacilitySettings.');
    }
    const id = idResult.getValue();
    const locale = 'fr-SN';
    const timezone = 'Africa/Dakar';
    const currency = 'XOF';
    const phoneCountryCode = '+221';
    const settings = new FacilitySettings(id, {
      tenantId: params.tenantId,
      locale,
      timezone,
      currency,
      phoneCountryCode,
      createdAt: params.clock.now(),
      provisioningCompletedAt: null,
    });
    settings.addDomainEvent(
      FacilityConfigurationSeeded.create({
        facilitySettingsId: id.toString(),
        tenantId: params.tenantId.toString(),
        locale,
        timezone,
        currency,
        phoneCountryCode,
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return settings;
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: FacilitySettingsId, props: FacilitySettingsProps): FacilitySettings {
    return new FacilitySettings(id, props);
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get locale(): string {
    return this.props.locale;
  }

  get timezone(): string {
    return this.props.timezone;
  }

  get currency(): string {
    return this.props.currency;
  }

  get phoneCountryCode(): string {
    return this.props.phoneCountryCode;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get provisioningCompletedAt(): Date | null {
    return this.props.provisioningCompletedAt;
  }

  isProvisioningCompleted(): boolean {
    return this.props.provisioningCompletedAt !== null;
  }

  /**
   * Derniere etape de la Saga de provisioning (ADR-0008 §11) — idempotente par construction :
   * un rejeu (redelivrance Outbox) trouve `provisioningCompletedAt` deja renseigne et renvoie un
   * `Result.failure` METIER (meme idiome que `MEMBERSHIP_ALREADY_EXISTS`/`SUBSCRIPTION_ALREADY_EXISTS`
   * ailleurs dans ce depot), jamais une exception ni un second `ProvisioningCompleted` emis.
   */
  completeProvisioning(clock: Clock, idGenerator: IdGenerator): Result<void, ProvisioningAlreadyCompletedError> {
    if (this.props.provisioningCompletedAt !== null) {
      return Result.failure(new ProvisioningAlreadyCompletedError());
    }
    this.props.provisioningCompletedAt = clock.now();
    this.addDomainEvent(
      ProvisioningCompleted.create({
        facilitySettingsId: this.id.toString(),
        tenantId: this.props.tenantId.toString(),
        clock,
        idGenerator,
      }),
    );
    return Result.success(undefined);
  }
}
