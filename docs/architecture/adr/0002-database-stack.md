# ADR-0002 — Choix de la stack de persistance

- **Statut** : **Accepté** — Option B confirmée par le responsable technique le 2026-08-23
  (voir [O-01](../03-open-decisions.md#o-01--base-de-données--postgresql-seul-ou-postgresql--mongodb) — clos)
- **Date** : 2026-08-23
- **Décideurs attendus** : responsable technique + futur exploitant de la plateforme
- **Contexte technique** : plateforme SIH SaaS, Node.js/TypeScript, déploiement Sénégal /
  Afrique de l'Ouest

---

## Contexte

La plateforme manipule deux natures de données très différentes :

1. **Données transactionnelles fortement structurées** — identité, tenants, forfaits,
   abonnements, paiements, facturation patient, assurance, caisse, **comptabilité SYSCOHADA**,
   stocks, RH. Elles exigent des transactions ACID, une intégrité référentielle forte et des
   invariants stricts (partie double : somme des débits === somme des crédits).
2. **Données cliniques semi-structurées** — consultations, observations, comptes rendus,
   résultats de laboratoire, métadonnées d'imagerie, documents. Leur forme varie selon la
   spécialité, le type d'établissement et évoluera avec l'ajout de spécialités.

La stack habituelle de l'équipe est Node.js/TypeScript/Express avec MongoDB et Redis. Le
contexte de déploiement est l'Afrique de l'Ouest, où l'expertise d'exploitation MongoDB
(sauvegarde, restauration, supervision, mise à jour) est plus rare que celle de PostgreSQL.

L'ordre de priorité déclaré (§43) est : **sécurité > intégrité des données > confidentialité
médicale > cohérence métier > fiabilité > tests > performance > UX**.

## Options considérées

### Option A — PostgreSQL + MongoDB (recommandation par défaut initiale, stack habituelle)

PostgreSQL comme système de référence pour l'identité, le tenant, la facturation et la
comptabilité ; MongoDB pour le documentaire clinique ; Redis pour sessions, cache et files.

- **+** Souplesse de schéma pour des documents cliniques hétérogènes et évolutifs.
- **+** Continuité avec les compétences existantes de l'équipe.
- **+** Modélisation naturelle des ressources de type FHIR (documents imbriqués).
- **−** **L'isolation tenant n'est plus homogène** : la Row-Level Security d'ADR-0001 ne
  s'applique pas à MongoDB. La confidentialité des données **les plus sensibles** reposerait
  alors uniquement sur du code applicatif — la couche de dernier recours disparaît là où elle
  est la plus nécessaire.
- **−** **Aucune transaction ne peut couvrir les deux moteurs.** Toute opération touchant le
  clinique et le financier devient une Saga avec compensation, y compris dans des cas où une
  transaction unique suffirait.
- **−** Deux moteurs à exploiter, sauvegarder, restaurer, superviser, mettre à jour et
  sécuriser. Deux plans de reprise d'activité. Deux surfaces d'attaque.
- **−** Restauration à un instant T cohérente entre les deux bases : difficile, et critique
  pour un dossier médical.

### Option B — PostgreSQL seul, avec colonnes JSONB pour le documentaire clinique

- **+** **Isolation tenant homogène** : le RLS d'ADR-0001 couvre **100 %** des données, y
  compris cliniques. C'est l'alignement direct avec les priorités 1 et 3.
- **+** **Cohérence transactionnelle locale de l'Outbox** : l'écriture de l'acte clinique et la
  publication de l'événement `ActeRealise` dans la table Outbox se font dans une seule
  transaction locale, garantissant qu'aucun événement n'est perdu ni dupliqué au niveau du
  moteur — **sans coupler pour autant les bounded contexts clinique et financier**. La
  Facturation reste strictement un consommateur d'événements asynchrone ; elle n'écrit jamais
  dans la même transaction que le clinique et ne lit jamais le DME. Un moteur unique simplifie
  l'infrastructure de l'Outbox (une seule base à surveiller), il ne justifie pas de transaction
  applicative conjointe clinique + financier.
- **+** Un seul système à exploiter : une sauvegarde, une restauration cohérente, une
  supervision, un plan de reprise. Décisif en contexte de compétences d'exploitation rares.
- **+** JSONB offre l'essentiel de la souplesse documentaire (indexation GIN, requêtes sur
  chemins, contraintes de validation possibles) tout en conservant l'ACID.
- **+** L'audit append-only et son chaînage bénéficient des garanties transactionnelles.
- **−** Modélisation documentaire moins naturelle qu'en base document ; des agrégations
  complexes sur JSONB sont plus verbeuses.
- **−** Écart avec l'habitude de l'équipe ; montée en compétence PostgreSQL avancé nécessaire.
- **−** Sur de très gros volumes de documents, MongoDB offrirait un partitionnement horizontal
  plus simple — mais cette échelle n'est pas celle du projet à moyen terme.

### Option C — MongoDB seul

Écartée sans discussion : la comptabilité SYSCOHADA et la facturation exigent des transactions
ACID multi-documents et une intégrité référentielle forte. La priorité « intégrité des
données » l'interdit.

## Décision

**Option B — PostgreSQL seul avec JSONB — est retenue**, contrairement à la stack
habituelle, pour trois raisons qui découlent mécaniquement de l'ordre de priorité imposé :

1. **Confidentialité (priorité 3)** — Option B place les données cliniques sous la même
   garantie RLS que le reste. Option A les en exclut. Il serait incohérent d'appliquer la
   protection la plus forte aux données de facturation et la plus faible aux dossiers médicaux.
2. **Intégrité (priorité 2)** — la cohérence transactionnelle locale de l'Outbox (acte clinique
   + événement publiés dans une même transaction) élimine la classe de désynchronisations
   « événement perdu / dupliqué », sans réintroduire de couplage transactionnel entre le
   clinique et le financier : la séparation par événements (§ Facturation strictement isolée
   du clinique) reste intacte.
