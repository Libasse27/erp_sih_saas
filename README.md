# ERP SIH SaaS

Plateforme SaaS de Système d'Information Hospitalier (SIH) multi-établissements, destinée aux
structures de santé sénégalaises.

## Statut

**Phase 0 — Fondations et SaaS Core** : gelée depuis le 23/08/2026, 13/13 étapes livrées
(identité/RBAC, tenants + isolation RLS, abonnements, paiement, notifications, saga de
provisioning, MFA, audit plateforme, CI/CD et contrôles de conformité). Voir
[`docs/architecture/02-roadmap-migration.md`](docs/architecture/02-roadmap-migration.md) pour le
détail des critères de sortie, et [`docs/architecture/03-open-decisions.md`](docs/architecture/03-open-decisions.md)
pour les résidus encore ouverts (notamment le choix d'un fournisseur SMS, O-07.3).

**Phase 1 — Administration d'établissement** : démarrée sous condition (gouvernance décrite dans
`03-open-decisions.md`), sans attendre la clôture formelle de la Phase 0. Trois incréments
verticaux livrés à ce jour, tous sous la permission `tenant-config:administer` ou
`membership:administer` :

- `GET` / `PATCH /api/v1/facility` — consultation et renommage de l'identité de l'établissement.
- `GET /api/v1/memberships` — consultation paginée des membres du tenant courant.
- `GET /api/v1/facility-settings` — consultation des paramètres régionaux du tenant courant.

Le contrat HTTP complet est décrit dans [`docs/api/openapi.yaml`](docs/api/openapi.yaml).

## Stack technique

- **API** (`apps/api`) — Node.js / TypeScript / Express / Prisma / PostgreSQL / Redis / BullMQ.
  Architecture hexagonale (Clean Architecture), DDD, CQRS. Isolation multi-tenant par
  Row-Level Security Postgres **FORCE**, doublée d'un filtrage applicatif explicite à chaque
  requête (défense en profondeur).
- **Web** (`apps/web`) — React / Vite / Tailwind / TanStack Query / Zustand. Non démarré : attend
  que les contrats du SaaS Core (Phase 0) soient stabilisés.
- **Mobile** (`apps/mobile`) et **Desktop** (`apps/desktop`) — Phase 7 du roadmap, non démarrés.
- **Packages partagés** (`packages/auth`, `packages/config`, `packages/types`, `packages/ui`,
  `packages/validation`) — squelettes du monorepo, pas encore de contenu applicatif.

Monorepo pnpm (`pnpm-workspace.yaml`), gestionnaire de paquets épinglé (`packageManager` dans
`package.json`).

## Prérequis

- Node.js ≥ 20
- pnpm 9.15.0 (voir `package.json` → `packageManager` ; épinglé aussi dans les workflows CI)
- Docker (PostgreSQL 16 et Redis 7 via `docker-compose.yml`)

## Démarrage rapide

```bash
# Dépendances
pnpm install

# Base de données et cache
docker compose up -d

# Variables d'environnement (voir apps/api/.env.example pour le détail et les avertissements)
cp apps/api/.env.example apps/api/.env

# Migrations Prisma — utiliser le rôle superuser Postgres (sih), jamais le rôle applicatif
# (sih_app, non-BYPASSRLS, ne voit rien sans RLS positionné) :
DATABASE_URL="postgresql://sih:sih_dev_only@localhost:5432/sih_dev?schema=public" \
  pnpm --filter @sih/api exec prisma migrate deploy

# Démarrage de l'API en mode watch
pnpm dev:api
```

## Scripts

Depuis la racine du monorepo :

| Commande | Rôle |
|---|---|
| `pnpm test` | Suites de tests de tous les workspaces |
| `pnpm typecheck` | Vérification TypeScript de tous les workspaces |
| `pnpm lint` | ESLint sur l'ensemble du dépôt |
| `pnpm build` | Build de tous les workspaces |
| `pnpm arch:check` | Contrôle des frontières architecturales (`dependency-cruiser`, module `api`) |
| `pnpm sca:gate` | Gate de composition logicielle (dépendances vulnérables, `high`/`critical`) |
| `pnpm sca:watch` | Rapport SCA complet, toutes sévérités, non bloquant |

Côté `apps/api` spécifiquement : `pnpm --filter @sih/api test:coverage` (gate de couverture).

## Documentation

- [`docs/architecture/00-executive-summary.md`](docs/architecture/00-executive-summary.md) — règles de gouvernance
- [`docs/architecture/01-target-architecture.md`](docs/architecture/01-target-architecture.md) — architecture cible
- [`docs/architecture/02-roadmap-migration.md`](docs/architecture/02-roadmap-migration.md) — roadmap par phases
- [`docs/architecture/03-open-decisions.md`](docs/architecture/03-open-decisions.md) — décisions ouvertes (`O-*`)
- [`docs/architecture/adr/`](docs/architecture/adr/) — décisions d'architecture (ADR-0001 à ADR-0014)
- [`docs/api/openapi.yaml`](docs/api/openapi.yaml) — contrat HTTP complet
- [`security/README.md`](security/README.md) — contrôle SCA (dépendances), rituel de revue mensuelle

## Sécurité

Toute vulnérabilité doit être signalée de façon responsable au mainteneur du dépôt plutôt que par
une issue publique. La politique de composition logicielle (dépendances tierces) est décrite dans
[`docs/architecture/adr/0014-politique-sca-dependances.md`](docs/architecture/adr/0014-politique-sca-dependances.md)
et [`security/README.md`](security/README.md).
