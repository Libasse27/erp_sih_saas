import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';

/** Client Prisma connecte via le role applicatif (`sih_app`, non-superuser, non-BYPASSRLS — voir migration 20260823173817). */
export function createTestPrismaClient(): PrismaClient {
  return new PrismaClient();
}

/** Client PostgreSQL brut (pas un repository, pas Prisma) — pour demontrer l'ABSENCE deliberee de RLS sur le schema `platform` (ADR-0001 §3.3). */
export async function createRawPgClient(): Promise<PgClient> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

export function uniqueTenantId(): string {
  return randomUUID();
}
