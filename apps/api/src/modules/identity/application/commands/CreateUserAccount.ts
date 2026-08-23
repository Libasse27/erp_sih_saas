import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { Clock } from '../../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../../shared-kernel/domain/ports/IdGenerator.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import { UserAccount } from '../../domain/UserAccount.js';
import type { PasswordHasher } from '../../domain/ports/PasswordHasher.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
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

// Plancher technique minimal (pas une politique de complexite de mot de passe — aucun barème
// metier n'est invente ici, cf. regle d'escalade). A renforcer si une politique de mot de
// passe est un jour explicitement fournie.
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
      await this.userAccountRepository.save(account);

      return Result.success({ userAccountId: account.id.toString() });
    });
  }
}
