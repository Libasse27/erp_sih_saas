import { defineConfig } from 'vitest/config';

/**
 * Configuration Vitest. `setupFiles` charge `.env` (DATABASE_URL, REDIS_URL) avant toute
 * suite — les tests d'integration (RLS, repositories, sessions Redis) exigent une instance
 * PostgreSQL/Redis reelle demarree via `docker compose up -d` (voir docs de l'etape).
 * `testTimeout` releve car les tests d'integration font des I/O reseau/DB reels.
 *
 * `coverage` (Phase 0, etape 12/13, lacune C de l'audit de securite) : configure exclusivement
 * les SEUILS et le PERIMETRE de mesure — n'active PAS la collecte par defaut (`enabled` reste au
 * defaut `false` de Vitest, qui ne s'active que via le flag `--coverage`, voir script
 * `test:coverage` de package.json) : `pnpm test`/`pnpm -r run test` (deja utilise par les
 * developpeurs et par le futur CI minimal, etape 13/13) restent donc INCHANGES, comme exige
 * ("sans casser la config existante").
 *
 * Seuils par glob (roadmap `02-roadmap-migration.md` §"Criteres de sortie communs" : "Unitaire —
 * >= 90% sur domain/ + application/, sans infrastructure") : `domain/**` et `application/**` de
 * CHAQUE module (identity/audit/notifications/payment/subscription/tenant/shared-kernel) a 90%,
 * un plancher global de 70% pour le reste (infrastructure/presentation, couvert par les tests
 * d'integration, jamais un objectif de 90% — §9.2 du system prompt : "Couverture : >= 90% sur
 * domain/+application/, >= 70% global. Plancher, pas objectif").
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/server.ts',
        'src/composition-root.ts',
      ],
      thresholds: {
        // Plancher global (§9.2 du system prompt) — s'applique a tout `src/**/*.ts` non couvert
        // par un glob plus specifique ci-dessous (infrastructure/presentation notamment).
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
        // Critere de sortie commun a toute phase : >= 90% sur domain/ + application/, SANS
        // infrastructure — un glob par couche, applicable a tous les modules d'un seul coup.
        'src/modules/*/domain/**/*.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/modules/*/application/**/*.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/shared-kernel/domain/**/*.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/shared-kernel/application/**/*.ts': { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});
