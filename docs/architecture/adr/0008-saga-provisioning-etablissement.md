# ADR-0008 — Saga de provisioning d'établissement : parcours trial-first, composition Subscription↔AccessChecker, reprise idempotente

- **Statut** : **Accepté** (2026-08-28) — validé par le responsable technique, y compris les deux
  écarts au brief initial retenus par cette ADR (chorégraphie Outbox plutôt qu'un orchestrateur
  `Saga` dédié, §4 ; retry-jusqu'à-complétion plutôt que compensation destructive, §5) et la
  précision sur `SubscriptionStatus` (§3, aucune branche « état non fonctionnel » à coder).
  **Amendement 1 (2026-08-28, même jour)** : la première tranche d'implémentation (composition
  Subscription↔AccessChecker + premier maillon `HealthFacilityCreated → StartTrialSubscription`,
  495/495 tests) a révélé un point bloquant non couvert par la version initiale — aucun événement de
  la chaîne ne portait l'identité du `UserAccount` devant recevoir `ADMIN_ETABLISSEMENT`. L'agent a
  correctement remonté ce point plutôt que de l'inventer (voir §9 ci-dessous pour la résolution
  actée). Résidus 1 et 2 (contenu de `SeedFacilityConfiguration`, nature de `StartOnboarding`)
  également tranchés par cet amendement (§10/§11).
- **Date** : 2026-08-28
- **Décideurs** : Architecture (proposition) + responsable technique (validé le 2026-08-28,
  amendement 1 validé le 2026-08-28)
- **Contexte technique** : modules `tenant`, `subscription`, `identity` (composition-root), Phase 0,
  étape 10/13 (« Saga provisioning + impayé/mode dégradé »)

---

## Contexte

Avant tout code d'étape 10, une revue du périmètre (voir l'échange qui précède cette ADR) a
identifié deux points qui ne peuvent pas être laissés à l'interprétation d'un agent d'implémentation :

**1. Ambiguïté texte entre O-02.5 et le diagramme de Saga de 01-target-architecture.md §6.3.**
Le diagramme littéral place `InitiatePayment (externe, ACL) → [succès] ActivateSubscription` comme
étape de la Saga d'inscription, ce qui semblerait imposer un paiement bloquant au provisioning.
Or O-02.5 (clos) impose l'inverse : tout signup passe par un essai STANDARD 30 jours, **sans moyen
de paiement requis**. Aucune commande `CreateSubscription`/`StartPaidSubscription` n'existe dans le
code — seule `StartTrialSubscription` crée un abonnement au signup. ADR-0001 qualifie par ailleurs
la Saga d'inscription de devant rester « réactive » et le provisioning d'« immédiat » — un appel
réseau synchrone bloquant vers un PSP en plein milieu du parcours contredirait cette exigence.

**2. Faille d'accès déjà présente dans le code livré, pas seulement un risque futur.**
`HealthFacility.create()` (étape 3) met `status = 'ACTIVE'` **immédiatement** à la création — aucun
état intermédiaire n'existe (`FacilityStatus` = `ACTIVE`/`SUSPENDED` seulement, décision assumée à
l'étape 3). `TenantModuleBackedAccessChecker.checkAccess()` (composition-root, seul point qui
décide si un contexte de session peut s'ouvrir sur un tenant) ne lit **que**
`HealthFacility.isActive()` — il ne consulte jamais `Subscription`. Le commentaire de tête de
`HealthFacility.ts` anticipait explicitement cette composition (« ce sera la responsabilité du
futur module Subscription, qui composera avec ce statut sans le remplacer ») mais elle n'a jamais
été implémentée. **Conséquence actuelle, vérifiable dès aujourd'hui** : un tenant dont
`CreateHealthFacility` a réussi mais dont `StartTrialSubscription` a échoué (crash, erreur) est déjà
`ACCESSIBLE` pour l'ouverture de session, avant même qu'un abonnement, un rôle admin ou une
configuration n'existent.

Cette ADR ferme les deux points par des décisions dérivées de ce qui est **déjà** acté
(O-02.5, ADR-0001, le commentaire d'intention de l'étape 3) — elle n'invente aucune règle métier
nouvelle sur la tarification, le paiement ou l'impayé.

---

## Décision

### 1. Provisioning trial-first en V1 — aucun paiement dans la Saga d'inscription

Le parcours V1 est :

