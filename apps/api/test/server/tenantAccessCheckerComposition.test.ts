import { describe, expect, it } from 'vitest';
import {
  IdentityModuleBackedUserAccountExistenceChecker,
  TenantModuleBackedAccessChecker,
} from '../../src/composition-root.js';
import { TenantId } from '../../src/shared-kernel/domain/value-objects/TenantId.js';
import { HealthFacility } from '../../src/modules/tenant/domain/HealthFacility.js';
import { FacilityName } from '../../src/modules/tenant/domain/value-objects/FacilityName.js';
import type { HealthFacilityRepository } from '../../src/modules/tenant/domain/ports/HealthFacilityRepository.js';
import { Subscription } from '../../src/modules/subscription/domain/Subscription.js';
import { PlanId } from '../../src/modules/subscription/domain/value-objects/PlanId.js';
import { PlanPriceId } from '../../src/modules/subscription/domain/value-objects/PlanPriceId.js';
import type { SubscriptionId } from '../../src/modules/subscription/domain/value-objects/SubscriptionId.js';
import type { SubscriptionRepository } from '../../src/modules/subscription/domain/ports/SubscriptionRepository.js';
import { UserAccount } from '../../src/modules/identity/domain/UserAccount.js';
import type { UserAccountRepository } from '../../src/modules/identity/domain/ports/UserAccountRepository.js';
import { Email } from '../../src/modules/identity/domain/value-objects/Email.js';
import { PasswordHash } from '../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { UserAccountId } from '../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { FixedClock, SequentialIdGenerator, uuidAt } from '../tenant/builders/testKit.js';

/**
 * Ajoute a la REVUE DE SECURITE de l'etape 10/13 (ADR-0008 §3).
 *
 * Constat qui a motive ce fichier : `TenantModuleBackedAccessChecker` est le SEUL controle
 * d'acces inter-tenant de la plateforme (c'est lui, et lui seul, qui decide si un contexte de
 * session peut s'ouvrir sur un tenant — voir `SessionContextIssuer.resolveMaterials()`), et
 * ADR-0008 §3 lui confie en plus la fermeture de la faille documentee au §Contexte de cette ADR
 * ("un tenant sans `Subscription` est deja ACCESSIBLE"). Pourtant, AUCUN test n'exercait cette
 * classe : chaque suite d'integration (serverContextPropagation, provisioningSaga) en
 * RE-IMPLEMENTAIT la regle a la main dans un objet litteral. Une regression introduite dans
 * `composition-root.ts` (inversion des `if`, `return 'ACCESSIBLE'` avance avant la lecture de
 * `Subscription`, suppression de la garde `isActive()`) aurait donc laisse la CI entierement au
 * vert tout en rouvrant une fuite d'acces inter-tenant.
 *
 * Ces tests exercent LES CLASSES REELLES importees de `composition-root.ts` — jamais une copie.
 * Doublures de ports en memoire uniquement (aucune I/O) : ce qui est teste ici est la REGLE DE
 * DECISION, pas la persistance (couverte, elle, par rls.test.ts / facilitySettingsRls.test.ts /
 * subscriptionRepositoryTenantIsolation.test.ts).
 */

const CLOCK = new FixedClock('2026-08-28T10:00:00Z');
const TENANT_A = TenantId.create(uuidAt(1)).getValue();
const TENANT_B = TenantId.create(uuidAt(2)).getValue();

class FakeHealthFacilityRepository implements HealthFacilityRepository {
  private readonly byTenantId = new Map<string, HealthFacility>();

  seedActive(tenantId: TenantId): HealthFacility {
    const facility = HealthFacility.reconstitute(tenantId, {
      name: FacilityName.create('Etablissement de test').getValue(),
      status: 'ACTIVE',
      createdAt: CLOCK.now(),
    });
    this.byTenantId.set(tenantId.toString(), facility);
    return facility;
  }

