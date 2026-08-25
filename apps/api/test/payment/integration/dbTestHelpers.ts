import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

/** Client Prisma connecte via le role applicatif (`sih_app`) — meme role que test/subscription/integration/dbTestHelpers.ts. */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient();
}

/** Client PostgreSQL brut — utilise uniquement pour le nettoyage post-test (pas un repository). */
export async function createRawPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

export function uniqueId(): string {
  return randomUUID();
}
