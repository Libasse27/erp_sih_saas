import type { Clock } from '../../../src/shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../src/shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../src/shared-kernel/application/UnitOfWork.js';
import type { TenantId } from '../../../src/shared-kernel/domain/value-objects/TenantId.js';
import type { PasswordHasher } from '../../../src/modules/identity/domain/ports/PasswordHasher.js';
import type { RoleRepository } from '../../../src/modules/identity/domain/ports/RoleRepository.js';
import type { UserAccountRepository } from '../../../src/modules/identity/domain/ports/UserAccountRepository.js';
import type { Email } from '../../../src/modules/identity/domain/value-objects/Email.js';
import type { UserTenantMembershipRepository } from '../../../src/modules/identity/domain/ports/UserTenantMembershipRepository.js';
import type { UserAccount } from '../../../src/modules/identity/domain/UserAccount.js';
import type { UserTenantMembership } from '../../../src/modules/identity/domain/UserTenantMembership.js';
import type { Role } from '../../../src/modules/identity/domain/Role.js';
import { PasswordHash } from '../../../src/modules/identity/domain/value-objects/PasswordHash.js';
import { UserAccountId } from '../../../src/modules/identity/domain/value-objects/UserAccountId.js';
import { UserTenantMembershipId } from '../../../src/modules/identity/domain/value-objects/UserTenantMembershipId.js';
import { RoleId } from '../../../src/modules/identity/domain/value-objects/RoleId.js';
import type { SessionContext, SessionStore } from '../../../src/modules/identity/application/ports/SessionStore.js';
import type { TenantAccessChecker, TenantAccessStatus } from '../../../src/modules/identity/application/ports/TenantAccessChecker.js';
import type { AuditRecordInput, AuditTrail } from '../../../src/modules/identity/application/ports/AuditTrail.js';
import type { MfaBypassAttemptGuard } from '../../../src/modules/identity/application/ports/MfaBypassAttemptGuard.js';
import type { MfaEnrollment } from '../../../src/modules/identity/domain/MfaEnrollment.js';
import type { MfaEnrollmentRepository } from '../../../src/modules/identity/domain/ports/MfaEnrollmentRepository.js';
import type {
  GeneratedRecoveryCodes,
  RecoveryCodeGenerator,
} from '../../../src/modules/identity/domain/ports/RecoveryCodeGenerator.js';
import type { RecoveryCodeHasher } from '../../../src/modules/identity/domain/ports/RecoveryCodeHasher.js';
import type { TotpProvisioning, TotpService, TotpVerificationOutcome } from '../../../src/modules/identity/domain/ports/TotpService.js';
import { EncryptedTotpSecret } from '../../../src/modules/identity/domain/value-objects/EncryptedTotpSecret.js';
import { RecoveryCodeHash } from '../../../src/modules/identity/domain/value-objects/RecoveryCodeHash.js';
import { Result } from '../../../src/shared-kernel/domain/Result.js';

export class FixedClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  now(): Date {
    return this.current;
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Genere des UUID v4 valides et deterministes (sequentiels) — jamais Math.random() dans les tests non plus, pour rester reproductible. */
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
  async withTransaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

export class InMemoryUserAccountRepository implements UserAccountRepository {
  private readonly byId = new Map<string, UserAccount>();

  async findById(id: UserAccountId): Promise<UserAccount | null> {
    return this.byId.get(id.toString()) ?? null;
  }

  async findByEmail(email: Email): Promise<UserAccount | null> {
    for (const account of this.byId.values()) {
      if (account.email.value === email.value) {
        return account;
      }
    }
    return null;
  }

  async save(account: UserAccount): Promise<void> {
    this.byId.set(account.id.toString(), account);
  }
}

export class InMemoryUserTenantMembershipRepository implements UserTenantMembershipRepository {
  private readonly byId = new Map<string, UserTenantMembership>();

  async findActiveByUserAndTenant(userId: UserAccountId, tenantId: TenantId): Promise<UserTenantMembership | null> {
    for (const membership of this.byId.values()) {
      if (membership.userId.equals(userId) && membership.tenantId.equals(tenantId) && membership.isActive()) {
        return membership;
      }
    }
    return null;
  }

  async findById(id: UserTenantMembershipId, tenantId: TenantId): Promise<UserTenantMembership | null> {
    const membership = this.byId.get(id.toString());
    if (membership === undefined || !membership.tenantId.equals(tenantId)) {
      return null;
    }
    return membership;
  }

  async listActiveTenantIdsForUser(userId: UserAccountId): Promise<readonly TenantId[]> {
    const result: TenantId[] = [];
    for (const membership of this.byId.values()) {
      if (membership.userId.equals(userId) && membership.isActive()) {
        result.push(membership.tenantId);
      }
    }
    return result;
  }