3. **Fiabilité (priorité 5)** — un seul moteur à exploiter, sauvegarder et restaurer réduit
   le risque opérationnel réel dans le contexte de déploiement visé.

Redis est retenu dans les deux options (sessions révocables, cache, backend BullMQ) — ce n'est
pas un système de référence et son usage n'est pas remis en cause.

**Cette décision s'écarte de la stack habituelle du compte** et engage la montée en compétence
de l'équipe sur PostgreSQL avancé (JSONB, RLS, partitionnement). Elle a été validée
explicitement (O-01, clos le 2026-08-23) plutôt que tranchée unilatéralement.

**Point de réouverture prévu** : si, en Phase 5 (laboratoire, imagerie), un besoin documentaire
réel s'avère mal servi par JSONB — mesuré, pas supposé — MongoDB pourra être introduit en
**base secondaire strictement limitée** à ce besoin, sous un nouvel ADR, avec une isolation
tenant applicative explicitement testée.

## Conséquences

**Si Option B est retenue**
- Positives : RLS universel ; transactions homogènes ; exploitation simplifiée ; restauration
  cohérente ; sauvegarde unique.
- Négatives : montée en compétence PostgreSQL (JSONB, index GIN, RLS, partitionnement) ;
  modélisation clinique à concevoir avec soin pour éviter le « JSONB fourre-tout » — la
  structure connue et stable reste en colonnes typées, seul le variable va en JSONB.
- Dette assumée : partitionnement des tables cliniques volumineuses à prévoir avant la mise en
  production (Phase 7).

**Si Option A est retenue malgré tout**
Trois contreparties deviennent **obligatoires**, non optionnelles :
1. Un **test d'isolation tenant spécifique à MongoDB** sur chaque collection, compensant
   l'absence de RLS — et la reconnaissance écrite que cette garantie est plus faible.
2. Une **Saga documentée avec compensation** pour toute opération franchissant les deux
   moteurs, et l'interdiction formelle d'une écriture croisée sans compensation.
3. Une **procédure de restauration cohérente inter-bases** documentée et **exercée** avant
   toute mise en production.

Dans tous les cas, l'architecture protège ce choix : le domaine et l'application ne connaissent
que des **ports de repository**. Le changement de moteur affecte `infrastructure/` uniquement,
et les **tests de contrat** sont exécutés à l'identique sur l'implémentation en mémoire et sur
l'implémentation réelle. Le coût d'un changement ultérieur est réel mais borné.

## Liens

- [ADR-0001 — Stratégie de multi-tenancy](0001-multi-tenancy-strategy.md) — dépendance directe
- [01-target-architecture.md §8](../01-target-architecture.md#8-stack-technique)
- [03-open-decisions.md — O-01](../03-open-decisions.md)