  seedSuspended(tenantId: TenantId): void {
    const facility = HealthFacility.reconstitute(tenantId, {
      name: FacilityName.create('Etablissement suspendu').getValue(),
      status: 'SUSPENDED',
      createdAt: CLOCK.now(),
    });
    this.byTenantId.set(tenantId.toString(), facility);
  }

  async findByTenantId(tenantId: TenantId): Promise<HealthFacility | null> {
    return this.byTenantId.get(tenantId.toString()) ?? null;
  }

  async existsByTenantId(tenantId: TenantId): Promise<boolean> {
    return this.byTenantId.has(tenantId.toString());
  }

  async save(): Promise<void> {
    throw new Error('Non utilise par ce test.');
  }
}

class FakeSubscriptionRepository implements SubscriptionRepository {
  private readonly byTenantId = new Map<string, Subscription>();

  seedTrialing(tenantId: TenantId): void {
    this.byTenantId.set(
      tenantId.toString(),
      Subscription.startTrial({
        tenantId,
        standardPlanId: PlanId.create(uuidAt(100)).getValue(),
        standardPlanPriceId: PlanPriceId.create(uuidAt(101)).getValue(),
        ownerUserId: uuidAt(102),
        clock: CLOCK,
        idGenerator: new SequentialIdGenerator(),
      }),
    );
  }

  async findByTenantId(tenantId: TenantId): Promise<Subscription | null> {
    return this.byTenantId.get(tenantId.toString()) ?? null;
  }

  async findById(_id: SubscriptionId, _tenantId: TenantId): Promise<Subscription | null> {
    throw new Error('Non utilise par ce test.');
  }

  async save(): Promise<void> {
    throw new Error('Non utilise par ce test.');
  }

  async listSchedulerCandidates(): Promise<readonly Subscription[]> {
    throw new Error('Non utilise par ce test.');
  }
}

function buildChecker(): {
  facilities: FakeHealthFacilityRepository;
  subscriptions: FakeSubscriptionRepository;
  checker: TenantModuleBackedAccessChecker;
} {
  const facilities = new FakeHealthFacilityRepository();
  const subscriptions = new FakeSubscriptionRepository();
  return { facilities, subscriptions, checker: new TenantModuleBackedAccessChecker(facilities, subscriptions) };
}

describe('TenantModuleBackedAccessChecker (classe REELLE de composition-root.ts) — ADR-0008 §3', () => {
  it('ACCESSIBLE seulement si HealthFacility ACTIVE **et** Subscription presente pour CE tenant', async () => {
    const { facilities, subscriptions, checker } = buildChecker();
    facilities.seedActive(TENANT_A);
    subscriptions.seedTrialing(TENANT_A);

    expect(await checker.checkAccess(TENANT_A)).toBe('ACCESSIBLE');
  });

  it("HealthFacility ACTIVE mais AUCUNE Subscription -> NOT_FOUND (ferme la faille du §Contexte d'ADR-0008 : provisioning interrompu avant StartTrialSubscription)", async () => {
    const { facilities, checker } = buildChecker();
    facilities.seedActive(TENANT_A);

    expect(await checker.checkAccess(TENANT_A)).toBe('NOT_FOUND');
  });

  it('HealthFacility SUSPENDED reste PRIORITAIRE meme avec une Subscription TRIALING valide', async () => {
    const { facilities, subscriptions, checker } = buildChecker();
    facilities.seedSuspended(TENANT_A);
    subscriptions.seedTrialing(TENANT_A);

    expect(await checker.checkAccess(TENANT_A)).toBe('SUSPENDED');
  });

  it('aucun HealthFacility -> NOT_FOUND, indistinguable du tenant partiellement provisionne (anti-enumeration)', async () => {
    const { subscriptions, checker } = buildChecker();
    // Cas adverse : une Subscription orpheline existe pour ce tenant, mais aucun etablissement.
    subscriptions.seedTrialing(TENANT_A);

    expect(await checker.checkAccess(TENANT_A)).toBe('NOT_FOUND');
  });

  it("la Subscription d'un AUTRE tenant ne rend jamais accessible le tenant demande (aucune confusion de tenantId entre les deux lectures)", async () => {
    const { facilities, subscriptions, checker } = buildChecker();
    facilities.seedActive(TENANT_A);
    subscriptions.seedTrialing(TENANT_B);

    expect(await checker.checkAccess(TENANT_A)).toBe('NOT_FOUND');
    expect(await checker.checkAccess(TENANT_B)).toBe('NOT_FOUND');
  });

  it("ne consulte JAMAIS ProvisioningCompleted ni aucun marqueur de progression de Saga (ADR-0008 §3/§11) : seuls HealthFacility et Subscription sont lus", async () => {
    const { facilities, subscriptions, checker } = buildChecker();
    facilities.seedActive(TENANT_A);
    subscriptions.seedTrialing(TENANT_A);

    // La decision est prise SANS aucun `FacilitySettingsRepository` (ni marqueur
    // `provisioningCompletedAt`, ni consommateur de `ProvisioningCompleted`) : la classe n'en
    // recoit meme pas un. Un futur raccourci qui consulterait un flag de progression de Saga
    // exigerait d'AJOUTER cette dependance au constructeur — donc de modifier CETTE ligne, ce qui
    // rend le contournement impossible a introduire discretement.
    expect(new TenantModuleBackedAccessChecker(facilities, subscriptions)).toBeDefined();
    expect(await checker.checkAccess(TENANT_A)).toBe('ACCESSIBLE');
  });
});

