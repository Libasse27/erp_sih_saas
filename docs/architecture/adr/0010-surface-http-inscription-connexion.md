# ADR-0010 — Surface HTTP d'inscription, de connexion et de second facteur : premiers endpoints **non authentifiés** créateurs d'état

- **Statut** : **Accepté** (2026-09-02) — validé par le responsable technique, **les cinq
  arbitrages du §12 étant tous clos** le même jour :
  1. **périmètre E2E élargi** — les **trois routes MFA** sont livrées avec les deux routes
     initiales (§7/§7 bis), l'objectif étant un E2E **intégralement HTTP** ; la recommandation
     initiale (couverture partielle, MFA piloté au niveau handler) est **écartée par le
     responsable technique** ;
  2. `409 email_already_registered` **accepté**, mais **conditionné de façon durable** à la
     présence d'une limitation de débit **effective et testée** sur la route (§4/§8) ;
  3. `200 {"status":"mfa_required"}` **validé tel que proposé** (§6) ;
  4. **mécanisme** de limitation de débit **validé et rendu obligatoirement complet** (clé IP
     jamais tenant-scopée, compteur Redis atomique, `Retry-After` grossier désormais **exigé**,
     tests de concurrence et de non-contournement) — les **valeurs numériques** restent
     explicitement **non décidées**, même régime que `SessionDurationTuning.ts` (§8) ;
  5. aller-retour de sélection d'établissement **validé tel que proposé** — **aucune** quatrième
     variante de `SessionContext` n'est créée (§6, cas 4).
  **Amendement 1 (2026-09-02, même jour)** : deux revues de sécurité indépendantes successives de
  l'implémentation ont trouvé trois défauts **BLOQUANT** (rejets de promesse non gérés sur les cinq
  routes, deux courses sur contrainte d'unicité PostgreSQL non gérées, limiteur de débit Redis non
  atomique + `express.json()` monté avant lui) et un défaut d'anti-rejeu TOTP cassant le parcours
  nominal dans la même fenêtre de 30 s — tous corrigés et re-vérifiés. Le responsable technique a
  tranché AC-1 (compteurs anti-rejeu TOTP découplés, risque résiduel borné accepté) et AC-3
  (politique de mot de passe V1 = 8 caractères, définitive) ; AC-2 et AC-G restent des résidus
  explicitement ouverts, non fermés par cet amendement. Voir la section « Amendement 1 » ci-dessous.
