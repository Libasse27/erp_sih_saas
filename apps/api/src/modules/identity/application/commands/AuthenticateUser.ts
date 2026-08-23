import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { PasswordHasher } from '../../domain/ports/PasswordHasher.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';

export interface AuthenticateUserCommand {
  readonly email: string;
  readonly plainPassword: string;
}

/** Erreur volontairement unique et generique — jamais de distinction "email inconnu" vs "mot de passe incorrect" (regle 2.4, anti-enumeration). */
export type AuthenticateUserError = 'INVALID_CREDENTIALS';

export interface AuthenticateUserResult {
  readonly userAccountId: string;
  readonly isSuperAdmin: boolean;
  /** Tenants dans lesquels l'utilisateur porte un membership actif — sert a l'ecran de selection (O-05). Toujours vide pour un SUPER_ADMIN. */
  readonly activeTenantIds: readonly string[];
}

/**
 * Hachage Argon2id d'une valeur fixe, sans rapport avec un compte reel. Utilise pour executer
 * une verification factice a duree comparable quand l'email n'existe pas, afin de limiter (pas
 * d'annuler completement — le reseau et le GC introduisent d'autres variances) l'enumeration
 * de comptes par mesure de temps de reponse.
 */
const DUMMY_HASH = PasswordHash.fromHash(
  '$argon2id$v=19$m=65536,p=4,t=3$GzzpuCRsZHob1qUOe8y3lg$PjK26je6AqZ5Ar4k9eLHNhRYaFHpBVQCDz75q/0U4rE',
).getValue();

/**
 * Cas d'usage 2.4 : identite verifiee (email + mot de passe), **sans** resolution de tenant —
 * cette derniere est une etape distincte (ResolveTenantContext, 2.5), le serveur seul decide
 * du contexte (01-target-architecture.md §7.1).
 */
export class AuthenticateUserHandler {
  constructor(
    private readonly userAccountRepository: UserAccountRepository,
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    command: AuthenticateUserCommand,
  ): Promise<Result<AuthenticateUserResult, AuthenticateUserError>> {
    const emailResult = Email.create(command.email);
    if (emailResult.isFailure()) {
      return Result.failure('INVALID_CREDENTIALS');
    }
    const email = emailResult.getValue();

    const account = await this.unitOfWork.withTransaction(() =>
      this.userAccountRepository.findByEmail(email),
    );

    if (account === null) {
      await this.passwordHasher.verify(DUMMY_HASH, command.plainPassword);
      return Result.failure('INVALID_CREDENTIALS');
    }

    const passwordMatches = await this.passwordHasher.verify(account.passwordHash, command.plainPassword);
    if (!passwordMatches) {
      return Result.failure('INVALID_CREDENTIALS');
    }

    if (account.isSuperAdmin()) {
      return Result.success({
        userAccountId: account.id.toString(),
        isSuperAdmin: true,
        activeTenantIds: [],
      });
    }

    const tenantIds = await this.unitOfWork.withTransaction(
      () => this.membershipRepository.listActiveTenantIdsForUser(account.id),
      { actorUserId: account.id.toString() },
    );

    return Result.success({
      userAccountId: account.id.toString(),
      isSuperAdmin: false,
      activeTenantIds: tenantIds.map((tenantId) => tenantId.toString()),
    });
  }
}