```
CreateUserAccount → CreateHealthFacility(ownerUserId) → HealthFacilityCreated
   → [Outbox] StartTrialSubscription → SubscriptionStarted
   → [Outbox] GrantMembership(ownerUserId, tenantId, ADMIN_ETABLISSEMENT) → MembershipGranted
   → [Outbox] SeedFacilityConfiguration → FacilityConfigurationSeeded
   → [Outbox] StartOnboarding → ProvisioningCompleted
```

Voir §9 pour la propagation d'`ownerUserId` (amendement 1), §10 pour le contenu de
`SeedFacilityConfiguration` et §11 pour la nature de `StartOnboarding`/`ProvisioningCompleted`.

`InitiatePayment` **n'apparaît pas** dans cette Saga. La lecture retenue pour O-25.1
(« Abonnement initial + renouvellements + upgrade proratisé ») est que « abonnement initial »
désigne le premier paiement réel encaissé (conversion essai → payant), traité par le mécanisme de
renouvellement **déjà livré à l'étape 5** (`ProcessSubscriptionRenewalsHandler`,
`InitiatePaymentHandler`), pas un paiement bloquant intégré au provisioning. Cette lecture est
cohérente avec O-02.5, ADR-0001 et l'absence de toute commande de souscription payante à
l'inscription dans le code existant — elle est actée ici pour éviter qu'un futur lecteur ne
réintroduise un paiement bloquant en se fiant au seul diagramme §6.3, désormais **superseded** par
cette ADR pour ce qui concerne l'étape d'inscription.

Fin d'essai : voir §8 — aucun mécanisme nouveau, réutilisation stricte de l'existant.

### 2. `HealthFacility` reste `ACTIVE`/`SUSPENDED` — aucun état piloté par la facturation n'y est ajouté

La décision de l'étape 3 n'est pas rouverte. `FacilityStatus` ne gagne pas de valeur
`PENDING`/`PROVISIONING` : `HealthFacility.create()` continue de démarrer `ACTIVE`, cohérent avec
ADR-0001 (provisioning immédiat). La responsabilité de bloquer l'accès pendant un provisioning
incomplet est déplacée entièrement au §3 — jamais dupliquée sur cet agrégat.

### 3. Composition `Subscription` dans `TenantModuleBackedAccessChecker` — la faille du §Contexte se ferme ici

Règle cible :

```
ACCESSIBLE  ⟺  HealthFacility.isActive() ET Subscription existe pour ce tenant
                ET Subscription.status ∈ {TRIALING, ACTIVE, GRACE_PERIOD, DEGRADED}
```

Refus :
- `HealthFacility` `SUSPENDED` (inchangé, priorité sur tout le reste) ;
- `Subscription` absente pour ce tenant (couvre exactement le scénario du §Contexte : provisioning
  interrompu avant `StartTrialSubscription`) ;
- **Précision technique** : `SubscriptionStatus` (`value-objects/SubscriptionStatus.ts`) est un
  type fermé à exactement quatre valeurs, **toutes fonctionnelles**
  (`TRIALING`/`ACTIVE`/`GRACE_PERIOD`/`DEGRADED` — aucun `CANCELLED`/`EXPIRED`/`FAILED` n'existe sur
  cet agrégat). Il n'existe donc **aucune branche « Subscription dans un état non fonctionnel »** à
  coder : la seule condition de refus côté Subscription est son **absence**. Un agent qui coderait
  un `switch` sur le statut avec un cas de refus inventerait une branche morte — à proscrire
  explicitement dans le brief.

`HealthFacility` reste seul responsable de son propre statut (§2) ; le module `subscription` n'est
jamais importé dans son domaine — la composition vit exclusivement dans l'adaptateur cross-module
existant (`TenantModuleBackedAccessChecker`), qui devient cross-**trois**-modules
(identity/tenant/subscription) en respectant la même règle déjà documentée en tête de fichier
(« le seul point du code autorisé à connaître les deux modules à la fois » — à mettre à jour pour
trois).