- **Date** : 2026-09-02
- **Décideurs** : Architecture (proposition) + responsable technique (validé le 2026-09-02, y
  compris l'élargissement du périmètre aux trois routes MFA ; amendement 1 validé le 2026-09-02)
- **Contexte technique** : modules `identity`, `tenant` (+ `composition-root.ts` et `server.ts`
  pour le câblage HTTP cross-module), Phase 0, étape 12/13 (« Tests d'isolation
  multi-tenant/sécurité »)

---

## Contexte

Le critère de sortie de Phase 0 « **E2E : inscription → paiement → provisioning → connexion →
onboarding**, et les chemins d'échec de paiement avec compensation effective »
([02-roadmap-migration.md](../02-roadmap-migration.md), Phase 0) **ne peut pas s'exécuter en HTTP**
dans l'état du dépôt. Constat vérifié par lecture du code (`src/server.ts`, `composition-root.ts`),
jamais supposé :

1. **Trois routes existent en tout** : `GET /health`, `POST /api/v1/payments/webhook`
   (non authentifiée, HMAC sur corps brut, O-25.5) et `GET /api/v1/audit-entries`
   (ADR-0009 §8, premier et seul endpoint **authentifié**). Il n'existe **aucune route
   d'inscription ni de connexion**.
2. **Le parcours existe intégralement au niveau applicatif** : `CreateUserAccountHandler`,
   `CreateHealthFacilityHandler`, la chorégraphie Outbox complète (ADR-0008, prouvée par
   `test/tenant/integration/provisioningSaga.test.ts`), `AuthenticateUserHandler`,
   `ResolveTenantContextHandler`, `SessionContextIssuer`, `RefreshTokenIssuer`,
   `RefreshSessionHandler` (`refreshTokenRotation.test.ts`), `ServerContextResolver`
   (`mfaSessionGate.test.ts`). **Rien de tout cela n'a de point d'entrée HTTP.**
3. **ADR-0008 §Résidus 1 avait explicitement laissé ce point ouvert** : « Point d'entrée HTTP
   d'inscription (`CreateUserAccount → CreateHealthFacility(ownerUserId)`) — aucune route n'existe
   encore dans le dépôt. Cette ADR fixe le contrat que ce futur point d'entrée doit respecter
   (§9 : synchrone pour ce seul couple, `ownerUserId` jamais accepté tel quel depuis un client)
   mais n'implémente pas la route elle-même. » **La présente ADR ferme ce résidu.**
4. **ADR-0006 §Dette assumée** notait symétriquement : « Aucune couche HTTP pour l'endpoint de
   refresh — comme pour toutes les commandes Identity depuis l'étape 2/13, ce livrable reste au
   niveau applicatif. » Cette ADR ne ferme **que** l'inscription, la connexion et le second
   facteur (§11).
5. **Nature nouvelle des deux premières routes** (`POST /registrations`, `POST /auth/sessions`) :
   ce sont les **premiers endpoints non authentifiés créateurs d'état durable** du dépôt. Les trois
   routes MFA du §7 bis ne sont pas dans ce cas — elles exigent une session `MFA_PENDING` déjà
   émise par le serveur — mais restent des surfaces **pré-authentification**, d'où leur inclusion
   dans la limitation de débit du §8. Le webhook de paiement est non authentifié mais protégé
   par HMAC et ne crée rien qu'un `Payment` déjà initié côté serveur ne référence déjà.
   `POST /registrations` crée, pour un anonyme, un `UserAccount` **et** un tenant complet
   (`HealthFacility` + `Subscription` + `UserTenantMembership` + `FacilitySettings` + entrées
   d'audit), **qu'aucun mécanisme du dépôt ne peut supprimer** : O-03.1 (« aucune suppression de
   données à aucune étape »), ADR-0008 §5 (« jamais qu'elle démonte ce qui a déjà réussi »),
   ADR-0009 B3 (aucune purge d'audit). C'est le fait dominant de cette ADR (§8).

---

## Décision

### 1. Cinq routes, et **exactement** cinq — nommage et emplacement

```
POST /api/v1/registrations                        — inscription (déclenche la Saga de provisioning trial-first)
POST /api/v1/auth/sessions                        — connexion (ouvre un contexte de session)
POST /api/v1/auth/mfa/enrollment                  — StartMfaEnrollment    (§7 bis A)
POST /api/v1/auth/mfa/enrollment/confirmation     — ConfirmMfaEnrollment  (§7 bis B)
POST /api/v1/auth/sessions/mfa-challenge          — VerifyMfaChallenge    (§7 bis C)
```

Les trois derniers chemins sont **repris tels quels** de la version « Proposé » de cette ADR
(§7 initial), sans modification : aucune raison technique n'est apparue à la lecture du code des
handlers de les renommer.

**Style de chemin** : substantif de ressource au pluriel, cohérent avec `/api/v1/audit-entries`
déjà en place. `/auth/register` et `/auth/login` (style verbe) sont écartés pour cette seule
raison de cohérence — aucun argument technique. `mfa-challenge` et `enrollment/confirmation` sont
des **sous-ressources** de la session et de l'enrôlement, pas des verbes déguisés.

**`registrations` n'est pas sous `/auth`** : l'inscription crée un **établissement** (module
`tenant`), pas seulement un compte ; la ranger sous `/auth` masquerait sa nature cross-module.
`/auth/sessions` en revanche est strictement Identity, et laisse la place aux routes de session
restantes sans réouvrir ce nommage : `DELETE /api/v1/auth/sessions/current` (`CloseSession`),
`POST /api/v1/auth/sessions/refresh` (`RefreshSession`) — **aucune de ces deux-là n'est livrée
ici** (§11).

**Emplacement des contrôleurs** — dérivé de la règle §5 de
[01-target-architecture.md](../01-target-architecture.md) (« `composition-root.ts` est le seul
point du code autorisé à connaître deux modules à la fois »), déjà appliquée à
`TenantModuleBackedAccessChecker` et `buildRequireAuthenticatedContext` :

| Route | Modules touchés | Emplacement |
|---|---|---|
| `POST /api/v1/auth/sessions` | `identity` **seul** | `src/modules/identity/presentation/http/SessionController.ts` (méthode `create`) — précédent littéral : `modules/audit/presentation/http/AuditEntryController.ts`, `modules/payment/presentation/http/PaymentWebhookController.ts` |
| `POST /api/v1/auth/sessions/mfa-challenge` | `identity` **seul** | **même** `SessionController` (méthode `verifyMfaChallenge`) — les deux routes produisent une session complète et **partagent le même présentateur** (§7 bis C) |
| `POST /api/v1/auth/mfa/enrollment` | `identity` **seul** | `src/modules/identity/presentation/http/MfaEnrollmentController.ts` (méthode `start`) |
| `POST /api/v1/auth/mfa/enrollment/confirmation` | `identity` **seul** | **même** `MfaEnrollmentController` (méthode `confirm`) |
| `POST /api/v1/registrations` | `identity` **et** `tenant` | **`src/presentation/http/`** (nouveau répertoire de premier niveau, frère de `modules/` et `shared-kernel/`), instancié **uniquement** dans `composition-root.ts` |

**Deux contrôleurs plutôt que quatre** : le regroupement suit la **ressource**, pas la commande —
`SessionController` pour tout ce qui produit ou fait progresser une session, `MfaEnrollmentController`
pour le cycle de vie du facteur. Aucun des deux ne connaît le module `tenant`.

Un `RegistrationController` placé dans `modules/identity/presentation/` devrait importer
`CreateHealthFacilityHandler` (module `tenant`) : ce serait un module qui en connaît un autre.
Le placer hors de `modules/` rend la contrainte structurelle plutôt que disciplinaire. Il reçoit
les **deux handlers** en dépendances de constructeur (jamais les modules entiers — moindre
privilège, même discipline que `TenantModuleBackedAccessChecker`), et est exposé par
`CompositionRoot.presentation`, **espace de nommage qui existe déjà** (`requireAuthenticatedContext`,
`auditEntryController`).

### 2. `POST /api/v1/registrations` — contrat

**Non authentifiée.** Aucun `Authorization` n'est lu, aucun `ServerContext` n'est résolu.

```http
POST /api/v1/registrations
Content-Type: application/json
X-Correlation-Id: <optionnel>
```

```jsonc
{
  "email": "admin@clinique-dakar.sn",   // string, VO Email : trim + minuscules, <= 254, motif simple
  "password": "…",                       // string, >= 8 (plancher CreateUserAccountHandler), <= 512
  "facilityName": "Clinique de Dakar"    // string, trim non vide, <= 200 (VO FacilityName)
}
```

**Schéma zod `.strict()`** (rejet des champs inconnus — anti mass-assignment, même discipline que
`ListAuditEntriesQuerySchema`). Les bornes ci-dessus **dupliquent volontairement** celles des VO
`Email`/`FacilityName`/`CreateUserAccountHandler` : voir §3, c'est un choix, pas un oubli.

**Ne sont acceptés d'aucune manière** (mass-assignment) : `platformRole` (fixé à `'NONE'` en dur
côté serveur — sans quoi un anonyme s'auto-déclarerait `SUPER_ADMIN`), `ownerUserId`, `tenantId`,
`roleCodes`, `permissionCodes`, `planCode`. `.strict()` les rejette en `400`, jamais en silence.

**Séquence serveur**, exactement celle sanctionnée par ADR-0008 §9 (« seul le **couple**
`CreateUserAccount → CreateHealthFacility(ownerUserId)` reste synchrone ; tout ce qui suit
`HealthFacilityCreated` reste intégralement chorégraphié par l'Outbox ») :

1. valider le corps (zod `.strict()`) ;
2. `identity.handlers.createUserAccount.execute({ email, plainPassword, platformRole: 'NONE' })` ;
3. `tenant.handlers.createHealthFacility.execute({ name: facilityName, ownerUserId: <id issu de l'étape 2> })`.

`ownerUserId` **n'est jamais lu depuis la requête** : il est l'identifiant retourné par l'étape 2
dans la **même requête serveur** — c'est la contrainte littérale d'ADR-0008 §9 (« jamais d'un champ
de formulaire transmis en promettant "c'est moi" »). Le contrôleur **n'orchestre rien d'autre** :
aucune attente de la Saga, aucun appel de `StartTrialSubscription`, aucun `GrantMembership`.

**Réponse `202 Accepted`** — jamais `201` : le tenant existe (`HealthFacility` `ACTIVE`) mais
n'est **pas accessible** tant que `StartTrialSubscription` n'a pas été rejoué par l'Outbox
(ADR-0008 §3 : `ACCESSIBLE ⟺ HealthFacility.isActive() ET Subscription existe`). `202` dit
exactement cela : accepté, traitement en cours.

```jsonc
{
  "userAccountId": "3fa85f64-…",
  "tenantId": "9c858901-…",
  "status": "provisioning"    // littéral constant, jamais un état de Saga interrogé
}
```

`status` est une **constante**, pas une lecture d'état : ADR-0008 §3/§11 interdit de faire de
`ProvisioningCompleted` une source d'autorisation ou de progression consultée. Aucun endpoint de
suivi de provisioning n'est ajouté (§11) — le client constate la disponibilité en tentant la
connexion, qui reste la seule source de vérité dynamique.

**Erreurs** (format `{"error":"<code>"}`, §5) :

| Statut | `error` | Cause |
|---|---|---|
| `400` | `invalid_request` | corps malformé, champ inconnu, borne violée, JSON illisible |
| `409` | `email_already_registered` | `CreateUserAccountError.EMAIL_ALREADY_REGISTERED` — voir §4 |
| `429` | `too_many_requests` | limitation de débit (§8) |
| `500` | `internal_error` | défaillance technique, aucun détail exposé |

`CreateHealthFacilityError` : `INVALID_NAME` est **structurellement inatteignable** (zod valide
les mêmes bornes avant l'étape 2 — c'est la raison d'être de la duplication du §3) ;
`INVALID_OWNER_USER_ID`/`OWNER_ACCOUNT_NOT_FOUND` sont **pathologiques** (le compte vient d'être
créé dans la même requête) et se traduisent en `500 internal_error` avec log structuré, jamais en
une erreur métier exposée au client.

### 3. Valider `facilityName` **avant** de créer le compte — la seule protection possible contre le compte orphelin

Deux commandes, deux transactions, **aucune transaction englobante possible** (deux agrégats de
deux contextes bornés — §2 des principes non négociables, et ADR-0008 §4 interdit le second
mécanisme de reprise). Si l'étape 2 réussit et l'étape 3 échoue, il reste un `UserAccount`
**orphelin**, et l'utilisateur **ne peut plus se réinscrire** (`EMAIL_ALREADY_REGISTERED`) :
impasse fonctionnelle.

Aucune compensation par suppression n'est envisageable : O-03.1 l'interdit, ADR-0008 §5 l'a déjà
écarté. La seule mesure réellement efficace est donc de **rendre le seul mode d'échec déterministe
impossible** : `facilityName` est validé par zod **avant** l'étape 2, avec **les bornes exactes du
VO `FacilityName`** (trim non vide, ≤ 200). Le VO reste la source de vérité du domaine ; la
duplication en frontière HTTP est une **garde d'ordonnancement**, à commenter comme telle dans le
schéma zod pour qu'un futur lecteur ne la « factorise » pas.

Reste le cas non déterministe (crash entre les deux commandes, panne PostgreSQL). Il est
**accepté et documenté** (§Dette assumée) : le déblocage est une intervention opérationnelle, même
famille que le dead-letter de provisioning (ADR-0008 §5, résidu 4). Aucune « reprise
d'inscription » (« si l'email existe et que le mot de passe correspond et qu'aucun membership
n'existe, alors continuer ») **n'est inventée ici** : ce serait une règle métier non fournie.

### 4. `409 email_already_registered` — oracle d'énumération **assumé, écrit, et daté**

`AuthenticateUserHandler` applique une anti-énumération stricte et coûteuse (erreur unique
`INVALID_CREDENTIALS`, vérification factice `DUMMY_HASH` à durée comparable) ; ADR-0009 §2.1 va
jusqu'à **ne pas auditer** un échec sur identifiant inconnu pour ne pas stocker l'email tenté.
Répondre `409 email_already_registered` sur une route **non authentifiée** annule cette propriété :
n'importe qui teste l'existence d'un compte.

**Décision retenue : `409 email_already_registered` malgré tout**, pour la V1, avec les motifs
suivants énoncés sans détour :

- L'alternative « répondre `202` de manière indistinguable et notifier par email » exige un flux de
  confirmation par email qui **n'existe pas** (le module `notifications` ne porte que
  `welcome`/`plan-change`, ADR-0007 §1, et l'ajout d'un gabarit + d'un jeton de confirmation est
  une décision produit non fournie). L'implémenter ici reviendrait à inventer un parcours.
- L'alternative « `400 invalid_request` indistinct » produit un formulaire d'inscription qui échoue
  sans raison affichable : impasse UX, et un support qui ne peut pas diagnostiquer.
- Le risque est **borné par la limitation de débit du §8**, qui devient de ce fait une condition de
  cette décision, pas une option.

**Ceci est une dérogation explicite** à la règle anti-énumération appliquée au login. Elle est
tracée en §Dette assumée et **doit être rouverte** à l'arrivée d'un flux de confirmation par email
(résidu 3).

> **Condition de validité, confirmée par le responsable technique le 2026-09-02 (§12, point 2).**
> Cette formulation est **reconduite mot pour mot** et n'est pas une nuance de rédaction :
> **sans le §8, cette décision doit être considérée comme refusée.**
>
> « Le §8 » signifie ici une limitation de débit **effective et testée** sur
> `POST /api/v1/registrations` : middleware réellement monté sur la route, clé IP jamais
> tenant-scopée, `429` réellement produit, et les tests de la section « Tests attendus » (seuil,
> isolation entre IP, concurrence, non-contournement par variation d'un champ du corps) **au
> vert**. Une limitation présente dans le code mais non montée, non testée, ou désactivée par
> configuration en production **rouvre** cette condition : le `409 email_already_registered`
> devrait alors être remplacé par une réponse indistinguable, ce qui exige le flux du résidu 3.
>
> Cette condition est **durable** : elle ne s'éteint pas à la livraison de l'étape 12. Toute
> évolution ultérieure qui retirerait ou neutraliserait la limitation de débit de cette route
> **doit** rouvrir cette ADR, jamais se contenter de supprimer le middleware.

### 5. Format d'erreur : `SimpleError` **réutilisé tel quel**, enum étendue

Le dépôt a **un seul format d'erreur HTTP réellement produit** — vérifié dans
`AuditEntryController.ts`, `buildRequireAuthenticatedContext`, `createErrorHandler` et documenté
comme `SimpleError` dans `docs/api/openapi.yaml` :

```json
{ "error": "<code_snake_case>" }
```

Jamais `ProblemDetails`/RFC 9457 (le schéma existe dans `openapi.yaml` mais est **réservé aux
futurs endpoints CRUD**, son propre commentaire le dit). Ce format est **réutilisé sans
modification**. L'énumération `SimpleError.error` passe de 5 à 10 valeurs, **additivement** :

| Code | Statut | Existant ? | Sémantique |
|---|---|---|---|
| `invalid_request` | 400 | oui | corps/paramètres invalides |
| `unauthenticated` | 401 | oui | **aucune session exploitable présentée** (middleware **ou** routes MFA) |
| `invalid_credentials` | 401 | **nouveau** | **le secret soumis ne vaut rien** : mot de passe au login, code TOTP ou code de récupération sur les routes MFA |
| `forbidden` | 403 | oui | authentifié, contexte refusé |
| `mfa_required` | 403 | oui | session `MFA_PENDING` présentée en `Bearer` sur un endpoint exigeant un contexte — inchangé |
| `email_already_registered` | 409 | **nouveau** | §4 |
| `mfa_enrollment_required` | 409 | **nouveau** | aucun facteur en cours d'enrôlement exploitable — (re)commencer par `POST /auth/mfa/enrollment` (§7 bis B/C) |
| `mfa_enrollment_already_active` | 409 | **nouveau** | facteur déjà `ACTIVE` : seul `ForceMfaReEnrollment` en sort (O-04.5, §7 bis A) |
| `too_many_requests` | 429 | **nouveau** | §8 **ou** verrouillage anti-brute-force du facteur (§7 bis D) |
| `internal_error` | 500 | oui | défaillance technique |

**`invalid_credentials` est réutilisé tel quel sur les routes MFA, jamais dupliqué en un
`invalid_mfa_code`** : le **fait** énoncé est rigoureusement le même (« le secret que vous
soumettez ne vaut rien ») ; seule la **nature** du secret change, et elle est déjà donnée par le
chemin appelé. La distinction utile côté exploitation (mot de passe vs second facteur) est déjà
portée par l'audit — `SESSION_LOGIN_FAILED` d'un côté, `MFA_CHALLENGE_FAILED` /
`MFA_ENROLLMENT_CONFIRMED(FAILURE)` de l'autre (§7 bis) — jamais par le code HTTP.

**Les deux nouveaux codes `mfa_enrollment_*` sont en `409`, pas en `403`** : ce sont des **conflits
d'état** sur l'agrégat `MfaEnrollment` (« l'enrôlement n'est pas dans l'état que cette opération
exige »), jamais des refus d'autorisation. `403` reste strictement réservé au refus d'un contexte
(`forbidden`) et au gate `mfa_required` du middleware.

**`invalid_credentials` est distinct d'`unauthenticated` délibérément** : `unauthenticated` signifie
« le jeton que vous portez ne vaut rien », `invalid_credentials` signifie « le couple que vous
soumettez ne vaut rien ». Les confondre rendrait impossible, côté client comme côté log, de
distinguer une session expirée d'une saisie erronée. Aucun des deux ne distingue jamais « email
inconnu » de « mot de passe faux » — c'est le contrat d'`AuthenticateUserError`, inchangé.

### 6. `POST /api/v1/auth/sessions` — contrat

**Non authentifiée** (elle produit l'authentification). Une seule requête HTTP enchaîne
`AuthenticateUser` (2.4) **puis** `ResolveTenantContext` (2.5).

```jsonc
{
  "email": "…",
  "password": "…",
  "context": { "kind": "TENANT", "tenantId": "9c85…" }   // OPTIONNEL
                // ou { "kind": "PLATFORM" }
}
```

`context` est une **sélection**, jamais une preuve — c'est explicitement le modèle déjà en place
(`ResolveTenantContextCommand.intent` : « Jamais une preuve : le serveur la valide systématiquement
contre les memberships réels avant d'ouvrir un contexte (O-05) »). Le transmettre depuis le client
**n'est donc pas** l'anti-pattern qu'ADR-0008 §9 interdit pour `ownerUserId` : `SessionContextIssuer`
re-résout membership, rôles, permissions et accès tenant côté serveur, et refuse tout ce qui ne
correspond pas.

**Dérivation de l'intention**, déterministe, sans règle métier inventée :

1. `context` fourni → utilisé tel quel comme **sélection** (revalidé serveur) ;
2. absent **et** `isSuperAdmin` → `{ kind: 'PLATFORM' }` ;
3. absent **et** exactement **un** `activeTenantIds` → ce tenant ;
4. absent **et** zéro ou plusieurs → **aucune session n'est ouverte**, réponse
   `context_selection_required` (voir ci-dessous).

Les valeurs des cas 2 et 3 proviennent d'`AuthenticateUserResult` (`isSuperAdmin`,
`activeTenantIds`), **déjà conçu pour cela** (« sert à l'écran de sélection (O-05) »).

**Réponses `200`** — union discriminée par `status`, jamais trois codes HTTP différents pour trois
étapes d'un même protocole qui ont toutes **réussi** :

```jsonc
// a) session complète ouverte
{
  "status": "authenticated",
  "session": {
    "sessionId": "…",            // = le jeton porté ensuite en `Authorization: Bearer`
    "kind": "TENANT",            // | "PLATFORM"
    "tenantId": "9c85…",         // null pour PLATFORM
    "roleCodes": ["ADMIN_ETABLISSEMENT"],
    "permissionCodes": ["membership:administer", "…"],
    "absoluteExpiresAt": "2026-09-02T18:00:00.000Z"
  },
  "refreshToken": "…"            // ADR-0006 §4 : retourné UNE SEULE FOIS, jamais relisible
}

// b) second facteur exigé
{
  "status": "mfa_required",
  "mfa": {
    "pendingSessionId": "…",
    "reason": "CHALLENGE_REQUIRED",   // | "ENROLLMENT_REQUIRED"
    "expiresAt": "2026-09-02T10:05:00.000Z"
  }
}

// c) sélection d'établissement nécessaire (cas 4 ci-dessus)
{ "status": "context_selection_required", "availableTenantIds": ["…", "…"] }
```

- **`permissionCodes` et `roleCodes` sont exposés délibérément** : le critère de sortie de Phase 0
  « le frontend ne contient **aucun** forfait ni permission codé en dur » l'exige — les permissions
  doivent venir du serveur. Ce sont exactement celles déjà résolues par `PermissionResolver` et
  portées par `TenantSessionContext`.
- **Ne sont jamais exposés** : `membershipId`, `userId`, `requiresMfa`, `mfaSatisfiedAt`,
  `sensitivityCategory`, `issuedAt`. Aucun n'est nécessaire au client, et `mfaSatisfiedAt`/
  `sensitivityCategory` sont des éléments de politique interne. DTO explicite, jamais le
  `SessionContext` sérialisé — même discipline qu'`AuditEntryDto`.
- **`absoluteExpiresAt` porte le plafond de la CHAÎNE**, pas la TTL de la session Redis
  (ADR-0006 §5). Le nom est conservé tel quel, sans être renommé en `expiresAt` qui mentirait.
- **`pendingSessionId` est bien un secret retourné au client** : c'est l'entrée obligatoire de
  `StartMfaEnrollment`/`VerifyMfaChallenge`, dont le correctif de sécurité F-2 (ADR-0005) a fait
  la **seule** source d'identité du sujet. Le retourner est le contrat existant, pas une fuite.

**`status: "mfa_required"` en `200` n'est pas en contradiction avec `403 {"error":"mfa_required"}`**
de `requireAuthenticatedContext`. Les deux disent des choses différentes, et la distinction doit
être écrite pour ne pas être « harmonisée » par erreur :

| | Signification |
|---|---|
| `403 {"error":"mfa_required"}` | vous **présentez** une session `MFA_PENDING` sur un endpoint qui exige un contexte : refus |
| `200 {"status":"mfa_required"}` | votre connexion a **progressé** jusqu'à l'étape du second facteur : succès partiel du protocole |

Un `403` ici ne pourrait de toute façon pas transporter `pendingSessionId` sans casser le format
`SimpleError` du §5 — ce qui serait une réinvention de format, précisément ce que cette ADR refuse.

**Erreurs** :

| Statut | `error` | Cause |
|---|---|---|
| `400` | `invalid_request` | corps malformé, champ inconnu, `context.kind` inconnu, `tenantId` non-UUID |
| `401` | `invalid_credentials` | `AuthenticateUserError.INVALID_CREDENTIALS` — **seule et unique** erreur d'authentification |
| `403` | `forbidden` | **toutes** les `ResolveTenantContextError` de refus (voir ci-dessous) |
| `429` | `too_many_requests` | §8 |
| `500` | `internal_error` | défaillance technique |

**`403 forbidden` ne distingue JAMAIS** `NOT_SUPER_ADMIN`, `TENANT_NOT_FOUND`, `TENANT_SUSPENDED`,
`MEMBERSHIP_NOT_FOUND_OR_INACTIVE`. C'est la traduction HTTP directe de la règle déjà appliquée par
`TenantModuleBackedAccessChecker` (ADR-0008 §3 : « un tenant partiellement provisionné ne doit pas
être distingué, du point de vue du client, d'un tenant qui n'existe pas »). Un code
`tenant_suspended` distinct serait un oracle d'existence d'établissement. `INVALID_USER_ID`/
`INVALID_TENANT_ID` sont interceptées par zod en amont (`400`) et pathologiques ensuite (`500`).

**Il n'existe aucun statut de suspension au niveau du `UserAccount`** — vérifié : l'agrégat n'a ni
`status` ni `isActive()`. La suspension se joue au niveau du tenant (`FacilityStatus.SUSPENDED`) ou
du membership (révocation), tous deux couverts par le `403 forbidden` ci-dessus. **Aucun état de
compte n'est inventé ici.**

**Audit** : aucun nouveau type d'événement. `SESSION_LOGIN_SUCCEEDED`, `SESSION_LOGIN_FAILED`
(dédupliqué, compte existant uniquement), `SESSION_CONTEXT_OPENED`, `SESSION_CONTEXT_DENIED` sont
déjà écrits par les handlers (ADR-0009 §2.1) — la route n'ajoute, ne déplace et ne duplique rien.

### 7. Pourquoi la connexion HTTP ne suffit pas — l'exigence qui impose les trois routes MFA

Constat vérifié dans le code, **pas une hypothèse** :

- `ADMIN_ETABLISSEMENT` porte `membership:administer`, `role:administer`,
  `tenant-config:administer`, `mfa:reset`, `audit:read` (`SystemRoleCatalog.ts`) ;
- `MfaPolicy.TENANT_ADMIN_RESOURCES` contient `membership`, `role`, `tenant-config`, `mfa`,
  `audit` ⇒ `requiresMfaForMembership(...) === true` ;
- `SessionContextIssuer.buildSession` émet alors une session `MFA_PENDING` avec
  `reason: 'ENROLLMENT_REQUIRED'` (aucun enrôlement actif sur un compte neuf).

**Le propriétaire fraîchement provisionné par la Saga ne peut donc structurellement PAS obtenir de
session complète à sa première connexion.** La réponse HTTP correcte et attendue est
`200 {"status":"mfa_required","mfa":{"reason":"ENROLLMENT_REQUIRED",…}}`.

Conséquence directe sur le critère de sortie : un E2E **intégralement HTTP** exige trois routes de
plus (`POST /api/v1/auth/mfa/enrollment`, `POST /api/v1/auth/mfa/enrollment/confirmation`,
`POST /api/v1/auth/sessions/mfa-challenge` — handlers `StartMfaEnrollment`,
`ConfirmMfaEnrollment`, `VerifyMfaChallenge`, tous **déjà existants et testés**).

**Décision de périmètre, tranchée par le responsable technique le 2026-09-02 (§12, point 1)** :
ces trois routes **sont livrées** avec les deux premières. La recommandation initiale de cette ADR
(couverture partielle, MFA piloté au niveau handler comme `provisioningSaga.test.ts` pilote les
consommateurs Outbox) est **écartée**. L'objectif exigé est un parcours **intégralement HTTP** :

```
POST /registrations  →  POST /auth/sessions  →  200 mfa_required/ENROLLMENT_REQUIRED
  →  POST /auth/mfa/enrollment               →  200 provisioningUri
  →  POST /auth/mfa/enrollment/confirmation  →  200 recoveryCodes
  →  POST /auth/sessions  (re-soumission des identifiants, voir §7 bis E)
                                             →  200 mfa_required/CHALLENGE_REQUIRED
  →  POST /auth/sessions/mfa-challenge       →  200 authenticated (+ refreshToken)
  →  GET  /api/v1/audit-entries  (Authorization: Bearer <sessionId>)  →  accès tenant réel
```

Le §7 bis ci-dessous spécifie le contrat des trois routes MFA **au même niveau de détail** que le
§2 (inscription) et le §6 (connexion). Il ne repose sur aucune supposition : chaque champ de
requête et de réponse est repris **littéralement** des signatures
`StartMfaEnrollmentCommand`/`Result`, `ConfirmMfaEnrollmentCommand`/`Result`,
`VerifyMfaChallengeCommand`/`Result` et des unions d'erreurs déclarées par ces trois handlers.

### 7 bis. Les trois routes MFA — contrat

**Aucun handler n'est écrit, modifié ni étendu.** Les trois contrôleurs **valident, délèguent,
présentent**, rien d'autre — même discipline qu'au §2/§6.

#### Transport de l'identité du sujet : `Authorization: Bearer <pendingSessionId>`

Les trois commandes prennent en entrée **le seul identifiant de la session `MFA_PENDING`**
(`StartMfaEnrollmentCommand.sessionId`, `ConfirmMfaEnrollmentCommand.sessionId`,
`VerifyMfaChallengeCommand.pendingSessionId`). Le correctif de sécurité **F-2** (ADR-0005) a
supprimé `userAccountId` de ces commandes précisément pour que **la session soit la seule source
de l'identité du sujet** — un champ d'identité choisi par l'appelant permettait d'obtenir le
`provisioningUri` (secret TOTP en clair) ou les codes de récupération d'un compte tiers.

**Décision** : ce `pendingSessionId` est transporté en `Authorization: Bearer <pendingSessionId>`,
**jamais dans le corps JSON**. Trois raisons, dans cet ordre :

1. **Cohérence** : c'est déjà le transport de session du dépôt (ADR-0009 §8.3), et
   `pendingSessionId` est déjà décrit au §6 comme « un secret retourné au client ».
2. **Anti mass-assignment structurel** : si le corps ne porte **aucun** identifiant, aucun
   `userAccountId` ne peut être glissé dedans. Le schéma zod `.strict()` rejette de toute façon
   tout champ inconnu, mais le transport en en-tête rend la faute F-2 **impossible à réintroduire
   par ajout de champ**, pas seulement interdite.
3. Un en-tête d'autorisation n'est jamais journalisé par le logger structuré existant
   (`{ event, error }` uniquement), contrairement à un corps qu'un futur middleware de trace
   pourrait vouloir capturer (§10).

**Ces trois routes ne sont PAS montées derrière `requireAuthenticatedContext`** — c'est structurel,
pas un oubli : ce middleware appelle `ServerContextResolver.resolve()`, qui répond
`MFA_REQUIRED → 403 {"error":"mfa_required"}` pour **toute** session `MFA_PENDING`
(`mfaSessionGate.test.ts`). Le monter ici rendrait les trois routes **inaccessibles par
construction**.

Le contrôleur se limite donc à **extraire une chaîne opaque** de l'en-tête (fonction pure
`readBearerToken(req): string | null`, aucun accès `SessionStore`, aucun appel à
`ServerContextResolver`) et à la passer au handler. **Ce n'est pas un second chemin de résolution
de contexte** (ADR-0009 §8.2) : le contrôleur ne résout rien, ne lit aucun rôle, ne construit aucun
principal ; le handler reste le **seul** validateur de la session, comme l'exige F-2.

`X-Correlation-Id` est lu et passé dans `command.correlationId` — les trois commandes MFA le
portent réellement (contrairement à `AuthenticateUserCommand`/`ResolveTenantContextCommand`, voir
§Dette assumée) : sur ces trois routes, le `correlationId` **atteint donc les entrées d'audit**.

#### A. `POST /api/v1/auth/mfa/enrollment` — `StartMfaEnrollment`

```http
POST /api/v1/auth/mfa/enrollment
Authorization: Bearer <pendingSessionId>
X-Correlation-Id: <optionnel>
```

**Aucun corps de requête.** La commande n'a **aucun** champ hors `sessionId`/`correlationId` :
le schéma est `z.object({}).strict()` appliqué à `req.body ?? {}` — tout corps non vide est un
`400 invalid_request`. Ce n'est pas du purisme : c'est la garantie explicite qu'aucun
`userAccountId` ne peut jamais être accepté sur cette route (F-2).

**Réponse `200`** — jamais `201` : la ressource créée n'est **pas adressable** (aucun
`GET /auth/mfa/enrollment` n'existe, et §11 n'en crée pas) et le facteur n'est **pas actif** tant
que `ConfirmMfaEnrollment` n'a pas réussi. `201` promettrait les deux.

```jsonc
{
  "enrollmentId": "…",                        // StartMfaEnrollmentResult.enrollmentId
  "provisioningUri": "otpauth://totp/…"       // StartMfaEnrollmentResult.provisioningUri
}
```

> **`provisioningUri` contient le secret TOTP en clair** (base32, dans l'URI `otpauth://`). C'est
> le contrat existant — il est rendu en QR code côté client et n'est jamais persisté en clair.
> Il impose deux règles de frontière, à traiter comme le §10 : réponse servie avec
> **`Cache-Control: no-store`**, et **corps de réponse jamais journalisé**, en succès comme en
> échec.

| Statut | `error` | `StartMfaEnrollmentError` / cause |
|---|---|---|
| `400` | `invalid_request` | corps non vide, champ inconnu |
| `401` | `unauthenticated` | `Authorization` absent/malformé ; `SESSION_NOT_FOUND` ; `SESSION_NOT_PENDING_ENROLLMENT` ; `ACCOUNT_NOT_FOUND` |
| `409` | `mfa_enrollment_already_active` | `ENROLLMENT_ALREADY_ACTIVE_AND_NOT_REPLACEABLE` |
| `429` | `too_many_requests` | §8 |
| `500` | `internal_error` | exception (`userId` de session corrompu — le handler lève, `createErrorHandler` répond) |

**`SESSION_NOT_FOUND` et `SESSION_NOT_PENDING_ENROLLMENT` produisent la même réponse, octet pour
octet.** Les distinguer transformerait la route en **oracle d'état de jeton** : « ce
`pendingSessionId` existe mais n'est pas au bon stade » est une information qu'un porteur de jeton
volé ne doit jamais obtenir. Même discipline que le `403 forbidden` indistinct du §6.

**`ACCOUNT_NOT_FOUND` est traité comme `401`, pas comme `500`** : il signifie qu'une session
référence un `UserAccount` inexistant — structurellement impossible sous O-03.1 (« aucune
suppression de données »). La session est donc définitivement inexploitable et un réessai est
inutile, ce qu'un `500` suggérerait à tort. Le handler écrit déjà l'entrée d'audit
`MFA_ENROLLMENT_STARTED(FAILURE)` ; le contrôleur ajoute un log structuré de niveau `error`,
**sans** le corps ni l'en-tête.

#### B. `POST /api/v1/auth/mfa/enrollment/confirmation` — `ConfirmMfaEnrollment`

```http
POST /api/v1/auth/mfa/enrollment/confirmation
Authorization: Bearer <pendingSessionId>
Content-Type: application/json
```

```jsonc
{ "totpCode": "123456" }   // ConfirmMfaEnrollmentCommand.totpCode
```

Schéma zod `.strict()`, `totpCode: z.string().min(1).max(32)`. **Cette borne est un simple plafond
de taille de charge utile, jamais une validation de format.** Contrairement à `facilityName` (§3,
duplication délibérée servant de garde d'ordonnancement), il ne faut **pas** répliquer ici les
6 chiffres de `TOTP_DIGITS` : ce paramètre appartient à `Rfc6238TotpService` (infrastructure), le
port `TotpService` ne le déclare pas, et une regex HTTP plus stricte casserait silencieusement le
jour où ces paramètres changent. **La validité du code est décidée exclusivement par
`TotpService.verify()`.**

**Réponse `200`** :

```jsonc
{
  "recoveryCodes": ["ABCDE-FGHJK-MNPQR-STVWX", "…"]   // ConfirmMfaEnrollmentResult.recoveryCodes
}
```

> **Exposés une seule fois** (ADR-0005 §3), jamais relisibles : aucune route ne les redonne,
> `RegenerateMfaRecoveryCodes` n'est pas livrée (§11). Mêmes deux règles qu'en A :
> `Cache-Control: no-store`, **corps de réponse jamais journalisé**.

| Statut | `error` | `ConfirmMfaEnrollmentError` / cause |
|---|---|---|
| `400` | `invalid_request` | corps malformé, champ inconnu, `totpCode` absent ou hors borne |
| `401` | `unauthenticated` | `Authorization` absent/malformé ; `SESSION_NOT_FOUND` ; `SESSION_NOT_PENDING_ENROLLMENT` |
| `401` | `invalid_credentials` | `INVALID_CODE` |
| `409` | `mfa_enrollment_required` | `ENROLLMENT_NOT_FOUND`, `NO_PENDING_FACTOR` — (re)commencer par la route A |
| `429` | `too_many_requests` | `TOO_MANY_ATTEMPTS` (verrou du facteur, §7 bis D) **ou** §8 |
| `500` | `internal_error` | exception |

#### C. `POST /api/v1/auth/sessions/mfa-challenge` — `VerifyMfaChallenge`

```http
POST /api/v1/auth/sessions/mfa-challenge
Authorization: Bearer <pendingSessionId>
Content-Type: application/json
```

```jsonc
{ "factor": { "kind": "TOTP",          "code": "123456" } }
// ou
{ "factor": { "kind": "RECOVERY_CODE", "code": "ABCDE-FGHJK-MNPQR-STVWX" } }
```

Union discriminée zod sur `factor.kind`, **chaque variante en `.strict()`**, reprise littérale de
`MfaChallengeFactorInput`. `code` : `z.string().min(1).max(64)` — **plafond de taille uniquement**.
La normalisation d'un code de récupération (majuscules, suppression des tirets et espaces) est
faite par `HmacRecoveryCodeHasher`, **jamais dans la couche HTTP** : la dupliquer créerait une
seconde définition de « code normalisé » divergeant du jour où le format d'affichage change.
Un `factor.kind` inconnu est un `400 invalid_request`, jamais un échec de vérification.

**Réponse `200`** — **exactement le même corps** que la variante (a) du §6, produit par **le même
présentateur** :

```jsonc
{
  "status": "authenticated",
  "session": { "sessionId": "…", "kind": "TENANT", "tenantId": "…", "roleCodes": [...],
               "permissionCodes": [...], "absoluteExpiresAt": "…" },
  "refreshToken": "…"        // VerifyMfaChallengeResult.refreshToken — peut être `null`
}
```

Un client n'a donc **qu'un seul type de réponse de session à analyser**, quelle que soit la route
qui l'a produite. Les mêmes champs restent **jamais exposés** : `membershipId`, `userId`,
`requiresMfa`, `mfaSatisfiedAt`, `sensitivityCategory`, `issuedAt` (§6). `refreshToken` est
`string | null` dans le contrat du handler : il est rendu tel quel, jamais remplacé par une chaîne
vide.

`VerifyMfaChallengeResult.session` est typé `SessionContext`, union qui inclut formellement
`MFA_PENDING` — état que `issueAfterChallenge()` ne peut pas produire (il passe un
`mfaSatisfiedAt` non nul à `buildSession`). Si le présentateur rencontre malgré tout un
`kind === 'MFA_PENDING'`, il répond `500 internal_error` : **jamais** un corps partiel, jamais un
`status: "mfa_required"` fabriqué ici.

| Statut | `error` | `VerifyMfaChallengeError` / cause |
|---|---|---|
| `400` | `invalid_request` | corps malformé, `factor.kind` inconnu, champ inconnu |
| `401` | `unauthenticated` | `Authorization` absent/malformé ; `SESSION_NOT_FOUND` ; `SESSION_NOT_PENDING_MFA` |
| `401` | `invalid_credentials` | `INVALID_CODE` (TOTP **et** code de récupération, indistinctement) |
| `409` | `mfa_enrollment_required` | `ENROLLMENT_REQUIRED` — session au stade enrôlement, ou aucun facteur `ACTIVE` |
| `403` | `forbidden` | `CONTEXT_NO_LONGER_AVAILABLE` — même code indistinct qu'au §6, pour la même raison |
| `429` | `too_many_requests` | `TOO_MANY_ATTEMPTS` (verrou du facteur, §7 bis D) **ou** §8 |
| `500` | `internal_error` | exception |

`CONTEXT_NO_LONGER_AVAILABLE` → `403 forbidden` : le handler a **déjà** agrégé
`TENANT_NOT_FOUND`/`TENANT_SUSPENDED`/`MEMBERSHIP_NOT_FOUND_OR_INACTIVE` sous ce seul code
(`PostChallengeIssuanceError`) ; la couche HTTP ne fait que reconduire une indistinction déjà
décidée dans le domaine — elle n'en invente aucune.

#### D. `429` de deux origines distinctes, un seul code

`TOO_MANY_ATTEMPTS` (verrouillage du facteur : `MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS` échecs
consécutifs → `MFA_LOCKOUT_DURATION_MS`, **par compte**) et le rejet du limiteur de débit (§8,
**par IP**) produisent le **même** corps `{"error":"too_many_requests"}` — aucun onzième code
n'est créé pour les distinguer. Elles restent néanmoins distinguables par la valeur de
`Retry-After` (§8), ce qui est **assumé** : atteindre le verrou de compte suppose de détenir déjà
une session `MFA_PENDING` valide **pour ce compte précis**, donc aucune information n'est révélée
sur un compte tiers.

Le verrou du facteur **n'est ni dupliqué, ni déplacé, ni reparamétré** par la couche HTTP : il
reste entièrement dans l'agrégat `MfaEnrollment`, avec le verrou de ligne `FOR UPDATE` (correctif
F-3) qui sérialise déjà les tentatives concurrentes sur un même compte. Le limiteur du §8 est une
protection **complémentaire** au niveau transport, jamais un remplacement.

#### E. Après la confirmation d'enrôlement, il faut **re-soumettre ses identifiants** — comportement vérifié, non contourné

Constat lu dans le code, à écrire pour qu'aucun agent ne « corrige » un comportement voulu :

- `ConfirmMfaEnrollment` ne retourne **que** `recoveryCodes` — il **n'émet aucune session** et ne
  modifie pas la session `MFA_PENDING` en cours, qui reste `reason: 'ENROLLMENT_REQUIRED'` ;
- `VerifyMfaChallengeHandler` refuse explicitement toute session `MFA_PENDING` dont
  `reason === 'ENROLLMENT_REQUIRED'` (→ `ENROLLMENT_REQUIRED`) — **le `pendingSessionId` utilisé
  pour enrôler n'est donc jamais utilisable pour le challenge** ;
- `SessionContextIssuer.buildSession` dérive `reason` de l'état réel de l'enrôlement : une fois le
  facteur `ACTIVE`, une **nouvelle** authentification produit `CHALLENGE_REQUIRED`.

**Décision : ce comportement est conservé tel quel.** Le parcours comporte donc un
`POST /api/v1/auth/sessions` supplémentaire entre la confirmation et le challenge. C'est le même
compromis que celui validé au §12 point 5 pour la sélection d'établissement : un aller-retour
d'identifiants plutôt qu'une nouvelle variante d'état de session.

**Interdiction explicite à l'implémentation** : ne **pas** faire émettre une session par
`ConfirmMfaEnrollment`, ne **pas** assouplir le refus `ENROLLMENT_REQUIRED` de
`VerifyMfaChallenge`, ne **pas** muter la session en attente depuis le contrôleur pour passer son
`reason` à `CHALLENGE_REQUIRED`. Chacune de ces « simplifications » ferait émettre une session
complète **sans qu'aucun code TOTP n'ait jamais été vérifié contre le facteur activé** — c'est-à-dire
un contournement du second facteur. Le résidu 8 trace le sujet ergonomique ; il ne s'ouvre pas ici.

La session d'enrôlement n'est pas supprimée par la confirmation (aucun handler ne le fait) : elle
expire seule au bout de `MFA_PENDING_SESSION_WINDOW_SECONDS`. Ce n'est pas une fuite — elle reste
refusée par `ServerContextResolver` (403 `mfa_required`), et un second appel à la route A avec
elle échoue désormais en `409 mfa_enrollment_already_active`.

### 8. Limitation de débit : **condition de livraison**, pas une option

ADR-0009 §8.4 refusait d'ajouter une limitation de débit « sur cette seule route », au motif
qu'elle « produirait une politique locale divergente », et laissait la dette de transport
d'ADR-0005 ouverte. **Cet argument ne tient plus** : les cinq routes de cette ADR sont des surfaces
pré-authentification, deux d'entre elles sont totalement anonymes, et l'une crée un tenant complet
**indestructible** (§Contexte 5). Sans
limitation, `POST /api/v1/registrations` est un vecteur de saturation permanente de la base — pire
que celui qu'ADR-0009 §2.1 a explicitement refusé d'ouvrir sur l'audit.

**Décision** : un middleware de limitation **partagé**, appliqué aux **cinq** routes de cette ADR,
jamais une politique par route. Le **mécanisme** ci-dessous est validé par le responsable technique
(§12, point 4) et doit être livré **complet et testé** ; seules les **valeurs numériques** restent
non décidées.

- **Périmètre** : les cinq routes du §1. Les trois routes MFA y sont incluses bien qu'elles portent
  un `Bearer` : ce jeton est une session `MFA_PENDING`, c'est-à-dire une surface
  **pré-authentification** joignable par n'importe quel pair réseau. Les en laisser dehors
  laisserait `POST /auth/sessions/mfa-challenge` sondable sans borne de transport.
  `GET /api/v1/audit-entries` reste **non limitée** (ADR-0009 §8.4 inchangé pour elle).
- **Mécanisme** : compteur Redis à fenêtre fixe, clé namespacée `sih:rate-limit:<route>:<clé>`.
  Aucune dépendance npm nouvelle : `ioredis` est déjà là. La séquence retenue est
  **`SET <clé> 0 EX <fenêtre> NX` puis `INCR <clé>`** — elle réutilise **littéralement** la
  primitive atomique déjà éprouvée dans le dépôt par `RedisMfaBypassAttemptGuard` (`SET NX EX`),
  jamais un second mécanisme inventé, et surtout **aucune clé ne peut jamais exister sans TTL**.
  C'est la raison de ne pas retenir le `INCR` puis `EXPIRE` de la version « Proposé » : une panne
  entre les deux commandes y laisse une clé sans expiration, c'est-à-dire une **IP bloquée
  définitivement** — un déni de service permanent causé par la protection elle-même. Si une
  variante est préférée à l'implémentation, elle doit offrir la même garantie et le prouver par
  test.
- **Clé : l'adresse IP de l'appelant, et rien d'autre.** Elle n'inclut **jamais** `tenantId`,
  jamais l'email, jamais `facilityName`, jamais un champ du corps de requête. Raison écrite noir
  sur blanc : ces routes sont **anonymes et pré-tenant** — au moment où le limiteur s'exécute,
  aucun tenant n'est authentifié, et le seul `tenantId` observable est celui que le client a
  lui-même écrit dans `context.tenantId` (§6), c'est-à-dire une valeur qu'un attaquant contrôle
  intégralement. Toute clé incluant une donnée du corps rendrait la limite **triviale à
  contourner** : il suffirait de faire varier ce champ à chaque requête pour repartir d'un
  compteur à zéro. « Changer de tenant » ne remet donc jamais aucun compteur à zéro, par
  construction et non par vigilance.
- **L'IP n'est pas une donnée d'audit** — ADR-0009 §3 interdit explicitement toute IP dans
  `AuditEntry`. Elle vit **exclusivement** en Redis, avec TTL, et n'est **jamais** journalisée ni
  persistée en base.
- **Port** dans `shared-kernel` (`RateLimiter`), implémentation Redis dans
  `shared-kernel/infrastructure/`, middleware construit dans `composition-root.ts` — un seul point
  de câblage.
- **Réponse** : `429 {"error":"too_many_requests"}` **avec** en-tête `Retry-After` — voir la règle
  ci-dessous, qui remplace le « sans en-tête `Retry-After` détaillé » de la version « Proposé ».
- **Aucune entrée d'audit n'est écrite** sur un rejet `429` : point d'entrée non authentifié,
  aucune purge disponible — raisonnement **identique, mot pour mot**, à ADR-0009 §2.1 et à
  l'alternative écartée n° 9 de cette même ADR. Logs structurés uniquement.
- **Valeurs numériques** : `REGISTRATION_RATE_LIMIT_*`, `LOGIN_RATE_LIMIT_*` et
  `MFA_ROUTES_RATE_LIMIT_*` dans un fichier de réglage dédié, **explicitement marquées non
  définitives**, même régime que `SessionDurationTuning.ts` (ADR-0006 §3). **Aucune valeur n'est
  décidée par cette ADR** — le responsable technique a tranché le **mécanisme**, pas les nombres
  (§12, point 4, résidu 4). Ne jamais présenter ces constantes comme une politique de production
  tant que ce point n'est pas clos, et **aucun littéral numérique ailleurs dans le code** :
  ni dans le middleware, ni dans `composition-root.ts`, ni dans `server.ts`.

**Règle `Retry-After` — la durée nominale complète, jamais le temps restant**

`Retry-After` porte **toujours** la durée **nominale** de la fenêtre concernée, exprimée en
**secondes entières** (`delta-seconds`), **constante** pour une route donnée — jamais le TTL
résiduel de la clé Redis, jamais une date HTTP.

Compromis, assumé et écrit :

- **Ce qui est révélé** : la longueur de la fenêtre. Ce n'est pas un secret — un attaquant la
  mesure empiriquement en quelques requêtes, quoi qu'on fasse. La cacher serait illusoire.
- **Ce qui reste caché** : l'**état du compteur** et l'**instant de réinitialisation**. C'est
  précisément ce qu'un `Retry-After` égal au TTL résiduel divulguerait, en permettant de cadencer
  les requêtes au plus juste et d'inférer à quel moment de la fenêtre on se trouve. Une date HTTP
  révélerait en plus l'horloge du serveur.
- **Coût pour l'utilisateur légitime** : il peut attendre plus longtemps que strictement
  nécessaire, au maximum une fenêtre complète. Contrepartie : la valeur annoncée est **toujours
  supérieure ou égale** au temps d'attente réel, donc un client qui la respecte ne reçoit jamais
  un second `429`.
- **Propriété testable qui en découle** : deux rejets `429` survenant à des instants différents
  d'une **même** fenêtre portent une valeur de `Retry-After` **strictement identique**. Un test qui
  observe deux valeurs différentes prouve une fuite du temps résiduel.

La **même règle** s'applique au `429` d'origine domaine (§7 bis D) : `Retry-After` y vaut
`MFA_LOCKOUT_DURATION_MS` converti en secondes, constante elle aussi — jamais le reliquat du
verrou, qui révélerait l'instant où il a été posé.

### 9. Câblage dans `server.ts` — invariants d'ordre à ne pas casser

```ts
app.post('/api/v1/payments/webhook', express.raw(…), …);   // INCHANGÉ, avant express.json()
app.use(express.json({ limit: '1mb' }));
app.get('/health', …);                                      // INCHANGÉ

app.post('/api/v1/registrations', root.presentation.rateLimitRegistrations, root.presentation.registrationController.handle);
app.post('/api/v1/auth/sessions', root.presentation.rateLimitLogin,         root.presentation.sessionController.create);

// §7 bis — AUCUNE de ces trois routes ne porte `requireAuthenticatedContext` (il refuserait
// structurellement toute session MFA_PENDING en 403 `mfa_required`).
app.post('/api/v1/auth/mfa/enrollment',              root.presentation.rateLimitMfa, root.presentation.mfaEnrollmentController.start);
app.post('/api/v1/auth/mfa/enrollment/confirmation', root.presentation.rateLimitMfa, root.presentation.mfaEnrollmentController.confirm);
app.post('/api/v1/auth/sessions/mfa-challenge',      root.presentation.rateLimitMfa, root.presentation.sessionController.verifyMfaChallenge);

app.get('/api/v1/audit-entries', root.presentation.requireAuthenticatedContext, …);  // INCHANGÉ
app.use(createErrorHandler(root.logger));                   // INCHANGÉ, toujours en dernier
```

Quatre invariants explicites : le webhook reste monté **avant** `express.json()` (signature HMAC
sur corps brut) ; les **cinq** nouvelles routes sont montées **après** `express.json()` et **sans**
`requireAuthenticatedContext` ; le limiteur de débit est **le premier** middleware de chaque route,
avant toute désérialisation applicative et avant tout accès Redis/PostgreSQL du contrôleur (sinon
la protection paierait le coût qu'elle est censée éviter) ; `createErrorHandler` reste le dernier
middleware (le `400` sur JSON illisible est déjà couvert par lui — les contrôleurs n'ont pas à le
traiter).

### 10. Requêtes et réponses portant un secret : cinq règles non négociables

Les cinq routes transportent au moins un secret, dans un sens ou dans l'autre : mot de passe,
`pendingSessionId`, `sessionId`, `refreshToken`, code TOTP, code de récupération, et le
`provisioningUri` qui **contient le secret TOTP en clair** (§7 bis A).

1. **Jamais de journalisation du corps de requête** sur ces cinq routes, ni en succès, ni en échec,
   ni dans `createErrorHandler`. Le logger structuré existant ne journalise déjà que
   `{ event, error }` — cette propriété doit être **préservée** et couverte par un test.
2. **Jamais de journalisation du corps de réponse** — règle ajoutée avec les routes MFA : les
   réponses de `POST /auth/mfa/enrollment` (`provisioningUri`), de
   `POST /auth/mfa/enrollment/confirmation` (`recoveryCodes`) et des deux routes émettant une
   session (`sessionId`, `refreshToken`) sont des secrets sortants.
3. **Jamais d'en-tête `Authorization` journalisé ni audité** : sur les trois routes MFA, il porte
   le `pendingSessionId` en clair. `AuditEntry` ne stocke déjà qu'une **référence dérivée non
   réversible** du `sessionId` (`sessionRef`, correctif ADR-0009 §3.1) — cette propriété ne doit
   pas être contournée depuis la couche HTTP.
4. **Jamais d'email, de mot de passe, de code TOTP ni de code de récupération dans une entrée
   d'audit** — déjà garanti par les handlers (ADR-0009 §2.1 : l'email tenté n'est jamais stocké ;
   les handlers MFA n'écrivent jamais le code soumis) ; les contrôleurs ne doivent rien ajouter.
5. **Jamais de secret en paramètre d'URL** (`GET`/query string) : d'où `POST` avec corps JSON — ou
   en-tête `Authorization` — pour les cinq routes, jamais `GET`. Corollaire : toute réponse portant
   un secret est servie avec **`Cache-Control: no-store`**.

### 11. Ce que cette ADR ne fait pas

- **Aucune route de déconnexion, de rafraîchissement, d'administration MFA, de changement
  d'établissement** — `CloseSession`, `RefreshSession`, `ForceMfaReEnrollment`,
  `RegenerateMfaRecoveryCodes`, `GrantMembership`/`RevokeMembership` restent **sans couche HTTP**.
  La dette d'ADR-0006 reste ouverte pour tout ce qui n'est pas l'inscription, la connexion et le
  second facteur.
  `StartMfaEnrollment`, `ConfirmMfaEnrollment` et `VerifyMfaChallenge` **ne figurent plus dans
  cette liste** : leurs trois routes sont livrées par cette ADR (§7 bis), conformément au §12
  point 1 tranché le 2026-09-02.
- **Aucune route de consultation d'enrôlement** (`GET /auth/mfa/enrollment`) : ni le
  `provisioningUri` ni les `recoveryCodes` ne sont relisibles, par construction (ADR-0005 §3 :
  exposition unique). Un endpoint de relecture les rendrait rejouables.
- **Aucun endpoint de suivi de provisioning** (§2).
- **Aucun cookie, aucune stratégie CSRF** : le transport `Authorization: Bearer` d'ADR-0009 §8.3
  est reconduit tel quel, et son résidu 5 (transport définitif à l'arrivée d'`apps/web`) reste
  ouvert **et concerne désormais aussi le `refreshToken`**, retourné ici dans un corps JSON.
- **Aucun nouveau type d'`AuditEventType`, aucune migration**. En particulier, la création d'un
  `UserAccount` en libre-service **n'est pas auditée en tant que telle** : elle l'est indirectement
  par `PROVISIONING_FACILITY_CREATED`, qui porte `subjectUserId = ownerUserId`. Le seul cas non
  tracé est un compte créé dont la création d'établissement échoue ensuite (§3). Résidu 2.
- **Aucune interface graphique** (B2 d'ADR-0009 reste en vigueur).

### 12. Points soumis à validation — **tous clos le 2026-09-02**

Aucun de ces cinq points ne reste ouvert. Ils sont conservés ici avec leur arbitrage, pour que la
décision reste lisible sans avoir à reconstituer l'historique du document.

| # | Point | Arbitrage du responsable technique (2026-09-02) |
|---|---|---|
| 1 | **Périmètre E2E (§7)** — couverture HTTP partielle (arrêt à `mfa_required`, suite pilotée au niveau handler) ou livraison des trois routes MFA ? | **Les trois routes MFA sont livrées.** La recommandation initiale (couverture partielle) est **écartée**. Objectif : un E2E **intégralement HTTP** `register → mfa_required → enroll → confirm → challenge → session → accès tenant`. Contrat complet au §7 bis. |
| 2 | **`409 email_already_registered` (§4)** — oracle d'énumération assumé | **Accepté**, mais **conditionné de façon durable** à une limitation de débit **effective et testée** sur la route. La formulation « sans le §8, cette décision doit être considérée comme **refusée** » est **reconduite mot pour mot** et encadrée au §4. |
| 3 | **`200 {"status":"mfa_required"}` vs `403` (§6)** | **Validé tel que proposé** — union discriminée en `200`, `403 {"error":"mfa_required"}` conservé pour le seul gate du middleware. |
| 4 | **Limitation de débit (§8)** | **Mécanisme validé et rendu obligatoirement complet** : clé IP **jamais** tenant-scopée, compteur Redis sans clé possible sans TTL, `429`, **`Retry-After` désormais exigé** (durée nominale, jamais le temps restant), tests de concurrence et de non-contournement, zéro littéral numérique hors fichier de réglage. **Les valeurs numériques restent non décidées** (résidu 4) — le mécanisme est tranché, pas les nombres. |
| 5 | **Aller-retour de sélection d'établissement (§6, cas 4)** | **Validé tel que proposé** : re-soumission des identifiants avec le choix. **Aucune** quatrième variante de `SessionContext` (`CONTEXT_SELECTION_PENDING`) n'est créée — ce serait une modification du domaine de la taille d'ADR-0005 §4. Le §7 bis E applique le **même** compromis au retour d'enrôlement MFA. |

---

## Amendement 1 (2026-09-02) — clôture AC-1/AC-3, correctifs de sécurité BLOQUANT-1/2/3, résidus AC-2/AC-G ouverts

**Contexte de cet amendement** : l'implémentation de cette ADR (étape 12/13) a fait l'objet de deux
revues de sécurité indépendantes successives. La première a trouvé trois défauts **BLOQUANT** dans
le code livré et un défaut d'anti-rejeu TOTP (AC-1 ci-dessous). Tous ont été corrigés ; une seconde
revue indépendante, portant spécifiquement sur ces correctifs, a confirmé leur fermeture et trouvé
des gaps additionnels (AC-A/B/C ci-dessous), désormais également corrigés.

### AC-1 — Anti-rejeu TOTP : confirmation d'enrôlement et challenge de connexion découplés — **ACCEPTÉ avec risque résiduel documenté**

**Constat** : l'agrégat `MfaEnrollment` ne portait qu'un seul compteur anti-rejeu
(`lastAcceptedTimeStep`), alimenté à la fois par `confirmEnrollment()` (confirmation d'enrôlement)
et par `registerSuccessfulChallenge()` (challenge de connexion). Confirmer l'enrôlement puis se
connecter dans la **même fenêtre TOTP de 30 secondes** rejetait à tort le premier challenge comme
`CODE_ALREADY_USED` — cassant de façon certaine et systématique le parcours nominal
`register → mfa_required → enroll → confirm → login/challenge → session` que le §7 de cette ADR
exige **intégralement HTTP**.

**Décision** : deux compteurs anti-rejeu **distincts** sur l'agrégat, jamais un seul partagé :

- `lastAcceptedTimeStep` — posé par `confirmEnrollment()` (et remis à `null` par
  `forceReEnrollment()`), persisté par le repository, mais **lu par aucune décision de sécurité** :
  `registerSuccessfulChallenge()` ne le consulte plus jamais ;
- `lastAcceptedChallengeTimeStep` — lu ET écrit UNIQUEMENT par `registerSuccessfulChallenge()`
  (appelée à la fois par le challenge de connexion et par le step-up de régénération des codes de
  récupération — les deux partagent donc la même protection anti-rejeu, sans créer de surface
  supplémentaire).

**Risque résiduel, accepté et borné — pas un bug à corriger maintenant, la conséquence assumée du
protocole choisi** :

> Un attaquant qui possède déjà le mot de passe et qui obtient le code TOTP utilisé lors de la
> confirmation d'enrôlement peut potentiellement réutiliser ce même code lors du challenge de
> connexion suivant, pendant la fenêtre TOTP concernée.

Bornes exactes : fenêtre ≤ ~90 secondes dans le pire cas — **pas 60** : `Rfc6238TotpService`
applique une tolérance de dérive `TOTP_DRIFT_WINDOW_STEPS = 1` de part et d'autre du pas courant, donc
un code du pas `S` reste valide tant que le pas courant `T ∈ [S-1, S+1]`. Le pire cas, mesuré depuis
l'instant de la confirmation, survient quand l'horloge de l'authentificateur du client est en avance
d'un pas (`delta = +1`, précisément le cas que cette tolérance existe pour absorber) : trois pas de
30 secondes, soit ~90 secondes. L'attaquant doit **déjà** détenir le mot de passe (aucun challenge
n'est atteignable sans authentification préalable réussie) ; une seule réutilisation possible (le
premier challenge pose `lastAcceptedChallengeTimeStep`, tout rejeu suivant reste bloqué). La
limitation de débit MFA (§8, 10 requêtes/60s par IP) protège contre le brute-force mais **n'apporte
aucune borne supplémentaire sur ce scénario précis** — une réutilisation unique du bon code passe en
une seule requête. Le compromis inverse (compteur unique partagé) cassait le parcours nominal à coup
sûr ; celui-ci n'ouvre qu'un risque résiduel borné face à un adversaire déjà en possession du mot de
passe et positionné en temps réel au moment de l'enrôlement.

**Option architecturale future, non retenue par cet amendement** : émettre directement une session
complète à la confirmation de l'enrôlement (au lieu de l'aller-retour d'identifiants du §7 bis E)
supprimerait ce risque résiduel en évitant tout challenge dans la fenêtre. C'est une modification de
domaine distincte (transition de session `MFA_PENDING` conditionnée à une vérification TOTP réelle),
qui recoupe le résidu 8 ci-dessous — à instruire séparément, jamais à improviser dans un contrôleur.

### AC-3 — Politique de mot de passe : **ACCEPTÉ, politique V1 définitive**

Le résidu 6 ci-dessous est **FERMÉ** par cet amendement :

> **Politique V1 : minimum 8 caractères, aucune règle de complexité, maximum 512 caractères.**

Le plancher de 8 caractères — déjà `MIN_PASSWORD_LENGTH` (constante de module de
`CreateUserAccount.ts`, jamais une politique de complexité), dupliqué en garde de frontière par
`RegistrationSchema.ts` (§3) — cesse d'être une simple contrainte technique cachée : c'est désormais
la politique de mot de passe **définitive** de cette étape, publiquement observable via
`POST /api/v1/registrations` (`400 invalid_request` en deçà). Le plafond de 512 caractères, lui,
n'existe qu'au niveau du schéma zod de frontière (`RegistrationSchema.ts`) — le handler applicatif
ne porte aucune borne haute ; seul le plancher bénéficie d'une défense en profondeur aux deux
niveaux. Aucune règle supplémentaire (complexité, caractères spéciaux, expiration, historique) n'est
ajoutée par cet amendement : ce serait inventer un barème métier non fourni.

### Correctifs de sécurité — BLOQUANT-1/2/3 et gaps AC-A/B/C trouvés en seconde revue

Tous **fermés**, vérifiés par une seconde revue de sécurité indépendante dédiée à ces correctifs :

- **BLOQUANT-1** (rejets de promesse non gérés) — les cinq routes de cette ADR et
  `GET /api/v1/audit-entries` sont désormais montées via un wrapper `asyncRoute()` unique
  (`server.ts`) qui route tout rejet vers `next(error)` ; Express 4 ne le fait pas nativement (une
  requête restait auparavant sans AUCUNE réponse jusqu'au timeout client, avec un
  `unhandledRejection` non rattrapé). Pinné par un test dédié (`errorHandler.test.ts`).
- **BLOQUANT-2** (courses sur contrainte d'unicité PostgreSQL) — `PrismaUserAccountRepository.save()`
  et la branche CREATE de `PrismaMfaEnrollmentRepository.save()` utilisent désormais
  `createMany({ skipDuplicates: true })` (jamais un `create()`/`upsert()` dont on rattraperait un
  `P2002`, qui aborte la transaction PostgreSQL en cours) ; `StartMfaEnrollmentHandler` verrouille
  désormais la ligne existante (`findByUserIdForUpdate`, cohérent avec
  `ConfirmMfaEnrollment`/`VerifyMfaChallenge`) et traduit le conflit resté possible sur le tout
  premier enrôlement en `409 mfa_enrollment_already_active`. Pinnés par deux tests de concurrence
  déterministes au niveau repository (deux agrégats distincts, deux transactions `PgUnitOfWork`
  indépendantes, assertion `1 OK / 1 CONFLICT` toujours vraie) : le pinning ne repose pas sur la
  variante HTTP existante (`registrationHttp.test.ts`, `Promise.all` de deux requêtes), qui reste
  probabiliste — les deux requêtes peuvent ne jamais chevaucher leurs transactions PostgreSQL.
- **BLOQUANT-3** (rate limiter non atomique + `express.json()` avant lui) —
  `RedisRateLimiter.consume()` exécute désormais un script Lua unique (`INCR` + `EXPIRE` dans la
  même exécution atomique, avec auto-réparation de toute clé déjà sans TTL — AC-B ci-dessous) ;
  `express.json()` est monté PAR ROUTE, après le limiteur de débit, jamais globalement. Pinnés par
  deux tests dédiés (corps JSON illisible réellement compté par le limiteur ; aucune clé sans TTL).
- **AC-A** (rejeu d'un code de récupération déjà consommé) —
  `PrismaMfaEnrollmentRepository.reconcileRecoveryCodes` distingue désormais un rejeu séquentiel
  légitime d'une vraie course concurrente via un drapeau transient sur `MfaRecoveryCode`
  (`wasConsumedInThisInstance()`), jamais une comparaison d'horodatage — qui masquerait à tort une
  vraie course si deux writers concurrents tombaient sur la même milliseconde.
- **AC-B** (validation du réglage du rate limiter) — `createRateLimitMiddleware` refuse à la
  construction (échec au démarrage du serveur, jamais en production) tout `windowSeconds`/
  `maxRequests` non entier positif ; le script Lua répare aussi toute clé déjà sans TTL, pas
  seulement à sa création.
- **AC-C** (migration sans backfill) — la migration `20260902100000_mfa_challenge_time_step_decoupled`
  initialise `lastAcceptedChallengeTimeStep` depuis `lastAcceptedTimeStep` pour tout enrôlement
  existant, fermant la fenêtre de rejeu qu'un `NULL` par défaut aurait ouverte au déploiement.

### Résidus ouverts par cet amendement — explicitement NON fermés

Dettes suivies, pas des régressions des correctifs ci-dessus ; elles ne bloquent pas la clôture de
l'étape 12/13 :

- **AC-2 — OPEN — contrôle applicatif d'expiration de session.** `ServerContextResolver` et
  `VerifyMfaChallengeHandler` ne vérifient jamais explicitement `expiresAt`/`absoluteExpiresAt`
  contre l'horloge : l'expiration repose entièrement sur la TTL Redis. **Non résolu** par cette ADR
  ni par cet amendement — documenté comme dette explicite, à ne jamais confondre avec une garantie
  applicative.
- **AC-G — OPEN — `trust proxy` / détermination fiable de l'IP source derrière un reverse proxy.**
  La clé du limiteur de débit (§8) est `req.ip`, non spoofable tant qu'aucun `trust proxy` n'est
  activé — mais derrière un futur reverse proxy de production, toutes les requêtes partageraient
  l'IP du proxy (auto-déni de service global) sans qu'un `trust proxy` mal configuré n'ouvre à
  l'inverse l'usurpation via `X-Forwarded-For`. À trancher explicitement **avant** toute mise en
  production du rate limiting — sans impact sur la Phase 0, aucun déploiement de production
  n'existant encore.

### Hors périmètre de cet amendement

`.github/workflows/ci.yml` (CI minimale typecheck/lint/build/test) n'est **pas** tranché par cet
amendement : son rattachement (preuve de non-régression de l'étape 12, ou périmètre de l'étape 13
« CI/CD et contrôles de conformité ») est une décision de découpage de livraison, distincte des
décisions de sécurité/produit ci-dessus, et reste à trancher séparément.

---

## Alternatives écartées

| # | Alternative | Motif du rejet |
|---|---|---|
| 1 | **Ne pas exposer de route et écrire l'E2E au niveau handler** (comme `provisioningSaga.test.ts`) | Le critère de sortie dit « E2E », et un test qui appelle directement les handlers ne prouve **rien** sur la surface réellement exposée : ni la validation d'entrée, ni le mass-assignment, ni le format d'erreur, ni l'ordre des middlewares. Écarté par décision du responsable technique |
| 2 | **Reporter en Phase 1** | Fermerait la Phase 0 sur un critère de sortie non satisfait, en s'appuyant sur une couche (`apps/web`) que la roadmap place explicitement **après** les contrats du SaaS Core |
| 3 | **Deux routes séparées pour la connexion** (`POST /auth/authentications` puis `POST /auth/sessions`) | La seconde recevrait un `userId` non prouvé depuis le client — exactement l'anti-pattern qu'ADR-0008 §9 interdit pour `ownerUserId`. La rendre sûre exigerait une session intermédiaire, c'est-à-dire une quatrième variante de `SessionContext` (point 5 du §12) |
| 4 | **Un orchestrateur applicatif `RegisterEstablishment`** enchaînant tout en mémoire | Explicitement rejeté par ADR-0008 §9 (option écartée) : romprait la garantie de reprise après crash du §4 de cette ADR. Seul le **couple** `CreateUserAccount → CreateHealthFacility` reste synchrone, et il tient dans le contrôleur |
| 5 | **Contrôleur d'inscription dans `modules/identity/presentation/`** | Ferait importer `CreateHealthFacilityHandler` (module `tenant`) par le module `identity` : un module qui en connaît un autre, contre §5 de 01-target-architecture.md. Le placer hors de `modules/` rend la contrainte structurelle (§1) |
| 6 | **`ProblemDetails` (RFC 9457)** pour ces nouvelles routes | Le dépôt produit `SimpleError` partout où il produit une erreur (webhook, audit, `createErrorHandler`) ; `ProblemDetails` n'est qu'un schéma réservé, sans producteur. Introduire un **second** format d'erreur en frontière rendrait tout client obligé de gérer les deux |
| 7 | **Réutiliser `unauthenticated` (401) pour un échec de login** | Rendrait indistinguables « session expirée » et « saisie erronée », côté client comme côté log. Deux codes pour deux faits distincts, jamais un code dont le sens dépend de la route (§5) |
| 8 | **Distinguer `tenant_suspended` / `tenant_not_found` en réponse** | Oracle d'existence d'établissement sur une route non authentifiée, et contraire à la règle déjà appliquée par `TenantModuleBackedAccessChecker` (ADR-0008 §3) |
| 9 | **`201 Created` sur l'inscription** | Affirmerait que la ressource est prête. Elle ne l'est pas : le tenant n'est `ACCESSIBLE` qu'une fois `StartTrialSubscription` rejoué par l'Outbox (ADR-0008 §3). `202` est le seul code honnête |
| 10 | **Endpoint de suivi de provisioning** (`GET /registrations/{id}`) | Créerait la tentation exacte qu'ADR-0008 §3/§11 interdit : consulter un indicateur de progression de Saga. La disponibilité se constate dynamiquement, en tentant la connexion |
| 11 | **Compenser un compte orphelin par suppression** (§3) | O-03.1 (« aucune suppression de données à aucune étape ») et ADR-0008 §5 (« jamais qu'elle démonte ce qui a déjà réussi ») l'interdisent tous les deux |
| 12 | **Pas de limitation de débit, en reconduisant ADR-0009 §8.4** | L'argument d'ADR-0009 (« politique locale divergente sur une seule route ») ne s'applique pas à une politique **partagée** par les cinq routes pré-authentification ; et il n'a jamais couvert le cas d'un endpoint anonyme créant un tenant indestructible (§8) |
| 13 | **Limiter par email plutôt que par IP** | Un attaquant fait varier l'email librement ; la limitation par email ne protège ni de la création massive de tenants, ni de la pulvérisation de mots de passe. Une clé composite IP+email pourra être ajoutée additivement, jamais l'inverse |
| 14 | **Inclure `tenantId` (ou tout champ du corps) dans la clé de limitation** (§8) | Ces routes sont anonymes et pré-tenant : le seul `tenantId` observable est celui que le client écrit lui-même dans `context.tenantId` (§6). Une clé qui en dépend se contourne en faisant varier ce champ à chaque requête — la limite deviendrait décorative |
| 15 | **`Retry-After` égal au TTL résiduel de la clé Redis** (§8) | Divulgue l'état du compteur et l'instant exact de réinitialisation, permettant de cadencer l'attaque au plus juste. La durée **nominale** constante ne révèle que la longueur de la fenêtre, mesurable empiriquement de toute façon. Une date HTTP (`HTTP-date`) est écartée pour la même raison, aggravée par l'exposition de l'horloge serveur |
| 16 | **Transporter `pendingSessionId` dans le corps JSON des routes MFA** (§7 bis) | Réintroduirait un champ d'identité dans le corps, à un pas d'un `userAccountId` que le correctif F-2 (ADR-0005) a précisément retiré de ces commandes. L'en-tête `Authorization` rend la faute impossible par ajout de champ, pas seulement interdite, et reconduit le transport déjà en place (ADR-0009 §8.3) |
| 17 | **Monter `requireAuthenticatedContext` sur les trois routes MFA** | `ServerContextResolver.resolve()` répond `MFA_REQUIRED` pour **toute** session `MFA_PENDING` (`mfaSessionGate.test.ts`) : les trois routes seraient inaccessibles par construction. Assouplir ce gate pour les « laisser passer » rouvrirait la faille qu'ADR-0005 §4 a fermée structurellement |
| 18 | **Un code d'erreur `invalid_mfa_code` distinct** (§5) | Énoncerait exactement le même fait qu'`invalid_credentials` (« le secret soumis ne vaut rien ») ; seule la nature du secret change, et le chemin appelé la donne déjà. La distinction utile en exploitation est portée par l'audit (`SESSION_LOGIN_FAILED` vs `MFA_CHALLENGE_FAILED`), jamais par le code HTTP |
| 19 | **Faire émettre une session complète par `ConfirmMfaEnrollment`** pour éviter la re-connexion (§7 bis E) | Délivrerait une session complète **sans qu'aucun code TOTP n'ait jamais été vérifié contre le facteur activé** : un contournement du second facteur. Assouplir le refus `ENROLLMENT_REQUIRED` de `VerifyMfaChallenge`, ou muter le `reason` de la session depuis le contrôleur, produit exactement le même défaut |

---

## Conséquences

**Acquis**

- Le résidu 1 d'ADR-0008 est **fermé** : le point d'entrée HTTP d'inscription existe et respecte
  littéralement le contrat du §9 de cette ADR (`ownerUserId` issu de la même requête serveur,
  jamais d'un champ client).
- Le parcours `inscription → provisioning → connexion → second facteur → accès tenant` devient
  **intégralement observable depuis l'extérieur du processus**, en HTTP de bout en bout : le
  critère de sortie E2E de Phase 0 n'est plus couvert partiellement (§7/§7 bis).
- Le format d'erreur du dépôt reste **unique** (`SimpleError`), étendu additivement de cinq codes.
- La dette de transport d'ADR-0005 (« anti-énumération et limitation de débit au niveau
  transport »), reconduite par ADR-0006 et ADR-0009 §8.4, est **partiellement fermée** : la
  limitation de débit existe pour la première fois, sur les routes qui en ont le plus besoin.
- Les permissions cessent d'être inaccessibles au client : `permissionCodes` est servi par le
  serveur, condition du critère « le frontend ne contient aucune permission codée en dur ».

**Dette assumée**

- **Énumération de comptes sur `POST /api/v1/registrations`** (§4), bornée par la limitation de
  débit mais réelle. À rouvrir dès qu'un flux de confirmation par email existera.
- **Compte orphelin en cas de crash entre les deux commandes** (§3) : l'utilisateur ne peut plus
  se réinscrire avec le même email ; déblocage opérationnel, même famille que le dead-letter de
  provisioning (ADR-0008 résidu 4).
- **Aller-retour d'identifiants après l'enrôlement MFA** (§7 bis E) : la confirmation d'enrôlement
  n'émettant aucune session, l'utilisateur doit re-soumettre email + mot de passe pour obtenir une
  session `CHALLENGE_REQUIRED`. Comportement **existant et volontairement non contourné** ; même
  famille que l'aller-retour de sélection d'établissement validé au §12 point 5. Résidu 8.
- **`refreshToken` transporté dans un corps JSON** et donc confié au stockage du client. Le résidu
  5 d'ADR-0009 (transport définitif, cookie/CSRF) s'étend désormais à lui — **et au
  `pendingSessionId`**, transporté en `Bearer` puis conservé par le client entre la connexion,
  l'enrôlement et le challenge.
- **`provisioningUri` et `recoveryCodes` traversent la frontière HTTP en clair** (§7 bis A/B).
  C'est inhérent au protocole TOTP et au contrat d'exposition unique d'ADR-0005 §3, pas un choix de
  cette ADR ; la mitigation est entièrement portée par le §10 (jamais journalisés, `no-store`) et
  par TLS, non négociable en déploiement.
- **Aucune limitation de débit sur les routes authentifiées** : `GET /api/v1/audit-entries` reste
  non limitée (ADR-0009 §8.4 inchangé pour elle).
- **`correlationId` propagé de façon inégale selon la route** : `StartMfaEnrollmentCommand`,
  `ConfirmMfaEnrollmentCommand` et `VerifyMfaChallengeCommand` portent réellement ce champ — sur
  les **trois routes MFA**, l'en-tête `X-Correlation-Id` atteint donc les entrées d'audit.
  `AuthenticateUserCommand`, `ResolveTenantContextCommand`, `CreateUserAccountCommand` et
  `CreateHealthFacilityCommand` **ne le portent pas** : sur `POST /registrations` et
  `POST /auth/sessions`, l'en-tête reste lu et **journalisé uniquement**, non répercuté en audit.
  Élargir ces quatre contrats est possible mais dépasse le mandat — un même parcours E2E produit
  donc des entrées d'audit partiellement corrélées seulement.

**Résidus**

1. ~~**Routes MFA** (`StartMfaEnrollment`, `ConfirmMfaEnrollment`, `VerifyMfaChallenge`)~~ —
   **FERMÉ le 2026-09-02** par l'arbitrage du §12 point 1 : les trois routes sont livrées par cette
   ADR (§7 bis) et l'E2E devient intégralement HTTP. Conservé en place, barré, pour ne pas
   renuméroter les résidus déjà cités ailleurs.
2. **Audit de la création de compte en libre-service** — aucun `AuditEventType` ne la couvre
   directement (§11). À trancher **avec** la commande d'administration de `UserAccount`, dont
   ADR-0009 résidu 8 note déjà l'absence — jamais par anticipation.
3. **Flux de confirmation d'adresse email** (gabarit `notifications`, jeton, expiration) —
   prérequis pour fermer la dette d'énumération du §4. Aucune décision produit n'existe.
4. **Valeurs de limitation de débit** (§8) — non décidées ici, même régime que
   `SessionDurationTuning.ts`.
5. **Session intermédiaire de sélection d'établissement** (§6, cas 4 ; point 5 du §12).
6. ~~**Politique de mot de passe**~~ — **FERMÉ le 2026-09-02** par l'amendement 1 (AC-3) : 8
   caractères minimum, aucune règle de complexité, devient la politique V1 **définitive** de cette
   étape, plus une simple contrainte technique cachée. Conservé en place, barré, pour ne pas
   renuméroter les résidus déjà cités ailleurs.
7. **Routes de déconnexion et de rafraîchissement** (§11) — la dette d'ADR-0006 reste ouverte.
8. **Ergonomie du retour d'enrôlement MFA** (§7 bis E) — la re-soumission des identifiants entre
   `ConfirmMfaEnrollment` et `VerifyMfaChallenge` est une conséquence du contrat existant, pas une
   décision produit. La supprimer exigerait soit qu'un enrôlement confirmé émette une session
   (rejeté, alternative 19), soit une transition explicite de la session `MFA_PENDING` de
   `ENROLLMENT_REQUIRED` vers `CHALLENGE_REQUIRED` **conditionnée à une vérification TOTP réelle**
   — une modification du domaine à trancher séparément, **jamais** à improviser dans un contrôleur.
9. **`Retry-After` sur les routes authentifiées** — `GET /api/v1/audit-entries` reste hors
   limitation de débit (ADR-0009 §8.4) ; la question se rouvrira quand une politique globale
   couvrira les routes authentifiées.
10. **Contrôle applicatif d'expiration de session (AC-2)** — ajouté par l'amendement 1.
    `ServerContextResolver`/`VerifyMfaChallengeHandler` ne vérifient jamais explicitement
    `expiresAt`/`absoluteExpiresAt` contre l'horloge ; l'expiration repose entièrement sur la TTL
    Redis. Défense en profondeur à coût nul, jamais tranchée par cette ADR.
11. **`trust proxy` / détermination fiable de l'IP source derrière un reverse proxy (AC-G)** —
    ajouté par l'amendement 1. La clé du limiteur de débit (§8) est `req.ip` ; à trancher
    explicitement avant toute mise en production du rate limiting, avec la politique de confiance
    des sauts réseau (quels proxies, quel en-tête). Sans impact sur la Phase 0.

---

## Gate pour l'agent d'implémentation

Brief à donner tel quel, sans reformulation qui en élargirait la portée :

> Exposer **exactement cinq** routes : `POST /api/v1/registrations`, `POST /api/v1/auth/sessions`
> (§2/§6), `POST /api/v1/auth/mfa/enrollment`, `POST /api/v1/auth/mfa/enrollment/confirmation` et
> `POST /api/v1/auth/sessions/mfa-challenge` (§7 bis). Ne créer **aucune** autre route (ni
> déconnexion, ni rafraîchissement, ni suivi de provisioning, ni consultation d'enrôlement).
> N'écrire **aucun** nouveau handler de commande, **aucun** nouvel agrégat, **aucune** migration,
> **aucun** nouveau type d'événement d'audit : tous les handlers nécessaires existent déjà
> (`createUserAccount`, `createHealthFacility`, `authenticateUser`, `resolveTenantContext`,
> `startMfaEnrollment`, `confirmMfaEnrollment`, `verifyMfaChallenge`) — les contrôleurs
> **valident, délèguent, présentent**, et rien d'autre (§1).
>
> `ownerUserId` provient **exclusivement** du `CreateUserAccount` de la même requête, jamais du
> corps HTTP (ADR-0008 §9). `platformRole` est fixé à `'NONE'` en dur, jamais accepté du client.
> Valider avec zod `.strict()` sur **les cinq** routes, et valider `facilityName` **avant** de créer
> le compte (§3) — ne pas « factoriser » cette duplication avec le VO `FacilityName`, c'est une
> garde d'ordonnancement. À l'inverse, ne **pas** dupliquer en zod le format d'un code TOTP ou d'un
> code de récupération : bornes de taille uniquement, la validité appartient à `TotpService` et à
> `HmacRecoveryCodeHasher` (§7 bis B/C).
>
> Réutiliser le format d'erreur `{"error":"<code>"}` existant (`SimpleError`), **jamais**
> `ProblemDetails` (§5). Ne **jamais** distinguer `tenant_not_found` de `tenant_suspended` : toutes
> les erreurs de `ResolveTenantContext` deviennent un `403 forbidden` unique (§6) ; ne **jamais**
> distinguer `SESSION_NOT_FOUND` de `SESSION_NOT_PENDING_*` : les deux donnent le même
> `401 unauthenticated`, octet pour octet (§7 bis A).
>
> **Routes MFA** : le `pendingSessionId` se lit **exclusivement** dans
> `Authorization: Bearer <…>`, jamais dans le corps ; aucun identifiant d'utilisateur n'est accepté
> nulle part (correctif F-2, ADR-0005). Ne **pas** monter `requireAuthenticatedContext` dessus — il
> refuserait structurellement toute session `MFA_PENDING`. Le contrôleur extrait une chaîne opaque
> et la passe au handler : **aucun** accès `SessionStore`, **aucun** appel à
> `ServerContextResolver`, aucun second chemin de résolution de contexte (ADR-0009 §8.2). Ne **pas**
> faire émettre de session par `ConfirmMfaEnrollment`, ne **pas** assouplir le refus
> `ENROLLMENT_REQUIRED` de `VerifyMfaChallenge`, ne **pas** muter le `reason` d'une session en
> attente : la re-connexion entre confirmation et challenge est le comportement voulu (§7 bis E).
> `POST /auth/sessions/mfa-challenge` réutilise **le même présentateur** de session que
> `POST /auth/sessions` (§7 bis C) et n'expose jamais `membershipId`, `userId`, `requiresMfa`,
> `mfaSatisfiedAt`, `sensitivityCategory` ni `issuedAt`.
>
> Ne **jamais** journaliser ni auditer le corps de requête, le corps de réponse, l'en-tête
> `Authorization`, l'email tenté, le mot de passe, un code TOTP, un code de récupération ni le
> `provisioningUri` (§10). Servir `Cache-Control: no-store` sur toute réponse portant un secret.
> L'adresse IP ne vit qu'en Redis pour la limitation de débit, **jamais** en base ni dans une
> `AuditEntry` (ADR-0009 §3).
>
> **Limitation de débit (§8)** : middleware **partagé** monté en **premier** sur les cinq routes.
> Clé `sih:rate-limit:<route>:<ip>` — **jamais** de `tenantId`, jamais d'email, jamais un champ du
> corps : ces routes sont anonymes et pré-tenant, et une clé dépendant d'une donnée contrôlée par
> le client se contourne en la faisant varier. Compteur Redis pour lequel **aucune clé ne peut
> exister sans TTL** (`SET <clé> 0 EX <fenêtre> NX` puis `INCR`, primitive déjà employée par
> `RedisMfaBypassAttemptGuard`) — un `INCR` suivi d'un `EXPIRE` séparé est refusé : une panne entre
> les deux bloque une IP définitivement. `429 {"error":"too_many_requests"}` **avec `Retry-After`
> égal à la durée nominale complète de la fenêtre**, en secondes entières, **constante** — jamais
> le TTL résiduel, jamais une date HTTP. Prouver par test : le seuil, l'isolation entre IP, la
> **concurrence** (des requêtes simultanées ne franchissent pas la limite par une course), la
> **non-régression par changement de tenant ou de corps**, et l'**égalité stricte** de
> `Retry-After` entre deux rejets survenus à des instants différents d'une même fenêtre. **Aucune
> valeur numérique** ailleurs que dans le fichier de réglage dédié, marqué non définitif — ni dans
> le middleware, ni dans `composition-root.ts`, ni dans `server.ts`.
>
> Le webhook de paiement reste monté **avant** `express.json()` et `createErrorHandler` reste le
> **dernier** middleware (§9). Le contrôleur d'inscription vit dans `src/presentation/http/` (hors
> `modules/`) et reçoit **les deux handlers**, jamais les modules entiers ; les contrôleurs de
> session et d'enrôlement MFA vivent dans `src/modules/identity/presentation/http/` (§1). Mettre à
> jour `docs/api/openapi.yaml` (**cinq** chemins, **cinq** codes d'erreur supplémentaires dans
> `SimpleError`, en-tête `Retry-After` sur les réponses `429`). Lire ADR-0001 à ADR-0010 avant
> toute modification. Toute décision non couverte par cette ADR (résidus ci-dessus) doit être
> remontée, jamais devinée.

## Tests attendus (critère de sortie, en complément de `02-roadmap-migration.md`)

**Inscription**

- Corps valide → `202`, `userAccountId` et `tenantId` retournés ; `HealthFacility` réellement créée
  et `ACTIVE` en base ; `HealthFacilityCreated` présent dans l'Outbox avec le **bon** `ownerUserId`.
- Corps portant `platformRole: "SUPER_ADMIN"` (ou `ownerUserId`, ou `tenantId`) → `400
  invalid_request`, **aucun** compte créé, et surtout **aucun** compte créé avec un rôle plateforme.
- `facilityName` vide / > 200 caractères → `400`, **aucun `UserAccount` créé** (preuve de l'ordre
  du §3 : la validation précède la création du compte).
- Email déjà enregistré → `409 email_already_registered`, aucune `HealthFacility` créée.
- Email/mot de passe invalides (format, < 8 caractères) → `400`, rien créé.
- JSON illisible → `400 invalid_request` (via `createErrorHandler`, non-régression).
- Deux inscriptions concurrentes avec le même email → un seul compte, l'autre en `409`, jamais
  d'exception non gérée ni de tenant orphelin.
- Le corps de requête (mot de passe inclus) n'apparaît **dans aucun log** et dans **aucune**
  `AuditEntry`.

**Connexion**

- Identifiants faux (email inconnu **et** mot de passe faux sur compte existant) → `401
  invalid_credentials`, **réponse strictement identique dans les deux cas** ; une seule
  `SESSION_LOGIN_FAILED` par fenêtre de déduplication pour le compte existant, **aucune** pour
  l'inconnu (non-régression ADR-0009 §2.1).
- Compte `SUPER_ADMIN`, sans `context` → `200 status=mfa_required` (`requiresMfaForPlatformContext`
  est inconditionnel).
- Propriétaire fraîchement provisionné, sans `context` (un seul tenant actif) →
  `200 status=mfa_required`, `reason=ENROLLMENT_REQUIRED` (§7) — **test qui verrouille le constat**,
  pour qu'une régression de `MfaPolicy` ne passe pas inaperçue.
- Utilisateur **sans** MFA requis (rôle non administrateur) → `200 status=authenticated`,
  `sessionId` **réellement utilisable** en `Authorization: Bearer` sur `GET /api/v1/audit-entries`
  (ou `403 forbidden` si `audit:read` absent — jamais `401`), et `refreshToken` non vide.
- `context.tenantId` d'un tenant où l'utilisateur **n'a aucun membership** → `403 forbidden`,
  **aucune** session créée, corps ne contenant **aucune** donnée de ce tenant ; entrée
  `SESSION_CONTEXT_DENIED` écrite.
- Tenant partiellement provisionné (`Subscription` absente, ADR-0008 §3) → `403 forbidden`,
  **indistinguable** d'un tenant inexistant (comparer les deux réponses octet pour octet).
- `HealthFacility` `SUSPENDED` → `403 forbidden`, même réponse que ci-dessus.
- Utilisateur membre de **deux** tenants, sans `context` → `200
  status=context_selection_required`, aucun `sessionId`, aucun `refreshToken`.
- La réponse `200 status=authenticated` n'expose **jamais** `membershipId`, `mfaSatisfiedAt`,
  `sensitivityCategory`, `requiresMfa` ni `userId`.
- Le `refreshToken` retourné est **réellement rotatif** : présenté à `RefreshSessionHandler`, il
  produit une nouvelle chaîne ; présenté deux fois, il déclenche `REUSE_DETECTED`
  (non-régression ADR-0006).

**Routes MFA (§7 bis)**

*Enrôlement — `POST /auth/mfa/enrollment`*

- Session `MFA_PENDING`/`ENROLLMENT_REQUIRED` présentée en `Bearer` → `200`, `enrollmentId` et
  `provisioningUri` non vides ; `MfaEnrollment` réellement persisté ; entrée d'audit
  `MFA_ENROLLMENT_STARTED(SUCCESS)` écrite, portant le `correlationId` de `X-Correlation-Id`.
- **Aucun** `Authorization` → `401 unauthenticated`, aucun `MfaEnrollment` créé.
- `Bearer` inconnu **et** `Bearer` portant une session **complète** (non `MFA_PENDING`) **et**
  `Bearer` portant une session `MFA_PENDING`/`CHALLENGE_REQUIRED` → **trois réponses identiques
  octet pour octet** : `401 unauthenticated` (test d'anti-oracle d'état de jeton).
- Corps non vide, **en particulier `{"userAccountId":"<autre compte>"}`** → `400 invalid_request`,
  **aucun** `provisioningUri` retourné : preuve de non-régression du correctif F-2.
- Facteur déjà `ACTIVE` → `409 mfa_enrollment_already_active`, **aucun nouveau `pendingSecret`**
  écrit sur l'agrégat.
- La réponse porte `Cache-Control: no-store` ; le `provisioningUri` n'apparaît **dans aucun log**.

*Confirmation — `POST /auth/mfa/enrollment/confirmation`*

- Code TOTP valide calculé depuis le `provisioningUri` de l'étape précédente → `200`,
  `recoveryCodes` de longueur `MFA_RECOVERY_CODE_COUNT`, facteur devenu `ACTIVE`, audit
  `MFA_ENROLLMENT_CONFIRMED(SUCCESS)`.
- Code faux → `401 invalid_credentials`, compteur d'échecs consécutifs incrémenté,
  `MFA_ENROLLMENT_CONFIRMED(FAILURE)` écrit — **et aucun `recoveryCodes` dans la réponse**.
- `MFA_MAX_CONSECUTIVE_FAILED_ATTEMPTS` échecs → le suivant renvoie `429 too_many_requests` avec
  `Retry-After` **constant** (durée nominale du verrou, jamais le reliquat) et `MFA_FACTOR_LOCKED_OUT`
  écrit **une seule fois** par épisode.
- Confirmation sans enrôlement préalable → `409 mfa_enrollment_required`.
- Les codes de récupération n'apparaissent **dans aucun log** ; réponse en `no-store`.

*Challenge — `POST /auth/sessions/mfa-challenge`*

- Session `CHALLENGE_REQUIRED` + code TOTP valide → `200 status=authenticated`, `sessionId`
  **réellement utilisable** en `Bearer` sur `GET /api/v1/audit-entries`, `refreshToken` retourné,
  ancienne session en attente **supprimée** du `SessionStore`.
- Même scénario avec `factor.kind = "RECOVERY_CODE"` et un code non consommé → `200`, code marqué
  consommé, `MFA_RECOVERY_CODE_CONSUMED` écrit ; le **même** code rejoué → `401 invalid_credentials`.
- Code TOTP faux et code de récupération faux → **réponses identiques** (`401 invalid_credentials`),
  jamais de distinction du facteur en échec.
- Session `MFA_PENDING`/**`ENROLLMENT_REQUIRED`** (celle ayant servi à l'enrôlement, réutilisée
  après confirmation) → `409 mfa_enrollment_required`, **aucune session complète émise** — test qui
  verrouille §7 bis E et interdit toute « simplification » du parcours.
- `factor.kind` inconnu ou champ inconnu → `400 invalid_request`, **aucune** tentative comptabilisée
  sur l'agrégat (le verrou anti-brute-force n'est pas consommable par du bruit syntaxique).
- Membership révoqué **pendant** la fenêtre de challenge → `403 forbidden`, aucune session émise.
- La réponse `200` n'expose **jamais** `membershipId`, `userId`, `requiresMfa`, `mfaSatisfiedAt`,
  `sensitivityCategory` ni `issuedAt` — **exactement** les mêmes exclusions qu'au §6, vérifiées par
  comparaison de la forme des deux réponses.

**Limitation de débit**

- N+1 requêtes dans la fenêtre sur `POST /api/v1/registrations` depuis la même IP → `429
  too_many_requests`, **aucun** `UserAccount` ni `HealthFacility` créé par la requête rejetée.
- Idem sur `POST /api/v1/auth/sessions` et sur les **trois** routes MFA, **sans** entrée d'audit
  produite par le rejet (§8).
- **Isolation entre IP** : une IP différente n'est **jamais** affectée par le compteur d'une autre.
- **Concurrence** : `2 × N` requêtes émises **simultanément** depuis la même IP (sans
  sérialisation) → **au plus N** requêtes acceptées, les autres en `429`. Aucune course ne doit
  permettre de dépasser le seuil ; test à exécuter contre Redis réel, jamais contre un double en
  mémoire (c'est l'atomicité de la primitive Redis qui est éprouvée, pas celle du middleware).
- **Non-contournement par changement de tenant** : N+1 requêtes sur `POST /auth/sessions` depuis la
  même IP en faisant varier `context.tenantId` à **chaque** requête (tenants existants, inexistants
  et malformés mélangés) → le `429` survient **au même rang** que sans variation. Preuve directe
  que la clé n'est jamais tenant-scopée (§8).
- **Non-contournement par changement de corps** : même test en faisant varier `email` et
  `facilityName` sur `POST /registrations` → `429` au même rang.
- **Aucune clé sans TTL** : après une rafale, toute clé `sih:rate-limit:*` présente en Redis a un
  `TTL > 0` (aucune IP ne peut rester bloquée indéfiniment).
- **`Retry-After` constant** : deux rejets `429` observés à des instants différents d'une **même**
  fenêtre portent une valeur **strictement identique**, et cette valeur est un entier de secondes
  (jamais une date HTTP).
- Le rejet `429` survient **avant** tout accès PostgreSQL du contrôleur (aucune requête SQL émise
  par une requête rejetée).

**Parcours complet (E2E de l'étape 12) — intégralement HTTP**

Aucune étape de ce parcours n'est pilotée au niveau handler : chaque flèche est une requête HTTP
réelle contre l'application Express assemblée par `composition-root.ts`.

1. `POST /api/v1/registrations` → `202`, `userAccountId` + `tenantId`.
2. Relais Outbox → `Subscription` `TRIALING` + membership `ADMIN_ETABLISSEMENT` + `FacilitySettings`
   semée + `ProvisioningCompleted`.
3. `POST /api/v1/auth/sessions` (identifiants de l'étape 1) → `200 status=mfa_required`,
   `reason=ENROLLMENT_REQUIRED`, `pendingSessionId` P1.
4. `POST /api/v1/auth/mfa/enrollment` avec `Authorization: Bearer P1` → `200`, `provisioningUri`.
5. `POST /api/v1/auth/mfa/enrollment/confirmation` avec `Bearer P1` et un code TOTP **calculé dans
   le test** depuis le secret du `provisioningUri` → `200`, `recoveryCodes`.
6. `POST /api/v1/auth/sessions` (mêmes identifiants — §7 bis E) → `200 status=mfa_required`,
   `reason=CHALLENGE_REQUIRED`, `pendingSessionId` P2 **différent** de P1.
7. `POST /api/v1/auth/sessions/mfa-challenge` avec `Bearer P2` et un code TOTP frais →
   `200 status=authenticated`, `sessionId` S + `refreshToken`.
8. `GET /api/v1/audit-entries` avec `Authorization: Bearer S` → `200`, et **uniquement** des entrées
   du tenant de l'étape 1.

- Contrôle de non-contournement intercalé : à l'étape 5, `POST /auth/sessions/mfa-challenge` avec
  `Bearer P1` → `409 mfa_enrollment_required`, **jamais** une session complète.
- Contrôle de non-contournement intercalé : à l'étape 3, `GET /api/v1/audit-entries` avec
  `Bearer P1` → `403 mfa_required` (non-régression `mfaSessionGate.test.ts` **par la voie HTTP**).
- Le `refreshToken` de l'étape 7 est **réellement rotatif** : présenté à `RefreshSessionHandler`, il
  produit une nouvelle chaîne ; présenté deux fois, il déclenche `REUSE_DETECTED` (non-régression
  ADR-0006).
- Deux inscriptions distinctes A et B menées jusqu'à l'étape 8 : la session de A n'accède **jamais**
  à une donnée de B, à aucun des trois niveaux d'ADR-0009 §10.
- Aucun secret du parcours (mot de passe, `provisioningUri`, `recoveryCodes`, `refreshToken`,
  `pendingSessionId`, `sessionId`) n'apparaît dans un log ni dans une `AuditEntry` — vérifié sur la
  totalité du parcours, pas route par route.
- Non-régression complète de la suite existante, en particulier `auditHttpIsolation.test.ts`,
  `mfaSessionGate.test.ts`, `mfaBruteForceConcurrency.test.ts`, `mfaTenantIsolation.test.ts`,
  `refreshTokenRotation.test.ts`, `provisioningSaga.test.ts`, `rlsGuard.test.ts` (aucune table
  ajoutée) et `errorHandler.test.ts`.
