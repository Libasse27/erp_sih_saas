import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

/** Client Prisma connecte via le role applicatif REEL (`sih_app`, non-superuser — voir migration 20260823173817). */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient();
}

/** Client PostgreSQL brut, connecte avec le MEME role applicatif que `createTestPrismaClient()` — jamais le role superuser `sih` (verifierait faussement l'immuabilite, voir rlsGuard.test.ts). */
export async function createRawPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

export function uniqueId(): string {
  return randomUUID();
}