**Précision actée à la validation** : `ProvisioningCompleted` (dernier événement de la chaîne §4)
n'est **jamais** une source d'autorisation. `TenantModuleBackedAccessChecker.checkAccess()` continue
de dériver `ACCESSIBLE` **dynamiquement** de l'état réel de `HealthFacility` + `Subscription` à
l'instant de l'appel — jamais d'un indicateur « provisioning terminé » mis en cache ou stocké sur un
agrégat. Un futur raccourci qui court-circuiterait cette lecture dynamique (ex. un flag
`provisioningCompletedAt` consulté à la place de l'état réel) romprait la garantie du §Contexte sans
qu'aucun test de ce document ne le détecte à coup sûr si ce flag est positionné trop tôt — la règle
d'accès doit rester **stateless vis-à-vis de la Saga elle-même**.

### 4. Mécanique de la Saga — chorégraphie via l'Outbox existant, pas un second orchestrateur

Le brief initial envisageait un orchestrateur centralisé (« Saga créée → étape persistée → action →
événement/Outbox → étape suivante »). Cette ADR retient une implémentation plus étroite, alignée sur
le pattern **déjà validé et testé** en étape 5 (Payment) et étape 9 (Notifications) : chaque étape de
la Saga est un **consommateur Outbox de l'événement émis par l'étape précédente**, exactement comme
`SendWelcomeEmailOnSubscriptionStarted` consomme `SubscriptionStarted` aujourd'hui.

Raison du choix : introduire une table/agrégat `Saga` dédié avec son propre suivi d'état serait une
**seconde mécanique de reprise après crash concurrente** à celle de l'Outbox — exactement ce que le
brief initial voulait éviter. L'Outbox porte déjà, éprouvé par les tests adversariaux des étapes
5/6/9, tout ce qu'une Saga chorégraphiée exige : persistance de la progression (chaque étape franchie
est un événement déjà écrit en base dans la même transaction que son agrégat), reprise après crash
(`OutboxRelay`, verrou périmé réclamé au cycle suivant), idempotence consommateur générique
(`withOutboxIdempotency`), distribution de charge (BullMQ). Ajouter un orchestrateur reviendrait à
dupliquer cette garantie avec une politique de retry potentiellement divergente — la même faute que
celle qu'ADR-0004 §1 interdit explicitement entre BullMQ et Postgres.

**Chaque étape (handler Outbox) doit être elle-même idempotente** au sens déjà documenté par
`docs/domain/events.md` (garantie de premier niveau, pas absolue) : un rejeu du même événement ne
doit produire ni doublon ni erreur non gérée. `GrantMembershipHandler` l'illustre déjà
(`MEMBERSHIP_ALREADY_EXISTS` est un `Result.failure` métier, pas une exception) — un consommateur
Outbox qui rejoue cette commande doit traiter ce cas comme « étape déjà faite », pas comme un échec
qui déclenche une compensation.

### 5. Retry-jusqu'à-complétion, pas de compensation destructive

Conséquence directe du §3 : une fois l'accès conditionné à la présence d'une `Subscription`
fonctionnelle, un tenant partiellement provisionné est **déjà inerte** (personne ne peut y ouvrir de
contexte). Le besoin d'une compensation qui **annule** `HealthFacility` ou révoque un rôle déjà
accordé disparaît largement : le principe retenu est que la Saga **retente jusqu'à complétion**
(portée par la garantie at-least-once de l'Outbox, §4), jamais qu'elle démonte ce qui a déjà réussi.

Ceci reste strictement cohérent avec O-03.1 (« aucune suppression de données à aucune étape ») :
- **Aucune compensation ne supprime ni n'altère un tenant existant.**
- Une étape qui échoue durablement (ex. `SeedFacilityConfiguration` en erreur après
  `NOTIFICATION_MAX_ATTEMPTS`-like épuisement) laisse le tenant **inaccessible** (§3) mais **intact**
  — jamais un état `SUSPENDED` forcé ni une suppression. Le déblocage reste une intervention
  opérationnelle (dead-letter, même famille que `NOTIFICATION_MAX_ATTEMPTS`/`OUTBOX_MAX_ATTEMPTS`),
  pas une décision produit à inventer ici.

### 6. `ADMIN_ETABLISSEMENT` strictement scopé au nouveau tenant

Déjà garanti par construction : `UserTenantMembership.grant()` et `GrantMembershipRepository.save()`
prennent systématiquement `tenantId` en paramètre explicite (voir `GrantMembership.ts`) — aucune
extension nécessaire, cette ADR l'acte comme invariant de la Saga plutôt que comme un risque
résiduel.

### 7. Fin d'essai — aucun nouveau mécanisme

`StartTrialSubscription` positionne `trialEndsAt`. La transition hors essai est **déjà** couverte
par `ProcessSubscriptionRenewalsHandler` (étape 5) : `isRenewalDue()` traite `TRIALING` exactement
comme `ACTIVE` (voir `Subscription.gracePeriod.test.ts`, « `isRenewalDue()` est vrai... pour
`TRIALING` comme pour `ACTIVE` »). Cette étape n'a rien à ajouter ici — le mentionner évite qu'un
agent ne (ré)invente un scheduler dédié à la fin d'essai.

### 8. `SeedFacilityConfiguration` et `StartOnboarding` — place dans la Saga

Cette ADR acte leur **place** dans la Saga (après `GrantMembership`, avant la fin du provisioning).
Leur contenu est tranché par l'amendement 1 — voir §10 et §11.

---

## Amendement 1 (2026-08-28) — propagation `ownerUserId`, contenu du seed, nature de `StartOnboarding`

### 9. `ownerUserId` porté par le contexte de provisioning, jamais une relation `User → Tenant`

**Constat ayant motivé cet amendement** : `HealthFacilityCreated`/`SubscriptionStarted` ne portaient
aucune information permettant de savoir quel `UserAccount` doit recevoir `ADMIN_ETABLISSEMENT` —
aucune route d'inscription n'existe encore dans le dépôt qui lierait `CreateUserAccount` et
`CreateHealthFacility`. L'agent d'implémentation a correctement remonté ce point plutôt que de
l'inventer (voir rapport de fin de tâche, première tranche de l'étape 10).

