import { z } from 'zod';

/**
 * Chargement type des variables d'environnement. Secrets exclusivement via l'environnement
 * (jamais dans le depot) — regle 7.1 de l'architecture cible. Echoue au demarrage plutot
 * qu'en cours d'execution si une variable requise manque.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est requis (PostgreSQL, ADR-0002).'),
  REDIS_URL: z.string().min(1, 'REDIS_URL est requis (sessions, cache, BullMQ).'),
  // Secret HMAC du prestataire de paiement SaaS SANDBOX (O-25.3/O-25.5) — un prestataire reel
  // fournirait sa propre cle ; ce secret ne doit JAMAIS etre en dur dans le depot (regle §7.1).
  // Longueur minimale volontairement elevee (secret de signature, pas un mot de passe utilisateur).
  PAYMENT_PROVIDER_WEBHOOK_SECRET: z
    .string()
    .min(32, 'PAYMENT_PROVIDER_WEBHOOK_SECRET doit faire au moins 32 caracteres (secret HMAC).'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Configuration d'environnement invalide :\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}
