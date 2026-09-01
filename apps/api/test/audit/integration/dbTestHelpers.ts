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

/**
 * Client PostgreSQL brut connecte avec le role SUPERUSER `sih` (`POSTGRES_USER`/`POSTGRES_PASSWORD`
 * de `docker-compose.yml`, dev uniquement) — jamais utilise pour verifier une garantie d'isolation
 * ou d'immuabilite (ce serait un test faussement vert, voir `createRawPgClient` ci-dessus). Reserve
 * EXCLUSIVEMENT a `auditChainIntegrity.test.ts`, qui doit lui-meme DEMONTRER la limite documentee
 * par ADR-0009 §5.4 : "le chainage detecte une alteration APPLICATIVE (role `sih_app`/API) ; il ne
 * protege PAS contre un superuser PostgreSQL, qui peut... modifier les lignes". Derive la
 * connexion depuis `DATABASE_URL` (memes host/port/base) en substituant UNIQUEMENT
 * utilisateur/mot de passe — jamais une URL en dur qui divergerait silencieusement de
 * `docker-compose.yml` si le port mappe changeait.
 */
export async function createSuperuserPgClient(): Promise<PgClient> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL absent — createSuperuserPgClient() necessite le meme environnement que createRawPgClient().');
  }
  const url = new URL(databaseUrl);
  url.username = 'sih';
  url.password = 'sih_dev_only';
  const client = new PgClient({ connectionString: url.toString() });
  await client.connect();
  return client;
}

export function uniqueId(): string {
  return randomUUID();
}
