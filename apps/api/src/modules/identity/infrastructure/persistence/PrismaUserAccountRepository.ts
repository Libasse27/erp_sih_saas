import type { PrismaClient } from '@prisma/client';
import { UserAccountEmailAlreadyRegisteredError, type UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { PlatformRole } from '../../domain/value-objects/PlatformRole.js';
import { assertValid } from '../../../../shared-kernel/infrastructure/persistence/assertValid.js';
import { resolvePrismaClient } from '../../../../shared-kernel/infrastructure/persistence/PrismaTransactionContext.js';
import { writeDomainEventsToOutbox } from '../../../../shared-kernel/infrastructure/persistence/OutboxWriter.js';

interface UserAccountRow {
  id: string;
  email: string;
  passwordHash: string;
  platformRole: string;
  createdAt: Date;
}

/** Repository `UserAccount` — schema `platform`, hors RLS tenant (aucune methode ne prend de tenantId, voir port). */
export class PrismaUserAccountRepository implements UserAccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: UserAccountId): Promise<UserAccount | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.userAccount.findUnique({ where: { id: id.toString() } });
    return row === null ? null : this.toDomain(row);
  }

  async findByEmail(email: Email): Promise<UserAccount | null> {
    const client = resolvePrismaClient(this.prisma);
    const row = await client.userAccount.findUnique({ where: { email: email.value } });
    return row === null ? null : this.toDomain(row);
  }

  async findAllSuperAdmins(): Promise<readonly UserAccount[]> {
    const client = resolvePrismaClient(this.prisma);
    const rows = await client.userAccount.findMany({ where: { platformRole: 'SUPER_ADMIN' } });
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * `createMany({ skipDuplicates: true })` (`INSERT ... ON CONFLICT DO NOTHING`) PLUTOT qu'un
   * `upsert()`/`create()` dont on rattraperait un `P2002` — meme idiome que
   * `PrismaSubscriptionRepository.save()` : cette methode est appelee DANS une transaction deja
   * ouverte (`CreateUserAccountHandler`, sous `unitOfWork.withTransaction`), et en PostgreSQL une
   * violation de contrainte AVORTE la transaction entiere (toute requete suivante echouerait avec
   * `25P02 current transaction is aborted`). `count === 0` signifie qu'un AUTRE writer a deja
   * insere une ligne avec ce MEME `email` (seule contrainte UNIQUE pouvant entrer en conflit ici —
   * `id` est un UUID fraichement genere) entre notre lecture (`findByEmail` dans
   * `CreateUserAccountHandler`) et notre ecriture : traduit en `UserAccountEmailAlreadyRegisteredError`,
   * rattrapee par le handler et convertie en `EMAIL_ALREADY_REGISTERED` (`409`), jamais une
   * exception non geree traversant la frontiere HTTP (revue de securite independante de l'etape
   * 12/13, BLOQUANT-2a).
   *
   * Seul appelant : creation d'un compte tout neuf (`UserAccount.register()`) — aucune mise a
   * jour d'un compte existant n'existe encore a cette etape (verifie : `save()` n'a qu'un seul
   * appelant, `CreateUserAccountHandler`). Le jour ou une commande de mise a jour existera, elle
   * exigera son propre chemin d'ecriture (`updateMany` conditionnel), jamais un branchement ici.
   */
  async save(account: UserAccount): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    const insertResult = await client.userAccount.createMany({
      data: [
        {
          id: account.id.toString(),
          email: account.email.value,
          passwordHash: account.passwordHash.value,
          platformRole: account.platformRole,
          createdAt: account.createdAt,
        },
      ],
      skipDuplicates: true,
    });
    if (insertResult.count === 0) {
      throw new UserAccountEmailAlreadyRegisteredError(account.email.value);
    }

    // Outbox (D9, etape 6/13) : ecrit DANS LA MEME TRANSACTION que la ligne ci-dessus (meme
    // `client` resolu via `resolvePrismaClient`) — voir CreateUserAccountHandler, seul appelant de
    // `save()`, toujours execute sous `unitOfWork.withTransaction`. Active ici le relais pour
    // `UserAccountCreated`, jusqu'ici accumule sur l'agregat mais jamais persiste nulle part.
    await writeDomainEventsToOutbox(client, account.pullDomainEvents());
  }

  private toDomain(row: UserAccountRow): UserAccount {
    const id = assertValid(UserAccountId.create(row.id));
    const email = assertValid(Email.create(row.email));
    const passwordHash = assertValid(PasswordHash.fromHash(row.passwordHash));
    return UserAccount.reconstitute(id, {
      email,
      passwordHash,
      platformRole: row.platformRole as PlatformRole,
      createdAt: row.createdAt,
    });
  }
}
