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
        path: '^(express|pg|ioredis|bullmq|@prisma/client|argon2|node_modules/(express|pg|ioredis|bullmq|@prisma/client|argon2))',
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
    {
      name: 'no-cross-module-domain-import',
      comment:
        'Un module n\'importe jamais le domain/ d\'un autre module (§5) : les echanges passent ' +
        'par des evenements de domaine ou des ports explicites (contrat publie, ex. ' +
        'modules/identity/application/ports/TenantAccessChecker.ts, cable uniquement dans ' +
        'composition-root.ts). Ajoutee avec le module Tenant (Phase 0, etape 3), verifiee contre ' +
        'un cas reel (Identity -> Tenant) plutot qu\'ecrite a l\'aveugle. `$1` capture le nom du ' +
        'module source ; le `to.path` exclut ce meme nom pour n\'interdire QUE les imports ' +
        'domain/ d\'un AUTRE module (le domain/ de son propre module reste evidemment autorise).',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/(?!$1/)[^/]+/domain' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
  },
};
