import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { UserAccount } from '../../domain/UserAccount.js';
import type { PasswordHasher } from '../../domain/ports/PasswordHasher.js';
import { UserAccountEmailAlreadyRegisteredError, type UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import { Email } from '../../domain/value-objects/Email.js';
import type { PlatformRole } from '../../domain/value-objects/PlatformRole.js';

export interface CreateUserAccountCommand {
  readonly email: string;
  readonly plainPassword: string;
  readonly platformRole: PlatformRole;
}

export type CreateUserAccountError =
  | 'INVALID_EMAIL'
  | 'PASSWORD_TOO_SHORT'
  | 'EMAIL_ALREADY_REGISTERED';

export interface CreateUserAccountResult {
  readonly userAccountId: string;
}

// Politique V1 DEFINITIVE (ADR-0010 amendement 1, AC-3, 2026-09-02) : 8 caracteres minimum,
// aucune regle de complexite. Ce n'est plus un plancher technique cache en attente d'une
// politique produit — c'est la politique elle-meme, publiquement observable via
// POST /api/v1/registrations.
const MIN_PASSWORD_LENGTH = 8;

export class CreateUserAccountHandler {
  constructor(
    private readonly userAccountRepository: UserAccountRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(
    command: CreateUserAccountCommand,
  ): Promise<Result<CreateUserAccountResult, CreateUserAccountError>> {
    const emailResult = Email.create(command.email);
    if (emailResult.isFailure()) {
      return Result.failure('INVALID_EMAIL');
    }
    const email = emailResult.getValue();

    if (command.plainPassword.length < MIN_PASSWORD_LENGTH) {
      return Result.failure('PASSWORD_TOO_SHORT');
    }

    // Le hachage Argon2id est CPU-bound : il s'execute HORS transaction DB (jamais de calcul
    // couteux pendant qu'une transaction/des verrous sont ouverts — regle 6.3 du system prompt).
    const passwordHash = await this.passwordHasher.hash(command.plainPassword);

    return this.unitOfWork.withTransaction(async () => {
      const existing = await this.userAccountRepository.findByEmail(email);
      if (existing !== null) {
        return Result.failure('EMAIL_ALREADY_REGISTERED');
      }

      const account = UserAccount.register({
        email,
        passwordHash,
        platformRole: command.platformRole,
        clock: this.clock,
        idGenerator: this.idGenerator,
      });
      try {
        await this.userAccountRepository.save(account);
      } catch (error) {
        if (error instanceof UserAccountEmailAlreadyRegisteredError) {
          // Course concurrente : une AUTRE requete a insere ce meme email entre notre lecture
          // (`findByEmail` ci-dessus) et notre ecriture — traduite en la MEME erreur metier que le
          // cas non concurrent, jamais une exception qui traverserait la frontiere HTTP (revue de
          // securite independante de l'etape 12/13, BLOQUANT-2a).
          return Result.failure('EMAIL_ALREADY_REGISTERED');
        }
        throw error;
      }

      return Result.success({ userAccountId: account.id.toString() });
    });
  }
}