  async countActive(tenantId: TenantId): Promise<number> {
    let count = 0;
    for (const membership of this.byId.values()) {
      if (membership.tenantId.equals(tenantId) && membership.isActive()) {
        count += 1;
      }
    }
    return count;
  }

  async save(membership: UserTenantMembership, tenantId: TenantId): Promise<void> {
    // Meme garde defensive que PrismaUserTenantMembershipRepository (couche 3, ADR-0001 §3.2) :
    // le tenantId du contexte d'appel doit toujours correspondre a celui de l'agregat sauvegarde.
    if (!membership.tenantId.equals(tenantId)) {
      throw new Error("Tentative de sauvegarde d'un UserTenantMembership hors du tenant du contexte courant.");
    }
    this.byId.set(membership.id.toString(), membership);
  }
}

export class InMemoryRoleRepository implements RoleRepository {
  private readonly byId = new Map<string, Role>();

  seed(role: Role): void {
    this.byId.set(role.id.toString(), role);
  }

  async findSystemRoleByCode(code: string): Promise<Role | null> {
    for (const role of this.byId.values()) {
      if (role.scope === 'SYSTEM' && role.code === code) {
        return role;
      }
    }
    return null;
  }

  async findByIds(tenantId: TenantId, ids: readonly RoleId[]): Promise<Role[]> {
    const wanted = new Set(ids.map((id) => id.toString()));
    const result: Role[] = [];
    for (const role of this.byId.values()) {
      if (!wanted.has(role.id.toString())) {
        continue;
      }
      if (role.scope === 'SYSTEM' || (role.tenantId !== null && role.tenantId.equals(tenantId))) {
        result.push(role);
      }
    }
    return result;
  }

  async saveSystemRole(role: Role): Promise<void> {
    this.byId.set(role.id.toString(), role);
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, SessionContext>();

  async create(session: SessionContext): Promise<void> {
    this.byId.set(session.sessionId, session);
  }

  async get(sessionId: string): Promise<SessionContext | null> {
    return this.byId.get(sessionId) ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    this.byId.delete(sessionId);
  }

  async deleteAllForMembership(membershipId: string): Promise<void> {
    for (const [sessionId, session] of this.byId.entries()) {
      if (session.kind === 'TENANT' && session.membershipId === membershipId) {
        this.byId.delete(sessionId);
      }
    }
  }

  async deleteAllForUser(userId: string): Promise<void> {
    for (const [sessionId, session] of this.byId.entries()) {
      if (session.userId === userId) {
        this.byId.delete(sessionId);
      }
    }
  }

  size(): number {
    return this.byId.size;
  }
}

/**
 * Fake du port cross-module `TenantAccessChecker` (voir composition-root.ts pour
 * l'implementation reelle, qui delegue au module Tenant). Par defaut aucun tenant n'existe —
 * comportement volontairement restrictif (refus par defaut, `NOT_FOUND`), a l'image du RLS :
 * un test doit seed() explicitement les tenants qu'il attend voir resolus avec succes. Le
 * second parametre optionnel de `seed` permet de simuler un tenant `SUSPENDED` sans passer par
 * une commande applicative de suspension (qui n'existe pas encore — voir HealthFacility.ts).
 */
export class InMemoryTenantAccessChecker implements TenantAccessChecker {
  private readonly statuses = new Map<string, TenantAccessStatus>();

  seed(tenantId: TenantId, status: TenantAccessStatus = 'ACCESSIBLE'): void {
    this.statuses.set(tenantId.toString(), status);
  }

  async checkAccess(tenantId: TenantId): Promise<TenantAccessStatus> {
    return this.statuses.get(tenantId.toString()) ?? 'NOT_FOUND';
  }
}

/** Hachage factice, deterministe, sans cryptographie reelle — reserve aux tests unitaires rapides (le vrai Argon2id est couvert par les tests d'integration). */
export class FakePasswordHasher implements PasswordHasher {
  async hash(plainPassword: string): Promise<PasswordHash> {
    const result = PasswordHash.fromHash(`fake:${plainPassword}`);
    if (result.isFailure()) {
      throw result.getError();
    }
    return result.getValue();
  }

