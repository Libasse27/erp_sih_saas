import { z } from 'zod';

/**
 * Chargement type des variables d'environnement. Secrets exclusivement via l'environnement
 * (jamais dans le depot) — regle 7.1 de l'architecture cible. Echoue au demarrage plutot
 * qu'en cours d'execution si une variable requise manque.
 */
const envSchema = z
  .object({
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
  })
  // Revue de securite (etape 6/13) : Redis ne porte plus SEULEMENT du cache/sessions revocables —
  // il pilote desormais des decisions Outbox (BullMQ, ADR-0004) touchant des evenements
  // financiers. En production/staging, une connexion Redis non chiffree et/ou non authentifiee
  // serait une regression de securite silencieuse (§7.1 : "aucun secret en dur", generalise ici a
  // "aucune connexion sensible non authentifiee/non chiffree en environnement expose"). En
  // developpement/test, `redis://localhost:6379` sans authentification reste accepte (environnement
  // local non expose, voir docker-compose.yml).
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production' && data.NODE_ENV !== 'staging') {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(data.REDIS_URL);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: `REDIS_URL doit etre une URL valide en ${data.NODE_ENV} (recu : valeur non parsable comme URL).`,
      });
      return;
    }
    if (parsed.protocol !== 'rediss:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: `REDIS_URL doit utiliser le schema "rediss://" (TLS) en ${data.NODE_ENV}, jamais "redis://" en clair.`,
      });
    }
    if (parsed.username.length === 0 && parsed.password.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: `REDIS_URL doit porter des identifiants d'authentification (userinfo non vide) en ${data.NODE_ENV}.`,
      });
    }
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
