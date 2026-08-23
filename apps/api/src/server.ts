import express, { type Express } from 'express';
import { buildCompositionRoot, type CompositionRoot } from './composition-root.js';

/**
 * Bootstrap HTTP minimal. Aucune route metier tant qu'aucun module (Identity, Tenant...)
 * n'existe (Phase 0, etapes 2+) — seul un health check est expose, utile des l'infra CI/CD.
 */
export function createApp(root: CompositionRoot): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', now: root.clock.now().toISOString() });
  });

  return app;
}

function main(): void {
  const root = buildCompositionRoot();
  const app = createApp(root);
  const server = app.listen(root.env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`apps/api ecoute sur le port ${root.env.PORT} (${root.env.NODE_ENV})`);
  });

  // Arret propre (§8 exploitation) : fin des requetes en cours, fermeture des connexions.
  process.on('SIGTERM', () => {
    server.close(() => {
      void root.shutdown();
    });
  });
}

const isEntryPoint = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isEntryPoint) {
  main();
}
