# ADR-0004 — Relais Outbox via BullMQ

- **Statut** : **Accepté** — décision actée avec le responsable technique le 2026-08-25 (remplace
  la décision de polling pur actée à l'étape 5, documentée en commentaire de code comme
  « assumée mais non actée avec l'architecte » — ce n'est plus le cas)
- **Date** : 2026-08-25
- **Décideurs** : Architecture + responsable technique
- **Contexte technique** : shared-kernel (Outbox), Phase 0, étape 6/13 (« Outbox + événements +
  idempotence »)

---

## Contexte

L'étape 5/13 a livré une infrastructure Outbox **générique** (table `platform.OutboxMessage`,
`OutboxWriter.ts`, port `OutboxEventHandler`) mais un relais implémenté en **polling SQL pur**
(`OutboxRelay.ts`, `SELECT ... FOR UPDATE SKIP LOCKED`), **sans BullMQ** — `bullmq` n'était même
pas une dépendance déclarée du projet. Cette décision d'implémentation était documentée en tête de
fichier comme un choix technique **assumé mais non validé avec l'architecte**, avec la
justification suivante : le volume attendu (événements SaaS de quelques centaines
d'établissements) ne justifierait pas une file de messages dédiée, et `SKIP LOCKED` offrirait déjà
une distribution sûre entre plusieurs workers.

Cette décision divergeait cependant de **trois sources documentaires déjà publiées** :

1. [01-target-architecture.md §9.3](../01-target-architecture.md#93-evenementiel) : « l'événement
   est persisté dans la même transaction que l'agrégat, **puis relayé par un worker BullMQ** ».
2. [02-roadmap-migration.md](../02-roadmap-migration.md), liste « Livré » de la Phase 0 :
   « Infrastructure Outbox + **workers BullMQ** ».
3. [ADR-0002](0002-database-stack.md) §8 (stack technique) : Redis retenu explicitement comme
   « backend BullMQ », et BullMQ comme choix pour « tâches asynchrones... relais outbox,
   projections, notifications, rappels de rendez-vous ».

Le responsable technique tranche : **BullMQ est la décision retenue** pour le relais Outbox,
alignant l'implémentation sur ce que la documentation d'architecture annonce déjà. Cette ADR
formalise cette décision et remplace la mention en commentaire de code qui la documentait comme
non actée.

## Décision

### 1. Répartition des responsabilités — PostgreSQL reste la source de vérité, BullMQ distribue la charge

Le polling SQL **n'est pas retiré** — il reste l'unique mécanisme sûr de :
- **découverte** de nouveaux messages `PENDING` (`OutboxRelay.ts`, `claimOutboxBatch`) ;
- **reprise après crash** : un message `PROCESSING` dont `locked_at` est périmé est reclamé au
  cycle suivant, que le worker qui le traitait ait crashé au niveau Node.js OU que Redis ait perdu
  le job correspondant (flush, redémarrage) — la garantie *at-least-once* ne dépend JAMAIS de la
  survie de Redis ;
- **dead-letter** : la colonne `attempts`, incrémentée à CHAQUE réclamation, détermine si un échec
  fait repasser le message `PENDING` (nouvelle tentative) ou `FAILED` (`OUTBOX_MAX_ATTEMPTS = 8`,
  intervention manuelle).

Ce que BullMQ apporte, que `SKIP LOCKED` seul n'offrait pas : la **distribution de la charge de
traitement** (pas seulement du verrou) à un ou plusieurs workers concurrents, avec une concurrence
configurable (`OutboxWorker.ts`, `concurrency`), un futur découplage possible en process séparé, et
une famille d'outils d'observabilité (Bull Board, métriques de file) réutilisable pour les autres
files du projet (notifications, rappels de rendez-vous — étapes ultérieures, déjà anticipées par
ADR-0002).

**Conséquence directe** : le retry natif de BullMQ est **désactivé** (`attempts: 1` à l'ajout du
job, voir `OutboxRelay.ts`). Une seule politique de nouvelle tentative existe — celle pilotée par
le compteur Postgres — jamais deux qui pourraient diverger (ex. BullMQ retente un job dont la ligne
Postgres est déjà repassée `FAILED` par ailleurs).

**Nuance (revue post-implémentation)** : BullMQ porte son PROPRE mécanisme de détection de jobs
« stalled » (`lockDuration`/`stalledInterval`/`maxStalledCount`, voir `OutboxWorker.ts`), indépendant
de `staleLockMinutes` côté Postgres et bien plus rapide (dizaines de secondes plutôt que 5 minutes).
La reprise après crash n'est donc **pas exclusivement** pilotée par le délai Postgres — elle peut
être déclenchée plus tôt par BullMQ lui-même. Ce n'est plus dangereux depuis le correctif de
sécurité du §5 ci-dessous (le worker revalide systématiquement `attempts`/`locked_by` en relisant
Postgres avant d'agir) : un job redistribué par BullMQ pour une génération de réclamation périmée
est un no-op, jamais un double traitement. `lockDuration` est fixé à 60s (largement au-dessus de la
durée réelle des transactions traitées par ce relais) pour qu'un traitement normal ne déclenche
jamais de stall — voir le commentaire de `DEFAULT_LOCK_DURATION_MS` dans `OutboxWorker.ts` pour le
détail complet.

### 2. Connexion Redis dédiée pour BullMQ

BullMQ exige `maxRetriesPerRequest: null` sur toute connexion utilisée par un `Worker` (commandes
bloquantes internes). La connexion Redis existante (sessions/cache, `maxRetriesPerRequest: 3`)
n'est **jamais réutilisée** pour cet usage — une seconde connexion dédiée est créée
(`OutboxQueueConnection.ts`), partagée par la `Queue` (producteur) et le `Worker` (consommateur).

### 3. Cycle de vie aligné sur les jobs de fond existants

Le `Worker` BullMQ est construit avec `autorun: false` et démarré explicitement par
`startBackgroundJobs()` (même discipline que le job périodique de polling et les schedulers
Subscription/Payment) ; il est fermé par `stopBackgroundJobs()` (`worker.close()`, qui attend la
fin des jobs en cours — §8 exploitation, arrêt propre). L'ordre d'arrêt (stopper la *découverte*
avant de fermer le *worker*) est documenté en commentaire de `composition-root.ts`.

### 4. Registre générique d'idempotence consommateur (D9)

Livré dans la même passe (exigé par le même point de roadmap, « Outbox + événements +
idempotence ») mais **indépendant** de la migration BullMQ elle-même : une table
`platform.OutboxConsumedEvent` (clé primaire `(outbox_message_id, handler_name)`) et un décorateur
générique `withOutboxIdempotency` (`OutboxIdempotencyGuard.ts`), appliqué **uniformément à tous les
handlers** au moment de leur enregistrement dans `composition-root.ts` — aucun module applicatif
n'a à réimplémenter sa propre déduplication. Voir le commentaire de tête de
`OutboxIdempotencyGuard.ts` pour le détail du raisonnement (pourquoi deux phases, pourquoi ce n'est
pas dans la même transaction que la mutation métier, et pourquoi les gardes d'idempotence
existantes par agrégat restent une défense complémentaire).

### 5. Sécurité — Redis n'est JAMAIS une frontière de confiance (correctif post-revue)

La première implémentation de cette étape faisait transiter l'intégralité de l'enveloppe
(`eventType`, `payload` — donc `tenantId` métier, montants, références de paiement — et
`attempts`) dans la charge du job BullMQ, traitée telle quelle par le worker pour invoquer les
handlers et ouvrir le contexte RLS. Un audit de sécurité a signalé que cela faisait de Redis une
frontière de confiance non maîtrisée : un accès réseau à Redis (ou un conteneur compromis)
suffisait à forger un job (ex. `SaaSPaymentSucceeded` avec un `tenantId` choisi par l'attaquant) et
déclencher un consommateur financier sans paiement réel — le RLS protège fidèlement le tenant que
l'attaquant a lui-même choisi, ce qui ne bloque rien. Un `attempts` forgé permettait aussi un
dead-letter immédiat et silencieux d'un événement légitime.

**Correctif retenu** : `OutboxJobData` est réduite à `{ id }` (voir `OutboxJob.ts`). Le worker
(`OutboxWorker.ts`) :
1. parse le `jobId` BullMQ, qui encode `<id>#<attempts capturé à la réclamation>` (séparateur `#`,
   jamais `:` — BullMQ 6.x rejette tout `jobId` personnalisé contenant `:` hors d'un format legacy
   très spécifique, voir
   `buildOutboxJobId`/`parseOutboxJobId`) ;
2. **relit systématiquement** la ligne réelle `platform.OutboxMessage` par cet identifiant ;
3. vérifie que la ligne existe, que `status === 'PROCESSING'`, que `locked_by` correspond au
   `workerId` de CE worker, et que `attempts` correspond exactement à la génération encodée dans le
   `jobId` — tout écart est un **no-op journalisé**, jamais une exception qui masquerait la cause,
   et jamais une invocation de handler ;
4. vérifie en outre que `payload.tenantId` (quand le payload en porte un) correspond à la colonne
   `tenant_id` de la ligne (défense en profondeur supplémentaire).

C'est cette relecture Postgres — jamais le contenu du job Redis — qui détermine `eventType`,
`tenantId`, `payload` et le seuil de dead-letter. Redis redevient un pur support de distribution de
charge, exactement le rôle que cette ADR lui assigne au §1.

## Conséquences

**Acquis**

- L'implémentation est désormais alignée sur 01-target-architecture.md §9.3, la liste « Livré » de
  la Phase 0 et ADR-0002 — plus aucune divergence documentée entre l'architecture cible et le code.
- La garantie *at-least-once*, la reprise après crash et le dead-letter restent pilotés par
  PostgreSQL comme SOURCE DE VÉRITÉ (nuance : BullMQ peut désormais aussi déclencher une
  redistribution plus rapide via son propre mécanisme de stalled-jobs, voir §1 — sans risque
  d'incohérence depuis le correctif du §5), testés par
  `test/shared-kernel/integration/outboxRelay.test.ts` (adversarial : verrou périmé, échec
  transitoire suivi d'un succès, dépassement du nombre maximal de tentatives, job forgé/périmé sans
  ligne correspondante, worker tué en cours de traitement).
- Le registre générique d'idempotence réclame désormais ATOMIQUEMENT (`INSERT ... ON CONFLICT DO
  NOTHING` avant d'invoquer le handler, retrait de la réclamation si le handler échoue — voir
  `OutboxIdempotencyGuard.ts`), fermant la fenêtre de concurrence entre deux livraisons
  strictement simultanées (testé par un cas `Promise.all` dans
  `test/shared-kernel/integration/outboxIdempotency.test.ts`, en plus du handler factice Identity
  et du handler Payment réel).

**Dette assumée**

- **Fenêtre résiduelle du registre d'idempotence** : un crash du processus *pendant* l'exécution
  d'un handler (ni succès, ni erreur interceptée) laisse la réclamation en place sans certitude que
  l'effet métier a bien été appliqué — voir le commentaire de tête d'`OutboxIdempotencyGuard.ts`.
  Fermer entièrement cette fenêtre exigerait de faire transiter le client transactionnel à travers
  le port `OutboxEventHandler` (mutation métier et écriture du registre dans LA MÊME transaction),
  un changement de contrat plus large que le périmètre de cette passe. C'est pourquoi l'idempotence
  propre à chaque handler/agrégat reste **obligatoire**, documentée comme telle dans
  `docs/domain/events.md`.

- **Un seul process** exécute à la fois l'API HTTP, le poller de découverte et le worker BullMQ
  (même limitation que le reste des jobs de fond de cette étape — scheduler de renouvellement,
  rapprochement de paiements). Le découplage en process séparé (recommandé en production, §11 du
  system prompt) est différé : rien dans cette conception ne l'empêche (le `Worker` BullMQ peut
  être instancié dans un process Node.js distinct partageant la même connexion Redis et le même
  `PrismaClient`), mais aucun script/`Dockerfile` de démarrage séparé n'est fourni par cette passe.
- **Aucune UI d'observabilité de file** (Bull Board ou équivalent) n'est branchée — l'observabilité
  reste celle des logs structurés (`ConsoleStructuredLogger`) déjà en place.
- **Concurrence et nom de file non paramétrables par variable d'environnement** — valeurs par
  défaut codées (`DEFAULT_CONCURRENCY = 5`, `OUTBOX_QUEUE_NAME`), cohérent avec le reste des
  constantes de cette étape (`OUTBOX_MAX_ATTEMPTS`, tailles de lot du polling). À revisiter si un
  besoin de tuning en production se confirme.
- **Aucune trace distribuée (OpenTelemetry)** ni métrique RED n'est ajoutée sur le worker — hors
  mandat de cette étape (voir §8.2 du system prompt, différé à une étape d'observabilité
  ultérieure).