  async verify(hash: PasswordHash, plainPassword: string): Promise<boolean> {
    return hash.value === `fake:${plainPassword}`;
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

export const idFor = {
  userAccount: (n: number): UserAccountId => mustSucceed(UserAccountId.create(uuidAt(n))),
  membership: (n: number): UserTenantMembershipId => mustSucceed(UserTenantMembershipId.create(uuidAt(n))),
  role: (n: number): RoleId => mustSucceed(RoleId.create(uuidAt(n))),
};

export class InMemoryMfaEnrollmentRepository implements MfaEnrollmentRepository {
  private readonly byUserId = new Map<string, MfaEnrollment>();

  async findByUserId(userId: UserAccountId): Promise<MfaEnrollment | null> {
    return this.byUserId.get(userId.toString()) ?? null;
  }

  /**
   * Le fake en memoire n'a pas de notion de transaction/verrou de ligne (mono-thread, aucune
   * concurrence reelle possible en test unitaire) — delegue simplement a `findByUserId` (F-3, voir
   * `PrismaMfaEnrollmentRepository.findByUserIdForUpdate` pour la variante PostgreSQL reelle,
   * couverte par un test d'integration dedie).
   */
  async findByUserIdForUpdate(userId: UserAccountId): Promise<MfaEnrollment | null> {
    return this.findByUserId(userId);
  }

  async save(enrollment: MfaEnrollment): Promise<void> {
    enrollment.pullDomainEvents();
    this.byUserId.set(enrollment.userId.toString(), enrollment);
  }

  seed(enrollment: MfaEnrollment): void {
    enrollment.pullDomainEvents();
    this.byUserId.set(enrollment.userId.toString(), enrollment);
  }
}

function encryptedSecretFor(userAccountId: string): EncryptedTotpSecret {
  // Enveloppe FACTICE valide (respecte le format `v1.<keyId>.<iv>.<tag>.<ciphertext>`) — aucune
  // cryptographie reelle : reservee aux tests unitaires rapides (le vrai AES-256-GCM est couvert
  // par les tests d'integration de `Rfc6238TotpService`/`AesGcmSecretCipher`).
  return mustSucceed(EncryptedTotpSecret.create(`v1.testkey.${userAccountId}.faketag.fakecipher`));
}

/**
 * Double deterministe de `TotpService` : un code EST valide si et seulement s'il est EGAL a
 * `validCode` (par defaut `'000000'`), auquel cas le pas de temps retourne avance a chaque appel
 * (jamais deux fois le meme, pour ne pas declencher artificiellement l'anti-rejeu du domaine
 * sauf demande explicite via `nextTimeStep`).
 */
export class FakeTotpService implements TotpService {
  // Demarre volontairement HAUT (pas 1) : de nombreux tests seedent un enrolement deja confirme
  // avec `lastAcceptedTimeStep: 1` directement au niveau du domaine (sans passer par ce service) —
  // demarrer a 1 ici declencherait un faux anti-rejeu (CODE_ALREADY_USED) des le premier appel
  // reel a `verify()`. Ajuster explicitement via `nextTimeStep` si un test a besoin de forcer un
  // rejeu.
  nextTimeStep = 1000;

  constructor(private readonly validCode: string = '000000') {}

  async generateSecret(params: { userAccountId: string; accountLabel: string }): Promise<TotpProvisioning> {
    return {
      encryptedSecret: encryptedSecretFor(params.userAccountId),
      provisioningUri: `otpauth://totp/${params.accountLabel}?secret=FAKE`,
    };
  }

  async verify(params: { code: string }): Promise<TotpVerificationOutcome> {
    if (params.code !== this.validCode) {
      return { valid: false, timeStep: null };
    }
    const timeStep = this.nextTimeStep;
    this.nextTimeStep += 1;
    return { valid: true, timeStep };
  }
}

/** Hachage factice deterministe (pas de HMAC reel) — le hash EST le code normalise, prefixe pour respecter le format de l'enveloppe. */
export class FakeRecoveryCodeHasher implements RecoveryCodeHasher {
  hash(plainCode: string): RecoveryCodeHash {
    const normalized = plainCode.toUpperCase().replace(/[\s-]/g, '');
    return mustSucceed(RecoveryCodeHash.create(`v1.testpepper.${normalized}`));
  }
}

/** Generateur deterministe (pas de CSPRNG) — codes sequentiels `CODE-<n>`, pratiques a asserter dans les tests. */
export class FakeRecoveryCodeGenerator implements RecoveryCodeGenerator {
  constructor(private readonly hasher: RecoveryCodeHasher = new FakeRecoveryCodeHasher()) {}

  generate(count: number): GeneratedRecoveryCodes {
    const plainCodes = Array.from({ length: count }, (_unused, index) => `CODE-${index + 1}`);
    return { plainCodes, hashes: plainCodes.map((code) => this.hasher.hash(code)) };
  }
}

export class InMemoryAuditTrail implements AuditTrail {
  readonly records: AuditRecordInput[] = [];

  async record(input: AuditRecordInput): Promise<void> {
    this.records.push(input);
  }
}

export class InMemoryMfaBypassAttemptGuard implements MfaBypassAttemptGuard {
  private readonly marked = new Set<string>();

  async tryMark(sessionId: string): Promise<boolean> {
    if (this.marked.has(sessionId)) {
      return false;
    }
    this.marked.add(sessionId);
    return true;
  }
}
