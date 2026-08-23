/**
 * Regles d'architecture verifiees en CI (01-target-architecture.md §5).
 * `pnpm --filter @sih/api arch:check` echoue si une regle est violee.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-framework',
      comment:
        'domain/ ne doit importer aucun framework ni bibliotheque d\'acces aux donnees (Clean Architecture, §5).',
      severity: 'error',
      from: { path: '^src/(shared-kernel/domain|modules/[^/]+/domain)' },
      to: {
        path: '^(express|pg|ioredis|bullmq|node_modules/(express|pg|ioredis|bullmq))',
        dependencyTypes: ['npm', 'npm-dev'],
      },
    },
    {
      name: 'application-no-infrastructure',
      comment: 'application/ n\'importe jamais infrastructure/ (§5).',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application' },
      to: { path: '^src/modules/[^/]+/infrastructure' },
    },
    // La regle "un module n'importe jamais le domain/ d'un autre module" (§5) sera ajoutee
    // avec le deuxieme module (Phase 0, etape 3 : Tenant), verifiee contre un cas reel plutot
    // qu'ecrite a l'aveugle avant qu'un module cross-reference n'existe.
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
  },
};
