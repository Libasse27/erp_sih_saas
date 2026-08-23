import type { PrismaClient } from '@prisma/client';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import { UserAccount } from '../../domain/UserAccount.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { UserAccountId } from '../../domain/value-objects/UserAccountId.js';
import type { PlatformRole } from '../../domain/value-objects/PlatformRole.js';
import { assertValid } from './assertValid.js';
import { resolvePrismaClient } from './PrismaTransactionContext.js';

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

  async save(account: UserAccount): Promise<void> {
    const client = resolvePrismaClient(this.prisma);
    await client.userAccount.upsert({
      where: { id: account.id.toString() },
      create: {
        id: account.id.toString(),
        email: account.email.value,
        passwordHash: account.passwordHash.value,
        platformRole: account.platformRole,
        createdAt: account.createdAt,
      },
      update: {
        email: account.email.value,
        passwordHash: account.passwordHash.value,
        platformRole: account.platformRole,
      },
    });
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
