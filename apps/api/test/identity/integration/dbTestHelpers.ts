import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import { Redis } from 'ioredis';

/** Client Prisma connecte via le role applicatif (`sih_app`, non-superuser, non-BYPASSRLS — voir migration 20260823173817). */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient();
}

/** Client PostgreSQL brut (pas un repository, pas Prisma) — pour les tests qui contournent deliberement la couche applicative (RLS). */
export async function createRawPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

export function createTestRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error('REDIS_URL manquant pour les tests d_integration.');
  }
  return new Redis(url);
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomUUID()}@hopital-test.sn`;
}
