import type { Clock } from '../../../src/shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../src/shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork, UnitOfWorkContext } from '../../../src/shared-kernel/application/UnitOfWork.js';
import type { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import type { HealthFacility } from '../../../src/modules/tenant/domain/HealthFacility.js';
import type { HealthFacilityRepository } from '../../../src/modules/tenant/domain/ports/HealthFacilityRepository.js';
import type { FacilitySettings } from '../../../src/modules/tenant/domain/FacilitySettings.js';
import type { FacilitySettingsRepository } from '../../../src/modules/tenant/domain/ports/FacilitySettingsRepository.js';
import type { UserAccountExistenceChecker } from '../../../src/modules/tenant/application/ports/UserAccountExistenceChecker.js';
import { Result } from '../../../src/shared-kernel/domain/Result.js';

// Duplique volontairement les primitives generiques de test/identity/builders/testKit.ts plutot
// que de les importer depuis un autre Bounded Context de test : chaque module garde sa suite de
// test independante (§9.2 du system prompt — "aucune base partagee entre fichiers"), y compris
// pour les doublures de ports partages. Le contenu reste strictement identique par construction
// (memes ports partages du shared-kernel), donc aucune divergence de comportement n'est possible.

export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  now(): Date {
    return this.current;
  }
}

/** Genere des UUID v4 valides et deterministes (sequentiels) — jamais Math.random() dans les tests. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  generate(): string {
    this.counter += 1;
    const hex = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }
}

export function uuidAt(counter: number): string {
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export class InMemoryUnitOfWork implements UnitOfWork {
  public lastContext: UnitOfWorkContext | undefined;

  async withTransaction<T>(work: () => Promise<T>, context?: UnitOfWorkContext): Promise<T> {
    this.lastContext = context;
    return work();
  }
}

export class InMemoryHealthFacilityRepository implements HealthFacilityRepository {
  private readonly byTenantId = new Map<string, HealthFacility>();

  async findByTenantId(tenantId: TenantId): Promise<HealthFacility | null> {
    return this.byTenantId.get(tenantId.toString()) ?? null;
  }

  async existsByTenantId(tenantId: TenantId): Promise<boolean> {
    return this.byTenantId.has(tenantId.toString());
  }

  async save(facility: HealthFacility, tenantId: TenantId): Promise<void> {
    if (!facility.id.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un HealthFacility hors du tenant du contexte courant.");
    }
    this.byTenantId.set(facility.id.toString(), facility);
  }
}

export class InMemoryFacilitySettingsRepository implements FacilitySettingsRepository {
  private readonly byTenantId = new Map<string, FacilitySettings>();

  async findByTenantId(tenantId: TenantId): Promise<FacilitySettings | null> {
    return this.byTenantId.get(tenantId.toString()) ?? null;
  }

  async save(settings: FacilitySettings, tenantId: TenantId): Promise<void> {
    if (!settings.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un FacilitySettings hors du tenant du contexte courant.");
    }
    this.byTenantId.set(settings.tenantId.toString(), settings);
  }
}

/**
 * Fake du port cross-module `UserAccountExistenceChecker` (voir composition-root.ts pour
 * l'implementation reelle, qui delegue au module Identity). Par defaut AUCUN compte n'existe —
 * comportement volontairement restrictif, a l'image de `InMemoryTenantAccessChecker`
 * (test/identity/builders/testKit.ts) : un test doit `seed()` explicitement les `userId` qu'il
 * attend voir acceptes par `CreateHealthFacilityHandler`.
 */
export class InMemoryUserAccountExistenceChecker implements UserAccountExistenceChecker {
  private readonly known = new Set<string>();

  seed(userId: string): void {
    this.known.add(userId);
  }

  async exists(userId: string): Promise<boolean> {
    return this.known.has(userId);
  }
}

export function mustSucceed<T, E>(result: Result<T, E>): T {
  if (result.isFailure()) {
    throw new Error(`Resultat attendu en succes, obtenu en echec : ${JSON.stringify(result.getError())}`);
  }
  return result.getValue();
}

export function mustFail<T, E>(result: Result<T, E>): E {
  if (result.isSuccess()) {
    throw new Error('Resultat attendu en echec, obtenu en succes.');
  }
  return result.getError();
}
