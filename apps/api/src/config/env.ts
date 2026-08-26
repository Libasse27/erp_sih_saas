import { z } from 'zod';

/**
 * Chargement type des variables d'environnement. Secrets exclusivement via l'environnement
 * (jamais dans le depot) — regle 7.1 de l'architecture cible. Echoue au demarrage plutot
 * qu'en cours d'execution si une variable requise manque.
 */
/**
 * Valeurs D'EXEMPLE DE DEVELOPPEMENT exactes (`.env`/`.env.example`) pour les secrets MFA —
 * denylist EXPLICITE (comparaison exacte), pas une heuristique de "detection de secret faible"
 * (regle §7.1 : pas de logique fragile — un vrai secret pourrait legitimement contenir n'importe
 * quel motif que devinerait une heuristique generique, et un secret faible pourrait n'en
 * contenir aucun). Cette liste ferme un seul risque concret et verifiable : oublier de remplacer
 * la valeur de developpement lors du deploiement en production/staging.
 */
const KNOWN_DEV_ONLY_MFA_SECRET_ENCRYPTION_KEYS = new Set([
  'ZGV2X29ubHlfbmV2ZXJfdXNlX3Byb2RfMzJieXRlcyE=',
]);
const KNOWN_DEV_ONLY_MFA_RECOVERY_CODE_PEPPERS = new Set([
  'dev_only_never_use_in_prod_recovery_code_pepper_32c',
]);

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
    // MFA TOTP (etape 7/13, ADR-0005 §2/§3) — secrets exclusivement via l'environnement, jamais
    // dans le depot (regle 7.1). Echec immediat au demarrage si absents/invalides, meme discipline
    // que PAYMENT_PROVIDER_WEBHOOK_SECRET ci-dessus.
    MFA_SECRET_ENCRYPTION_KEY: z.string().refine(
      (v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      'MFA_SECRET_ENCRYPTION_KEY doit etre une cle AES-256 encodee en base64 (32 octets exactement).',
    ),
    MFA_SECRET_ENCRYPTION_KEY_ID: z.string().min(1).default('k1'),
    MFA_RECOVERY_CODE_PEPPER: z
      .string()
      .min(32, 'MFA_RECOVERY_CODE_PEPPER doit faire au moins 32 caracteres (poivre HMAC).'),
    MFA_RECOVERY_CODE_PEPPER_ID: z.string().min(1).default('p1'),
    MFA_TOTP_ISSUER: z.string().min(1).default('SIH'),
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

    // Etape 7/13 (ADR-0005) : refuse les valeurs D'EXEMPLE DE DEVELOPPEMENT exactes des secrets
    // MFA en production/staging (voir le commentaire de tete sur la denylist ci-dessus).
    if (KNOWN_DEV_ONLY_MFA_SECRET_ENCRYPTION_KEYS.has(data.MFA_SECRET_ENCRYPTION_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_SECRET_ENCRYPTION_KEY'],
        message: `MFA_SECRET_ENCRYPTION_KEY : valeur d'exemple de developpement detectee, interdite en ${data.NODE_ENV}.`,
      });
    }
    if (KNOWN_DEV_ONLY_MFA_RECOVERY_CODE_PEPPERS.has(data.MFA_RECOVERY_CODE_PEPPER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_RECOVERY_CODE_PEPPER'],
        message: `MFA_RECOVERY_CODE_PEPPER : valeur d'exemple de developpement detectee, interdite en ${data.NODE_ENV}.`,
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
