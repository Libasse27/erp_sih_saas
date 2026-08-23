# ADR-0001 — Stratégie de multi-tenancy

- **Statut** : **Accepté** — définitivement confirmé pour le volet clinique par ADR-0002
  (Option B, PostgreSQL seul, acceptée le 2026-08-23) : le RLS couvre désormais 100 % des
  données, y compris cliniques.
- **Date** : 2026-08-23
- **Décideurs** : Architecture — à contresigner par le responsable technique
- **Contexte technique** : plateforme SIH SaaS, N établissements de santé, PostgreSQL

---

## Contexte

La plateforme héberge N établissements de santé indépendants. Chacun manipule des **données
de santé**, la catégorie de données la plus sensible qui soit. Le cahier des charges (§1, §31)
exige une isolation **stricte** : aucune fuite de données médicales, administratives ou
financières entre établissements. L'ordre de priorité déclaré (§43) place la sécurité et la
confidentialité médicale avant la performance et l'expérience utilisateur.

Le nombre d'établissements attendu se compte en dizaines à centaines, pas en dizaines de
milliers. Les établissements sont hétérogènes en taille : d'un cabinet médical isolé à un
hôpital complet.

Trois modèles classiques sont envisageables.

## Options considérées

### Option A — Une base de données par tenant
- **+** Isolation physique maximale ; sauvegarde et restauration par établissement ;
  suppression de tenant triviale ; aucun risque de requête inter-tenant.
- **−** Coût opérationnel croissant linéairement (migrations à exécuter N fois, N jeux de
  connexions, N sauvegardes à superviser) ; consommation de connexions PostgreSQL prohibitive ;
  statistiques transverses de niveau plateforme (§2) très coûteuses ; provisioning lent, en
  tension avec la Saga d'inscription qui doit rester réactive.

### Option B — Un schéma par tenant, base partagée
- **+** Bonne isolation logique ; sauvegarde sélective possible ; migrations moins lourdes que A.
- **−** Le nombre d'objets de catalogue explose (N × nombre de tables) et dégrade les
  performances du catalogue PostgreSQL ; les migrations restent N fois ; le routage de schéma
  par requête est une source d'erreur classique ; **l'isolation dépend encore du code
  applicatif** qui positionne le `search_path`.

### Option C — Schéma partagé, colonne `tenant_id`, Row-Level Security
- **+** Une seule migration ; provisioning instantané ; statistiques plateforme naturelles ;
  exploitation homogène ; **le RLS PostgreSQL applique le filtrage dans le moteur, sous la
  couche applicative** — un bug de code ne peut pas contourner la politique.
- **−** Une erreur de configuration RLS est globale ; sauvegarde par tenant plus complexe ;
  le « voisin bruyant » n'est pas isolé ; exige une discipline stricte (toute table tenant
  porte `tenant_id NOT NULL` et une politique).

## Décision

**Option C retenue** : schéma partagé, colonne `tenant_id` obligatoire, **Row-Level Security
PostgreSQL activée et forcée** (`FORCE ROW LEVEL SECURITY`, y compris pour le propriétaire de
table), avec `SET LOCAL app.tenant_id` positionné **par transaction** à partir du contexte de
session résolu côté serveur.

**Avec une porte de sortie explicite** : un établissement présentant une exigence
réglementaire particulière ou une volumétrie hors norme peut être **promu vers une base
dédiée** (Option A) sans modification du code applicatif — le domaine et l'application
ignorent le modèle de tenancy, seul le résolveur de connexion change. Cette capacité de
promotion est conçue dès la Phase 0 ; elle n'est pas implémentée tant qu'aucun tenant ne le
justifie (YAGNI).

L'isolation ne repose **jamais sur une seule barrière**. Cinq couches (détaillées dans
[01-target-architecture.md §3.2](../01-target-architecture.md#3-multi-tenancy)) :

1. Contexte de session — `tenantId` résolu serveur, jamais accepté du client
2. Application — `TenantId` en Value Object obligatoire dans chaque Command, Query et
   signature de repository ; jamais optionnel
3. Persistance — prédicat tenant injecté par le repository, non délégué à l'appelant
4. **Base — politique RLS PostgreSQL : garantie de dernier recours**
5. Tests — suite « non-fuite inter-tenant » en CI sur chaque agrégat exposé

Le RLS est ce qui distingue cette décision d'un simple `WHERE tenant_id = ?`, qui serait
insuffisant pour des données de santé : c'est la seule couche qu'un développeur ne peut pas
oublier.

## Justification au regard de l'ordre de priorité

L'Option A offre une isolation nominalement supérieure, mais son coût opérationnel se paie en
**fiabilité** : N migrations, N sauvegardes, N supervisions, avec une probabilité de dérive
proportionnelle à N. Une base oubliée lors d'une migration de sécurité est un risque réel.
L'Option C, adossée au RLS, atteint un niveau d'isolation très proche avec une surface
opérationnelle constante — donc plus sûre en pratique à l'échelle visée.

## Conséquences

**Positives**
- Isolation appliquée par le moteur, insensible aux erreurs de code applicatif
- Une seule migration, un seul jeu de sauvegardes, une seule supervision
- Provisioning d'établissement immédiat, compatible avec la Saga d'inscription
- Statistiques de niveau plateforme (§2) directement accessibles
- Migration ultérieure vers une base dédiée possible sans réécriture du domaine

**Négatives / risques acceptés**
- Une politique RLS manquante sur une nouvelle table est une faille silencieuse.
  **Mitigation obligatoire** : test automatisé en CI qui énumère les tables du schéma tenant et
  échoue si l'une n'a pas `tenant_id NOT NULL` **et** une politique RLS active. Ce test est un
  livrable de Phase 0, non négociable.
- Restauration d'un seul établissement plus complexe qu'en Option A. **Mitigation** : procédure
  d'export/restauration par tenant documentée et testée en Phase 7.
- Pas d'isolation des ressources : un tenant très actif peut dégrader les autres.
  **Mitigation** : quotas par forfait, rate limiting, supervision par tenant.
- Les données de niveau plateforme vivent dans un schéma `platform` distinct, **hors RLS
  tenant**, accessible uniquement au rôle `SUPER_ADMIN`. Cette frontière doit être testée aussi
  rigoureusement que la frontière inter-tenant.

**Dette assumée**
- La promotion d'un tenant vers une base dédiée est **conçue mais non implémentée**. À
  implémenter au premier besoin réel.

## Dépendance (résolue)

Cette décision suppose que **PostgreSQL est le système de référence**. ADR-0002 (Option B,
acceptée le 2026-08-23) confirme PostgreSQL seul comme moteur unique : la couche 4 (RLS)
**couvre donc bien 100 % des données, y compris cliniques**. L'hypothèse alternative (MongoDB
pour le clinique, isolation reposant uniquement sur les couches 1-3 applicatives) est écartée —
voir [ADR-0002](0002-database-stack.md) et [O-01](../03-open-decisions.md#o-01--base-de-données--postgresql-seul-ou-postgresql--mongodb).