class FakeUserAccountRepository implements UserAccountRepository {
  private readonly byId = new Map<string, UserAccount>();

  seed(id: string): void {
    const account = UserAccount.reconstitute(UserAccountId.create(id).getValue(), {
      email: Email.create(`compte-${id}@example.test`).getValue(),
      passwordHash: PasswordHash.fromHash('$argon2id$fake-hash-de-test').getValue(),
      platformRole: 'NONE',
      createdAt: CLOCK.now(),
    });
    this.byId.set(id, account);
  }

  async findById(id: UserAccountId): Promise<UserAccount | null> {
    return this.byId.get(id.toString()) ?? null;
  }

  async findByEmail(_email: Email): Promise<UserAccount | null> {
    throw new Error('Non utilise par ce test.');
  }

  async save(): Promise<void> {
    throw new Error('Non utilise par ce test.');
  }

  async findAllSuperAdmins(): Promise<readonly UserAccount[]> {
    throw new Error('Non utilise par ce test.');
  }
}

describe('IdentityModuleBackedUserAccountExistenceChecker (classe REELLE de composition-root.ts) — ADR-0008 §9', () => {
  it("refuse une valeur qui n'est pas un UUID v4 SANS interroger la persistance (fail closed, jamais une exception remontee a l'appelant)", async () => {
    const repository = new FakeUserAccountRepository();
    const checker = new IdentityModuleBackedUserAccountExistenceChecker(repository);

    expect(await checker.exists('pas-un-uuid')).toBe(false);
    expect(await checker.exists('')).toBe(false);
    expect(await checker.exists("' OR 1=1 --")).toBe(false);
  });

  it("refuse un UUID v4 syntaxiquement valide qui ne correspond a AUCUN UserAccount (jamais une simple verification de forme)", async () => {
    const repository = new FakeUserAccountRepository();
    const checker = new IdentityModuleBackedUserAccountExistenceChecker(repository);

    expect(await checker.exists(uuidAt(500))).toBe(false);
  });

  it('accepte uniquement un UserAccount reellement present', async () => {
    const repository = new FakeUserAccountRepository();
    repository.seed(uuidAt(500));
    const checker = new IdentityModuleBackedUserAccountExistenceChecker(repository);

    expect(await checker.exists(uuidAt(500))).toBe(true);
    expect(await checker.exists(uuidAt(501))).toBe(false);
  });
});