**Décision retenue : option (a)**, rejetant un orchestrateur synchrone `RegisterEstablishment` qui
chaînerait toute la Saga en mémoire (cette option romprait la garantie de reprise après crash du §4 —
un crash en cours de chaîne synchrone dépendrait d'un nouvel appel HTTP ou d'une logique de reprise
ad hoc, exactement la « seconde mécanique concurrente » que le §4 interdit déjà).

- `CreateHealthFacilityCommand` gagne un champ **obligatoire** `ownerUserId: string` (validé comme
  `UserAccountId` existant). `CreateHealthFacilityHandler` ne change aucune autre règle métier de
  cet agrégat — voir §2, `HealthFacility` reste `ACTIVE`/`SUSPENDED` uniquement, il ne stocke
  **pas** `ownerUserId` comme propriété persistante (pas de colonne `HealthFacility.ownerUserId`).
- `HealthFacilityCreated.ownerUserId: string` — **ajout additif** au sens de la convention de
  versionnage de `docs/domain/events.md` : `eventVersion` **reste 1**, aucun champ existant n'est
  renommé ni supprimé. Propagé ensuite au payload de chaque événement de la Saga qui en a besoin en
  aval (`SubscriptionStarted` n'a pas besoin de le porter s'il n'est PAS consommé par la Saga pour
  cette étape précise — seul `MembershipGranted`, via la commande `GrantMembership`, en a besoin
  comme paramètre d'entrée ; le consommateur `StartTrialSubscriptionOnHealthFacilityCreated` doit
  donc **relire** `ownerUserId` depuis l'enveloppe `HealthFacilityCreated` reçue en Outbox et le
  propager explicitement dans le déclenchement de l'étape `GrantMembership` suivante — jamais une
  relecture a posteriori de `HealthFacility` ou d'un autre agrégat pour le retrouver).
- **Modèle relationnel inchangé** : `UserAccount → UserTenantMembership → HealthFacility` reste la
  seule relation persistante (O-05, déjà acté). `ownerUserId` est une **donnée de corrélation du
  provisioning initial**, portée par les événements de la Saga le temps qu'elle s'exécute — jamais
  une colonne `UserAccount.tenantId` ni un second chemin de relation `User ↔ Tenant`.
- **Provenance — jamais une preuve d'autorité côté client** : `ownerUserId` ne doit **jamais** être
  accepté tel quel depuis un corps de requête HTTP non authentifié. Il doit provenir de l'identifiant
  du `UserAccount` fraîchement créé par `CreateUserAccountHandler` dans la même requête serveur (le
  futur point d'entrée HTTP d'inscription, hors périmètre de cette Saga — voir résidu ci-dessous),
  jamais d'un champ de formulaire transmis en promettant « c'est moi ». Ceci ne réintroduit **pas**
  l'option (c) rejetée : seul le **couple** `CreateUserAccount → CreateHealthFacility(ownerUserId)`
  reste synchrone (il l'était déjà : `CreateUserAccount` est un point d'entrée séparé, §1), tout ce
  qui suit `HealthFacilityCreated` reste intégralement chorégraphié par l'Outbox (§4), donc couvert
  par sa garantie de reprise après crash.
- **Événements historiques sans `ownerUserId`** : n'existent pas en pratique (aucun `HealthFacility`
  n'est en production avant cette ADR — Phase 0 encore en cours de construction), donc aucune
  migration de données ni traitement de rétrocompatibilité n'est requis. Un consommateur qui
  lirait un jour un `HealthFacilityCreated` historique dépourvu du champ ne doit **jamais inventer**
  une identité par défaut — échec explicite et remontée en dead-letter, jamais une valeur devinée.
- **`ADMIN_ETABLISSEMENT` strictement scopé au couple `(ownerUserId, tenantId)`** — précision du §6 :
  jamais un rôle global, jamais un `tenantId` fourni par un client, toujours le couple porté par la
  chaîne d'événements décrite ci-dessus.

### 10. `SeedFacilityConfiguration` — contenu V1 tranché

Limité à la configuration technique minimale nécessaire au fonctionnement du tenant, aucune donnée
métier hospitalière : paramètres régionaux `fr-SN`, fuseau horaire `Africa/Dakar`, devise `XOF`,
indicatif téléphonique `+221`, paramètres généraux par défaut du tenant. **Aucun contenu métier
hospitalier complexe** (services, bâtiments, catalogue d'actes — Phase 1) n'est semé ici ; ce
périmètre reste strictement celui déjà posé par 01-target-architecture.md §6.4 pour ce qui relève de
Phase 1, non anticipé.

### 11. `StartOnboarding` — signal de fin de provisioning, pas une machine métier backend

Retenu comme événement de clôture backend minimal : `ProvisioningCompleted`, émis en dernière étape
de la chorégraphie. Il ne porte aucune sémantique métier au-delà de « la Saga a atteint sa fin » et,
conformément au §3, **n'est jamais consulté par `TenantModuleBackedAccessChecker`** — l'accès reste
dérivé dynamiquement de l'état réel, jamais de cet événement. La couche frontend/applicative
(`apps/web`, flux « onboarding » déjà listé comme livré dans `02-roadmap-migration.md`) démarre son
propre parcours à réception de ce signal ; aucune machine à états métier backend n'est ajoutée pour
`StartOnboarding` lui-même.

---

## Résidus explicitement non tranchés par cette ADR

Résidus 1 (contenu de `SeedFacilityConfiguration`) et 2 (nature de `StartOnboarding`) de la version
initiale sont **tranchés par l'amendement 1** (§10/§11) et retirés de cette liste.

1. **Point d'entrée HTTP d'inscription** (`CreateUserAccount → CreateHealthFacility(ownerUserId)`)
   — aucune route n'existe encore dans le dépôt. Cette ADR fixe le contrat que ce futur point
   d'entrée doit respecter (§9 : synchrone pour ce seul couple, `ownerUserId` jamais accepté tel
   quel depuis un client) mais n'implémente pas la route elle-même — hors périmètre de la
   chorégraphie Outbox de cette étape.
2. **Nom exact des événements `MembershipGranted`→`SeedFacilityConfiguration` et
   `FacilityConfigurationSeeded`→`StartOnboarding`** (chaînage Outbox restant, §4/§9) — à documenter
   dans `docs/domain/events.md` au moment de l'implémentation, pas ici. `HealthFacilityCreated` et
   `SubscriptionStarted` existent déjà et ne sont pas concernés par ce résidu.
3. **Seuil de dead-letter par étape de la Saga** (§5) — par analogie avec
   `NOTIFICATION_MAX_ATTEMPTS`/`OUTBOX_MAX_ATTEMPTS`, une constante opérationnelle à fixer à
   l'implémentation, pas une décision métier.
4. **Supervision d'un tenant bloqué en dead-letter de provisioning** — aucune alerte dédiée n'est
   actée ici (même famille que les résidus F10/F11 d'ADR-0007).

---

## Gate pour l'agent d'implémentation

Brief à donner tel quel, sans reformulation qui en élargirait la portée :

> Ne rien inventer concernant Billing/Payment. Ne pas modifier les règles O-02/O-25 ni les états
> `Subscription` déjà gelés (`SubscriptionStatus` reste à 4 valeurs, toutes fonctionnelles — aucune
> branche « état non fonctionnel » à coder, la seule condition de refus côté Subscription est son
> absence). Poursuivre la chorégraphie Outbox de la Saga de provisioning (§1/§4/§9), déjà amorcée
> par `HealthFacilityCreated → StartTrialSubscription` : ajouter `ownerUserId` (obligatoire) à
> `CreateHealthFacilityCommand`/`HealthFacilityCreated` (ajout additif, `eventVersion` reste 1, voir
> §9), le propager jusqu'à `GrantMembership(ownerUserId, tenantId, ADMIN_ETABLISSEMENT)`, puis
> enchaîner `SeedFacilityConfiguration` (contenu fixé au §10, rien au-delà) et
> `StartOnboarding`/`ProvisioningCompleted` (§11, signal de clôture minimal, aucune machine métier).
> `ProvisioningCompleted` ne doit JAMAIS devenir une source d'autorisation — l'accès reste dérivé
> dynamiquement de l'état réel de `HealthFacility`/`Subscription` à chaque appel, jamais d'un flag de
> progression de Saga (déjà implémenté et vérifié, §3 — ne pas régresser dessus).
> `ownerUserId` n'est jamais une propriété persistante de `HealthFacility` ni une relation
> `User.tenantId` — uniquement une donnée de corrélation propagée par les événements de la Saga.
> Le point d'entrée HTTP d'inscription (résidu 1) reste hors périmètre : ne pas l'inventer, la
> chorégraphie doit fonctionner dès que `HealthFacilityCreated` porte un `ownerUserId` valide, quel
> que soit l'appelant. Lire ADR-0001 à ADR-0008 (avec son amendement 1) et les contrats existants
> avant toute modification. Toute décision non couverte par cette ADR (résidus restants) doit être
> remontée, jamais devinée.

## Tests attendus (critère de sortie de l'étape, en complément de `02-roadmap-migration.md`)

- Crash après `CreateHealthFacility`, avant `StartTrialSubscription` → contexte refusé
  (`Subscription` absente), tenant intact, reprise du cycle suivant complète le provisioning.
- Crash après `StartTrialSubscription` → reprise idempotente, aucun doublon de `Subscription`.
- Rejeu de l'étape `GrantMembership` → `MEMBERSHIP_ALREADY_EXISTS` traité comme succès, aucun
  doublon de rôle, aucune exception non gérée remontée au relais Outbox.
- Rôle `ADMIN_ETABLISSEMENT` accordé : jamais visible sur un autre tenant que celui de la Saga en
  cours (test croisé multi-tenant).
- Tenant partiellement provisionné (n'importe quelle étape avant la fin) → `ResolveTenantContext`
  refuse explicitement, jamais un `500` non géré.
- Provisioning complet → accès `ACCESSIBLE`, un seul contexte de session ouvrable.
- `HealthFacility` `SUSPENDED` → refus même avec `Subscription` `TRIALING`/`ACTIVE` valide (priorité
  du statut Facility inchangée).
- `Subscription` absente → refus même avec `HealthFacility` `ACTIVE` (le scénario exact du
  §Contexte, reproductible en test avant le correctif).
- Deux workers Outbox concurrents sur la même étape de Saga → un seul effet appliqué (couvert par
  l'idempotence générique déjà testée en étape 6, à revérifier spécifiquement sur les nouveaux
  consommateurs).
- Non-régression complète de la suite existante (495 tests verts à la fin de la première tranche de
  cette étape), en particulier `Subscription.gracePeriod.test.ts` et les tests RLS/isolation tenant.

**Amendement 1 — cas supplémentaires** :
- `CreateHealthFacilityCommand` sans `ownerUserId`, ou avec un `ownerUserId` ne correspondant à aucun
  `UserAccount` existant → échec explicite, aucune `HealthFacility` créée.
- `ownerUserId` propagé fidèlement de `HealthFacilityCreated` jusqu'à `GrantMembership` — le
  membership admin créé porte exactement l'`ownerUserId` d'origine, jamais un identifiant relu ou
  déduit d'ailleurs.
- Rejeu de `HealthFacilityCreated` (redélivrance Outbox) → `GrantMembership` traité comme succès
  idempotent (`MEMBERSHIP_ALREADY_EXISTS`), aucun doublon de rôle.
- `SeedFacilityConfiguration` exécuté deux fois (rejeu) → configuration finale identique, aucune
  erreur, aucun doublon de paramètres régionaux.
- `ProvisioningCompleted` émis une seule fois par tenant même en cas de rejeu de l'étape
  `StartOnboarding`.
- `TenantModuleBackedAccessChecker` interrogé juste après `ProvisioningCompleted` mais avant que
  cet événement ne soit lui-même consommé par quoi que ce soit → résultat inchangé par rapport à
  avant son émission (preuve que rien ne le consulte, §3/§11).
