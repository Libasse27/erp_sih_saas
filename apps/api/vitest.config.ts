import { defineConfig } from 'vitest/config';

/**
 * Configuration Vitest. `setupFiles` charge `.env` (DATABASE_URL, REDIS_URL) avant toute
 * suite — les tests d'integration (RLS, repositories, sessions Redis) exigent une instance
 * PostgreSQL/Redis reelle demarree via `docker compose up -d` (voir docs de l'etape).
 * `testTimeout` releve car les tests d'integration font des I/O reseau/DB reels.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setupEnv.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
