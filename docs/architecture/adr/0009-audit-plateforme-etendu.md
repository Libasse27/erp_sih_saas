# ADR-0009 — Audit plateforme étendu : couverture SaaS Core, chaînage SHA-256, lecture CQRS et premier endpoint HTTP authentifié

- **Statut** : **Accepté** (2026-08-29) — validé par le responsable technique, y compris les quatre
  arbitrages tranchés en amont de cette rédaction : **B1** périmètre restreint aux actions sensibles
  du **SaaS Core** (aucun audit médical, aucun module clinique n'existant dans ce dépôt) ; **B2**
  « console » = Repository → Query Handlers → **un** endpoint HTTP authentifié minimal, **sans
  aucune interface graphique** à cette étape ; **B3** **aucune purge** implémentée (O-15 reste
  ouvert, décideur Juridique) ; **B4** chaînage **SHA-256 linéaire uniquement**, sans ancrage
  externe write-once. Exigence transverse également validée : le système d'audit ne doit jamais
  devenir un moyen de contourner l'isolation multi-tenant — preuve exigée sur **PostgreSQL réel**
  à trois niveaux (repository, query handlers, HTTP).
- **Date** : 2026-08-29
- **Décideurs** : Architecture (proposition) + responsable technique (validé le 2026-08-29)
- **Contexte technique** : modules `audit`, `identity`, `subscription`, `tenant`, `payment`
  (+ `composition-root.ts` pour le câblage cross-module et HTTP), Phase 0, étape 11/13
  (« Audit plateforme »)
- **Correction intégrée avant le premier commit** (2026-09-01) : une revue de sécurité indépendante,
  menée après l'implémentation, a établi que le champ de session du journal portait le **jeton de
  session vivant**, rejouable tel quel en `Authorization: Bearer` et republié par l'endpoint du §8.
  Les **§1, §3.1, §5.2, §8 et §10** sont corrigés en conséquence : le champ devient une **référence
  dérivée non réversible** (`sessionRef`, §3.1). Cette correction ne rouvre **aucune** autre
  décision de cette ADR — ni le périmètre de supervision plateforme, ni le chaînage, ni l'isolation.

---

## Contexte

[ADR-0005 §5](0005-mfa-totp-et-audit-plateforme-minimal.md) a créé le module `audit` avec un
périmètre **délibérément minimal** et a reporté explicitement à l'étape 11 : « requêtes, rétention
O-15, console ». Sa section *Dette assumée* y ajoute le **chaînage par empreinte**, qualifié de
« migration purement additive sur une table append-only — à traiter à l'étape 11 ».

État réel du dépôt à la date de cette ADR (vérifié par lecture du code, jamais supposé) :

1. **Le contrat d'écriture est en place et solide.** `AuditEntry` (`modules/audit/domain/`) est un
   agrégat sans setter, qui n'émet et n'émettra jamais de `DomainEvent` ;
   `PrismaAuditEntryRepository` n'utilise que `create()` et rejoint la transaction courante via
   `resolvePrismaClient` ; l'immuabilité est garantie par **deux défenses indépendantes**
   (`REVOKE UPDATE, DELETE, TRUNCATE` sur `sih_app` + triggers `BEFORE UPDATE OR DELETE` et
   `BEFORE TRUNCATE`, migrations `20260826150000` et `20260826160000`).
2. **Le port de lecture est volontairement vide.** `AuditEntryRepository` n'expose que `append()` et
   `findById(id, tenantId)`. Le commentaire de tête de
   `test/audit/integration/auditEntryTenantIsolation.test.ts` le note lui-même : aucune méthode de
   liste n'existe, « réservé à la console Super Admin, étape 11/13 ». Aucune couche
   `audit/application/` n'existe : le module n'a que `domain/` et `infrastructure/`.
3. **Deux catégories seulement sont émises** : `MFA` (étape 7) et `SESSION` (étape 8), cette
   dernière limitée au **cycle de vie du refresh token** (`SESSION_REFRESH_ROTATED`,
   `SESSION_REFRESH_REUSE_DETECTED`, `SESSION_REFRESH_REVOKED`,
   `SESSION_ABSOLUTE_CEILING_EXCEEDED`, `SESSION_INACTIVITY_TIMEOUT`).
   **Constat contre-intuitif, vérifié par `grep` sur les fichiers concernés** :
   `AuthenticateUser.ts`, `ResolveTenantContext.ts` et `CloseSession.ts` ne contiennent **aucune**
   référence à l'audit. **La connexion elle-même, l'ouverture d'un contexte d'établissement et la
   fermeture de session ne produisent aujourd'hui aucune `AuditEntry`.** Ce qui est audité
   aujourd'hui du « chemin de session », c'est la **rotation du jeton**, pas l'authentification.
   L'exigence B1 « qui, quoi, quand, sur quel tenant, avec quel résultat, depuis quel contexte »
   n'est donc pas satisfaite pour l'événement le plus élémentaire de la plateforme.
4. **Aucun module métier n'écrit d'audit.** `subscription` (`StartTrialSubscription`,
   `UpgradeSubscriptionPlan`, `ProcessSubscriptionRenewals`, `ApplyPlanUpgradeOnPaymentSucceeded`,
   `ReactivateSubscriptionOnPaymentSucceeded`), `tenant` (`CreateHealthFacility`,
   `SeedFacilityConfiguration`, `CompleteProvisioning`) et `payment` (`InitiatePayment`,
   `ConfirmPayment`) émettent des `DomainEvent` vers l'Outbox et **n'écrivent aucune `AuditEntry`**.
   En particulier, l'**entrée et le maintien en mode dégradé**
   (`SubscriptionDegradedModeEntered`/`SubscriptionDegradedModeSustained`) ne laissent aucune trace
   d'audit, alors que [§6.3](../01-target-architecture.md#63-saas-core) exige un « audit renforcé »
   pendant cette période.
5. **`platform-audit:read` est une permission morte.** Elle figure bien au catalogue
   (`SystemRoleCatalog.ts`, rôle `SUPER_ADMIN`) mais **aucun endpoint ne la consomme**. Pire, elle
   n'est **structurellement pas consommable** : le commentaire du fichier le dit lui-même (« un
   `SUPER_ADMIN` n'est jamais rattaché via un `UserTenantMembership`/`MembershipRole` »), et
   `PlatformSessionContext` (`application/ports/SessionStore.ts`) **ne porte ni `roleCodes` ni
   `permissionCodes`** — seul `TenantSessionContext` en porte. Une vérification
   `permissionCodes.includes('platform-audit:read')` refuserait donc **toujours** un `SUPER_ADMIN`.
   `ADMIN_ETABLISSEMENT`, de son côté, n'a aucune permission de lecture d'audit.
6. **Aucun endpoint HTTP authentifié n'existe dans tout le dépôt.** `server.ts` ne monte que
   `/health` et `/api/v1/payments/webhook` (`PaymentWebhookController`, seule route métier, **non
   authentifiée par session**, vérifiée par HMAC sur le corps brut). Il n'existe donc **aucun
   pattern réutilisable de middleware d'authentification, ni aucune convention de transport du
   `sessionId`** (cookie ? en-tête ?) : aucune ADR ne l'a jamais tranché. En revanche, la
   **résolution applicative** du contexte est mature et éprouvée : `ServerContextResolver.resolve()`
   est déjà « le seul endroit où ce que le client prétend devient un contexte RLS », avec son
   traitement exhaustif des variantes de session (`switch` avec garde `never`) et son refus
   `MFA_REQUIRED` structurel.
7. **`platform.AuditEntry` est hors RLS** (schéma `platform`, `tenant_id` NULLABLE), inscrite dans
   la liste blanche consciente `PLATFORM_TABLES_WITHOUT_RLS` de
   `test/tenant/integration/rlsGuard.test.ts`. Le filtrage tenant y est **purement applicatif** —
   c'est exactement ce qui rend l'exigence transverse du responsable technique non négociable.
8. **Contrainte de forme du modèle actuel** : `subject_user_id` et `actor_user_id` sont
   `UUID NOT NULL` en base et obligatoires dans le domaine. Aucune entrée d'audit **sans acteur
   humain** (planificateur de renouvellement, consommateur Outbox de la Saga) ni **sans sujet
   utilisateur** (un abonnement, une facture, un établissement) n'est représentable aujourd'hui.

Cette ADR ne rouvre **aucune** décision d'ADR-0005 : elle en poursuit strictement le plan
(« extensible additivement à l'étape 11 sans réécriture de ce qui est livré »).

---

## Décision

### 1. Périmètre : actions sensibles du **SaaS Core**, jamais un audit médical (B1)

L'étape 11 étend le journal aux faits sensibles **du SaaS Core uniquement** :
authentification/session, MFA, provisionnement d'établissement, memberships et rôles, abonnements
(mode dégradé compris), paiements/facturation, consultation du journal lui-même.

L'**audit médical** de [§7.3](../01-target-architecture.md#73-audit-médical-32) — toute lecture de
dossier patient, `ancienne valeur → nouvelle valeur` — reste **hors périmètre** : aucun module
clinique n'existe dans ce dépôt (Phase 0), et déclarer ici des catégories ou des colonnes qui
n'auraient aucun producteur violerait la discipline déjà appliquée à `MfaFactorType`,
`SubscriptionPlanChangeType` et `PlatformInvoicePurpose` (« aucune valeur non émise n'est déclarée
par anticipation »). O-04.7 dit d'ailleurs explicitement `AuditEntry` **distinct** du journal
d'audit médical.

Chaque entrée doit permettre de répondre, sans jointure vers un autre système :
**qui** (`actorKind` + `actorUserId` + `actorRoleCodes`) · **quoi** (`category` + `eventType` +
`targetType` + `targetId`) · **quand** (`occurredAt`, UTC) · **sur quel tenant** (`tenantId`,
`null` = plateforme) · **avec quel résultat** (`outcome`) · **depuis quel contexte**
(`actorKind` = `USER_PLATFORM`/`USER_TENANT`/`SYSTEM`, `sessionRef`, `correlationId`).

`sessionRef` est une **référence dérivée** de la session, **jamais le jeton de session lui-même**
(§3.1) : le « depuis quel contexte » de B1 exige de pouvoir **corréler** les entrées d'une même
session, jamais de pouvoir **rejouer** cette session.

Le contrat **append-only n'est pas rouvert** : ni cette ADR, ni l'implémentation qui en découle
n'ajoutent la moindre capacité de modification ou de suppression, à aucun niveau (domaine, port,
repository, SQL).

### 2. Catégories et types d'événement : extension **additive**, nommée d'après le fait audité

`AuditCategory` passe de 2 à **6 valeurs**. Le principe de découpage retenu — et il doit être
compris avant d'en ajouter une septième — est que **la catégorie décrit la nature du fait audité,
jamais l'identité de celui qui l'a produit**.

| Catégorie | Statut | Justification du nom et du périmètre |
|---|---|---|
| `MFA` | existante, inchangée | — |
| `SESSION` | existante, **complétée** (§2.1) | Le cycle de vie de l'accès : connexion, ouverture/refus de contexte, rotation, fermeture |
| `PROVISIONING` | nouvelle | Les faits de la Saga d'[ADR-0008](0008-saga-provisioning-etablissement.md) : naissance d'un établissement. Distincte de `TENANT_CONFIG` (§2.3) et de `SUBSCRIPTION` : c'est un **parcours**, pas un état permanent |
| `MEMBERSHIP` | nouvelle | Nommée d'après l'agrégat réellement muté (`UserTenantMembership` + `MembershipRole`). `ACCESS_CONTROL`, plus large, a été écarté : il recouvrirait `MFA` et `SESSION` et rendrait le choix de catégorie ambigu à l'écriture |
| `SUBSCRIPTION` | nouvelle | Cycle de vie commercial de l'abonnement, **mode dégradé inclus** (§6.3, « audit renforcé ») |
| `BILLING` | nouvelle | Retenue plutôt que `PAYMENT` : le périmètre couvre **à la fois** `Payment` (encaissement PSP) **et** `PlatformInvoice` (émission/règlement). `PAYMENT` aurait laissé les factures sans catégorie d'accueil, ou forcé une septième catégorie pour un volume marginal |
| `AUDIT_ACCESS` | nouvelle | Consultation du journal lui-même (§7). Nommée d'après son contenu réel, **pas** `PLATFORM_ADMIN` : voir ci-dessous |

**Pourquoi pas de catégorie `PLATFORM_ADMIN`** (proposée dans le brief, écartée après examen du
code) : une action de `SUPER_ADMIN` sur un abonnement **est** un fait de catégorie `SUBSCRIPTION` ;
lui donner une seconde catégorie possible rendrait le choix ambigu à l'écriture et la recherche
incomplète à la lecture (« ai-je regardé dans la bonne catégorie ? »). Le besoin réel de B1 —
« tracer les actions SUPER_ADMIN » — est satisfait **transversalement** par le champ `actorKind`
(§3) : `actorKind = 'USER_PLATFORM'` filtre exactement les actions accomplies depuis un contexte
plateforme, quelle que soit leur catégorie. Par ailleurs, les actions purement plateforme qui
justifieraient une catégorie dédiée (administration de `Plan`/`PlanPrice`, suspension d'un
établissement, administration de `UserAccount`) **n'ont aujourd'hui aucune commande dans le
dépôt** — déclarer la catégorie maintenant créerait une valeur d'énumération sans producteur.

**Pourquoi pas de catégorie `TENANT_CONFIG` à cette étape** (également proposée dans le brief) :
il n'existe **aucune commande de modification** de configuration d'établissement dans le dépôt —
`SeedFacilityConfiguration` (étape 10) est un **seed unique du provisioning**, qui relève donc de
`PROVISIONING`. La catégorie `TENANT_CONFIG` et son type `TENANT_CONFIG_UPDATED` devront être
ajoutés **additivement** le jour où une telle commande existera ; c'est tracé en résidu (§Résidus 6)
pour que l'omission ne devienne pas silencieuse.

#### 2.1 `SESSION` — fermeture de la lacune constatée au §Contexte 3

Types **ajoutés** à la catégorie existante :

| `AuditEventType` | Producteur | `outcome` | Remarque |
|---|---|---|---|
| `SESSION_LOGIN_SUCCEEDED` | `AuthenticateUserHandler` | `SUCCESS` | — |
| `SESSION_LOGIN_FAILED` | `AuthenticateUserHandler` | `FAILURE` | **Uniquement si le compte existe** — voir ci-dessous |
| `SESSION_CONTEXT_OPENED` | `ResolveTenantContextHandler` | `SUCCESS` | Porte le `tenantId` réellement ouvert |
| `SESSION_CONTEXT_DENIED` | `ResolveTenantContextHandler` | `DENIED` | Établissement suspendu, abonnement absent (ADR-0008 §3), membership révoqué |
| `SESSION_CLOSED` | `CloseSessionHandler` | `SUCCESS` | — |

**`SESSION_LOGIN_FAILED` n'est écrit que pour un compte existant** (sujet identifiable), et
**dédupliqué par la même mécanique que les tentatives de contournement MFA** (`MfaBypassAttemptGuard`,
Redis `SET NX EX` — mécanisme déjà éprouvé, jamais un second inventé ici). Deux raisons, dans cet
ordre :

1. **Minimisation** (ADR-0005 §6) : auditer un échec sur un identifiant inconnu obligerait à
   stocker l'adresse email tentée — exactement ce qui a été retiré du payload de
   `UserAccountCreated` à l'étape 6.
2. **Amplification d'écriture sur une table qu'aucun mécanisme ne peut purger** : B3 exclut toute
   purge, et ADR-0005 laisse en dette « l'anti-énumération et la limitation de débit au niveau
   transport ». Un point d'entrée **non authentifié** capable d'insérer une ligne définitive par
   requête serait un vecteur de saturation auto-infligé, sans contre-mesure disponible à cette
   étape.

**Limite assumée et documentée** : une attaque par pulvérisation sur des identifiants **inconnus**
ne laisse donc aucune trace dans le journal d'audit à cette étape. C'est un problème de limitation
de débit et d'observabilité, pas de journal de preuve — il reste rattaché à la dette de transport
déjà ouverte par ADR-0005.

#### 2.2 `PROVISIONING`, `MEMBERSHIP`, `SUBSCRIPTION`, `BILLING`

| Catégorie | `AuditEventType` | Producteur (handler de commande, dans SA transaction) |
|---|---|---|
| `PROVISIONING` | `PROVISIONING_FACILITY_CREATED` | `CreateHealthFacilityHandler` |
| | `PROVISIONING_CONFIGURATION_SEEDED` | `SeedFacilityConfigurationHandler` |
| | `PROVISIONING_COMPLETED` | `CompleteProvisioningHandler` |
| `MEMBERSHIP` | `MEMBERSHIP_GRANTED` | `GrantMembershipHandler` |
| | `MEMBERSHIP_REVOKED` | `RevokeMembershipHandler` |
| | `MEMBERSHIP_ROLE_ASSIGNED` | commande d'assignation de rôle |
| | `MEMBERSHIP_ROLE_UNASSIGNED` | commande de désassignation de rôle |
| `SUBSCRIPTION` | `SUBSCRIPTION_TRIAL_STARTED` | `StartTrialSubscriptionHandler` |
| | `SUBSCRIPTION_PLAN_UPGRADE_REQUESTED` | `UpgradeSubscriptionPlanHandler` |
| | `SUBSCRIPTION_PLAN_CHANGED` | `ApplyPlanUpgradeOnPaymentSucceeded` |
| | `SUBSCRIPTION_RENEWED` | `ProcessSubscriptionRenewals` |
| | `SUBSCRIPTION_GRACE_PERIOD_STARTED` | `ProcessSubscriptionRenewals` |
| | `SUBSCRIPTION_DEGRADED_MODE_ENTERED` | `ProcessSubscriptionRenewals` |
| | `SUBSCRIPTION_DEGRADED_MODE_SUSTAINED` | `ProcessSubscriptionRenewals` |
| | `SUBSCRIPTION_REACTIVATED` | `ReactivateSubscriptionOnPaymentSucceeded` |
| `BILLING` | `BILLING_PAYMENT_INITIATED` | `InitiatePaymentHandler` |
| | `BILLING_PAYMENT_CONFIRMED` | `ConfirmPaymentHandler` |
| | `BILLING_PLATFORM_INVOICE_ISSUED` | émission de `PlatformInvoice` |
| | `BILLING_PLATFORM_INVOICE_SETTLED` | règlement de `PlatformInvoice` |

`SubscriptionRenewalDue` n'a **pas** de type d'audit : c'est un signal d'ordonnancement interne,
pas un fait métier opposable.

**Rejets de webhook non audités.** Une signature HMAC invalide sur
`/api/v1/payments/webhook` n'écrit **aucune** entrée : même raisonnement qu'au §2.1 (point d'entrée
non authentifié, aucune purge disponible, aucune limitation de débit en place). Les logs
structurés existants suffisent à l'observabilité de ce cas ; seuls les **effets** (paiement
confirmé) sont audités.

**Ce que « audit renforcé » en mode dégradé signifie concrètement à cette étape (§6.3).** Vérifié
dans le code : **aucune restriction fonctionnelle n'est implémentée** pour l'état `DEGRADED` —
ADR-0008 §3 le range parmi les quatre statuts **tous fonctionnels**, et
`TenantModuleBackedAccessChecker` accorde l'accès à un abonnement `DEGRADED` comme à un `ACTIVE`.
Il n'existe donc, aujourd'hui, **rien d'autre à auditer que les transitions elles-mêmes**
(`ENTERED`/`SUSTAINED`/`REACTIVATED`), ce que cette ADR rend obligatoire. Le jour où une
restriction des « fonctions commerciales/administratives non essentielles » sera implémentée,
**chaque refus dû au mode dégradé devra produire une entrée `DENIED`** — c'est la seconde moitié de
l'exigence §6.3, tracée en résidu (§Résidus 7) plutôt qu'inventée ici sans producteur.

### 3. Modèle de l'entrée : un acteur qui peut être le système, une cible qui n'est pas toujours un utilisateur

Le §Contexte 8 rend l'extension inévitable : `SUBSCRIPTION_RENEWED` est déclenché par un
planificateur (aucun acteur humain) et porte sur un abonnement (aucun sujet utilisateur). Trois
champs sont ajoutés à `AuditEntry` et à la table :

- **`actorKind`** : `'USER_TENANT' | 'USER_PLATFORM' | 'SYSTEM'`, obligatoire. Répond au « depuis
  quel contexte » de B1 et rend filtrables les actions plateforme (§2).
- **`targetType`** : `'USER_ACCOUNT' | 'MEMBERSHIP' | 'HEALTH_FACILITY' | 'SUBSCRIPTION' | 'PAYMENT'
  | 'PLATFORM_INVOICE' | 'FACILITY_SETTINGS' | 'AUDIT_TRAIL'`, obligatoire.
- **`targetId`** : identifiant de la cible, nullable (une consultation du journal n'a pas de cible
  unique).

`actorUserId` et `subjectUserId` deviennent **nullables**, sous **contrainte `CHECK`** qui interdit
l'incohérence :

```sql
CHECK ( (actor_kind = 'SYSTEM'      AND actor_user_id IS NULL)
     OR (actor_kind <> 'SYSTEM'     AND actor_user_id IS NOT NULL) )
CHECK ( (target_type = 'USER_ACCOUNT' AND subject_user_id IS NOT NULL) OR target_type <> 'USER_ACCOUNT' )
```

**Pourquoi pas un identifiant sentinelle « utilisateur système »** (`00000000-...`), option la plus
simple : une valeur sentinelle est **indiscernable d'un vrai identifiant** pour tout lecteur, tout
filtre et toute future jointure ; elle transforme une information positive (« ceci a été fait par
le système ») en une convention que chaque appelant doit connaître et respecter. Un discriminant
explicite plus une contrainte `CHECK` rend l'invariant **vérifié par le moteur**, jamais par la
discipline.

**Ce que le journal ne contient toujours jamais** (ADR-0005 §6, reconduit sans exception et
**élargi** par cette ADR) : aucun secret, aucun code, aucun condensat de code, **aucune adresse
IP**, et — ajout explicite — **aucun jeton de session réutilisable** : le `sessionId` **est
lui-même un secret d'authentification**, au même titre qu'un refresh token, et n'est donc jamais
stocké sous une forme rejouable (mécanisme de remplacement au §3.1). Cette ADR n'ajoute
**aucune** colonne de contenu métier libre : ni `payload`, ni `oldValue`/`newValue`. Le
`ancienne valeur → nouvelle valeur` de §7.3 appartient à l'audit **médical**, hors périmètre (§1) —
l'introduire ici sans producteur ouvrirait une colonne de texte libre susceptible d'accueillir des
données personnelles sans contrôle. `reason` reste le seul champ libre, au régime déjà défini par
ADR-0005 §6.

**Migration additive stricte, sans jamais toucher une ligne existante.** Toutes les colonnes sont
ajoutées avec `ADD COLUMN ... DEFAULT` (opération de métadonnées en PostgreSQL ≥ 11, sans réécriture
de lignes) : `actor_kind` par défaut `'USER_TENANT'`, `target_type` par défaut `'USER_ACCOUNT'` —
valeurs exactes des entrées `MFA`/`SESSION` déjà écrites. **Aucun `UPDATE` n'est émis**, ce qui est
non négociable : le trigger `audit_entry_append_only` interdit toute mise à jour, y compris à
l'auteur de la migration, et il ne doit **jamais** être désactivé, même temporairement, même par
une migration. Les nouvelles valeurs d'énumération sont ajoutées par `ALTER TYPE ... ADD VALUE`,
exactement comme la migration `20260828090000_refresh_token_rotation` l'a fait pour `SESSION`, dans
une migration **qui ne les utilise pas elle-même** (restriction PostgreSQL sur l'usage d'une valeur
d'énumération dans la transaction qui la crée).

#### 3.1 `sessionRef` : une référence dérivée, jamais le jeton de session

**Le `sessionId` est un secret d'authentification, pas un identifiant technique inerte.** Ce
constat fonde tout ce paragraphe, et il doit être énoncé sans détour parce que le nom du champ
suggère exactement le contraire : le `sessionId` émis par `SessionContextIssuer` **est** le jeton
porté par `Authorization: Bearer <sessionId>` (§8). Quiconque le détient est authentifié comme son
titulaire, **MFA déjà satisfait**, pour toute la durée restante de la session. Il appartient donc à
la même famille que le refresh token, qu'ADR-0006 §4 ne stocke jamais en clair — et la même règle
doit lui être appliquée.

Le stocker tel quel dans un journal **conçu pour être lu** transformerait le mécanisme de preuve en
**mécanisme d'escalade de privilèges** : un principal détenant `audit:read` sur un tenant — y
compris via un rôle personnalisé n'ayant *que* cette permission (§9) — lirait les sessions actives
des autres utilisateurs de son établissement et les rejouerait ; un principal `PLATFORM`, dont la
supervision inter-tenant est délibérément **en lecture seule** (§6), y gagnerait une capacité
d'**usurpation avec droits d'écriture sur n'importe quel tenant** — capacité que rien dans cette
ADR n'a jamais décidée d'accorder. Aggravant décisif : B3 interdit toute purge et le trigger
append-only interdit tout `UPDATE`, donc un jeton ainsi écrit y resterait **définitivement**, hors
de portée de toute remédiation.

**Décision.** Le champ ne porte **jamais** le `sessionId`, mais une **référence dérivée non
réversible** :

```
sessionRef = "v1." + base64url( SHA-256( "audit-session:v1|" + sessionId ) )
```

- **Nom du champ** : `sessionRef` — dans le domaine, dans les ports producteurs et dans le DTO HTTP
  (§8) — jamais `sessionId`. Le nom est ici une **défense**, pas une préférence esthétique : c'est
  précisément parce que le champ s'appelait `sessionId` que sa nature de secret est passée
  inaperçue de bout en bout, de l'écriture jusqu'à la republication HTTP. Un champ dont le nom ment
  finit par être rempli avec la mauvaise valeur.
- **Colonne SQL inchangée** : `session_id` (`@map("session_id")`, `TEXT` nullable). C'est un
  **changement de valeur applicative, jamais de schéma** : aucune DDL, aucune migration Prisma,
  aucun `UPDATE`, donc aucune tension avec l'append-only (§3).
- **Un seul point de dérivation** : `AuditEntry.record()`, **seule fabrique** de l'agrégat, reçoit
  le `sessionId` brut et ne conserve que sa référence. **Aucun producteur ne dérive lui-même**
  (`identity`, `subscription`, `tenant`, `payment`, contrôleur HTTP) : dupliquer la primitive dans
  cinq modules garantirait qu'un appelant l'oublie un jour — et un oubli d'appelant est exactement
  le défaut corrigé ici. Le paramètre d'entrée reste nommé `sessionId` (il l'est réellement à cet
  instant) ; le champ résultant est `sessionRef`, ce qui rend la transformation visible à la
  lecture. `reconstitute()` reçoit la valeur **déjà dérivée** telle que persistée et ne dérive rien.
- **Le calcul passe par un port** `AuditSessionReferenceDeriver` (`audit/domain/ports/`),
  implémenté par un `Sha256AuditSessionReferenceDeriver` (`node:crypto`) — discipline **identique**
  à `AuditEntryHasher`/`Sha256AuditEntryHasher` (§5.2), jamais un `node:crypto` importé dans le
  domaine, et condition pour que les tests unitaires du domaine restent déterministes avec un
  dériveur factice. Le préfixe de domaine `"audit-session:v1|"` est **distinct** de celui du
  chaînage (`"audit-entry:v1|"`) : deux usages cryptographiques différents ne partagent jamais un
  espace de hachage.

**Pourquoi SHA-256 non clé, alors qu'ADR-0006 §4 poivre le refresh token** (`HMAC-SHA-256(pepper,
raw)`, enveloppe `v1.<pepperId>.<hmac>`) — la divergence est délibérée et tient à trois différences
de nature, pas à une simplification :

1. **Le rôle n'est pas le même.** `RefreshTokenHash` est un **vérificateur d'authentification** :
   on l'interroge (`findByHash`) pour décider si un porteur est légitime. Le poivre y protège
   contre un attaquant ayant lu la base et cherchant à **valider des hypothèses**. `sessionRef`
   n'est vérificateur de rien : **aucun code ne s'authentifie en le comparant**, et aucune lecture
   n'en dépend. La seule propriété requise est la **résistance à la préimage**.
2. **L'entropie de l'entrée suffit à elle seule.** Le `sessionId` est un `randomUUID()`
   (`UuidGenerator`, `node:crypto`) : 122 bits issus d'un CSPRNG. Ni dictionnaire, ni table
   arc-en-ciel, ni énumération ne sont concevables — le poivre n'ajouterait aucune résistance
   réelle, seulement un secret de plus à gérer et un mode de défaillance au démarrage.
3. **Argument décisif — un poivre est rotatif, un registre append-only ne l'est pas.** L'enveloppe
   `v1.<pepperId>.` d'ADR-0006 existe précisément pour rendre la rotation du poivre possible. Sur
   `RefreshToken`, une rotation est sans conséquence : les lignes sont éphémères et jetables. Sur
   `platform.AuditEntry`, B3 interdit la purge et l'append-only interdit tout `UPDATE` : les
   entrées dérivées sous `p1` ne pourraient **jamais** être re-dérivées sous `p2`. Une rotation de
   poivre **briserait silencieusement et définitivement** la corrélation de session de part et
   d'autre de la rotation — c'est-à-dire détruirait, sans aucune remédiation possible, la capacité
   de traçabilité de B1 que ce champ existe pour servir. Une dérivation **non clée** est stable
   pour la durée de vie du journal, ce qu'un registre de preuve non purgeable exige.

**Ce que `sessionRef` permet encore, et ce qu'il ne permet plus.** Il permet toujours de
**corréler entre elles** les entrées d'une même session (même valeur ⇒ même session) et de partir
d'une session **connue** pour retrouver ses entrées, en dérivant la référence : c'est exactement
l'investigation « depuis quel contexte » de B1, intégralement préservée. Il ne permet plus de
**remonter** de l'entrée vers le jeton, donc plus de rejouer quoi que ce soit. Propriété assumée et
**qui n'est pas une fuite** : quiconque détient déjà un `sessionId` pour en calculer la référence
détient déjà la session elle-même — il n'apprend rien qu'il ne sache.

### 4. Canal d'écriture : inchangé, mais la règle « jamais via l'Outbox » doit être énoncée précisément

ADR-0005 §5 reste intégralement en vigueur : l'entrée d'audit est écrite **dans la transaction de
l'action auditée**, via `resolvePrismaClient`, jamais par un consommateur Outbox.

Cette étape multiplie les producteurs et rend nécessaire une formulation que l'implémentation ne
peut pas interpréter de travers :

> **Autorisé** : un consommateur Outbox qui **exécute lui-même la commande** et **mute l'agrégat**
> (`ApplyPlanUpgradeOnPaymentSucceeded`, `StartTrialSubscriptionOnHealthFacilityCreated`,
> `GrantMembership` déclenché par la Saga) écrit son entrée d'audit **dans sa propre transaction**,
> avec l'agrégat qu'il sauvegarde. C'est exactement le régime d'ADR-0005 §5 : action et preuve
> commitent ensemble ou pas du tout.
>
> **Interdit** : un consommateur Outbox dont la **seule** fonction serait de traduire un événement
> en entrée d'audit. Il perdrait les échecs (qui n'émettent aucun événement), produirait des
> doublons (garantie *at-least-once*) et ferait dépendre la preuve de la survie du relais — les
> trois motifs d'ADR-0005 §5, mot pour mot.

**Un port par module producteur, jamais un port générique.** `subscription`, `tenant` et `payment`
déclarent chacun leur propre port sortant (`SubscriptionAuditTrail`, `ProvisioningAuditTrail`,
`BillingAuditTrail`) dans leur `application/ports/`, à union primitive dupliquée — jamais un import
du `domain/` d'`audit`. `composition-root.ts` reçoit un **adaptateur distinct par port**, catégorie
figée à la construction, dans la continuité littérale d'`AuditModuleBackedAuditTrail` et
`AuditModuleBackedSessionAuditTrail` : « un futur module qui écrirait d'autres catégories d'audit
aurait son propre adaptateur, jamais celui-ci étendu par un `if` sur l'appelant » (ADR-0005 §5,
alternative 7). `MEMBERSHIP` étant produit par `identity`, ce module reçoit un **troisième** port
dédié, jamais une extension d'`AuditTrail` (catégorie `MFA`).

### 5. Chaînage SHA-256 (B4) — ferme la dette d'ADR-0005 sans en résoudre la limite

#### 5.1 Colonnes et périmètre de chaîne

Quatre colonnes additives sur `platform.AuditEntry` :

| Colonne | Type | Rôle |
|---|---|---|
| `chain_key` | `TEXT`, **colonne générée** `GENERATED ALWAYS AS (COALESCE(tenant_id::text, 'PLATFORM')) STORED` | Périmètre de chaîne — **dérivé, jamais écrit par l'application** |
| `chain_sequence` | `BIGINT`, nullable | Position dans la chaîne (`n-1` + 1) |
| `previous_entry_hash` | `TEXT`, nullable | Empreinte de l'entrée précédente de la **même** chaîne ; `NULL` = maillon de genèse |
| `entry_hash` | `TEXT`, nullable | Empreinte de cette entrée, enveloppe `v1.<sha256-base64url>` |

**Une chaîne par périmètre d'isolation** (un tenant, ou la plateforme), et non une chaîne globale
unique. C'est l'exigence transverse du responsable technique qui tranche : une chaîne globale
obligerait tout vérificateur — y compris un `ADMIN_ETABLISSEMENT` vérifiant son propre journal — à
**lire les empreintes de lignes appartenant à d'autres tenants** pour recalculer la chaîne. Le
mécanisme d'intégrité deviendrait lui-même un chemin de lecture transversal, c'est-à-dire
exactement ce que l'exigence interdit. Bénéfice secondaire : la contention d'écriture reste bornée
au tenant.

**Contrepartie honnête** : un chaînage par périmètre ne détecte pas la suppression d'une chaîne
**entière** (toutes les entrées d'un tenant), ni celle du **dernier** maillon — aucune des deux
n'est détectée par un chaînage global non plus. `chain_sequence` n'apporte **aucune garantie
cryptographique** supplémentaire : il sert exclusivement à déterminer la queue de chaîne de façon
déterministe et à paginer le vérificateur. Il ne doit pas être présenté comme une preuve.

#### 5.2 Charge canonique hachée

```
entry_hash = "v1." + base64url( SHA-256( "audit-entry:v1|" + canonicalJson ) )
```

`canonicalJson` : JSON **sans espace**, clés **triées lexicographiquement**, `null` **explicite**
(jamais une clé omise), dates ISO-8601 **UTC à la milliseconde**, tableaux dans leur ordre
persisté. Champs inclus, **tous** : `id`, `chainKey`, `chainSequence`, `previousEntryHash`,
`category`, `eventType`, `outcome`, `tenantId`, `actorKind`, `actorUserId`, `actorRoleCodes`,
`subjectUserId`, `targetType`, `targetId`, `reason`, `sessionId`, `correlationId`, `occurredAt`.

Autrement dit : **la totalité du contenu métier de l'entrée**, plus son rattachement à la chaîne.
Le préfixe `"audit-entry:v1|"` et l'enveloppe `v1.` existent dès maintenant pour qu'un changement
d'algorithme reste additif, exactement comme `v1.<keyId>` sur `EncryptedTotpSecret` (ADR-0005 §2).
`created_at` (horodatage serveur technique) est **exclu** : il n'est pas porté par le domaine et un
vérificateur ne doit pas dépendre d'une valeur que l'application ne contrôle pas.

**Le champ `sessionId` de la charge canonique porte désormais la valeur `sessionRef` (§3.1), et sa
clé JSON reste néanmoins nommée `sessionId`.** Deux précisions que l'implémentation ne doit pas
« corriger » spontanément :

- **Structurellement, rien ne change.** Le champ reste un `string | null` haché **tel qu'il est
  persisté**. Le vérificateur (§5.4) recalcule l'empreinte à partir de la valeur stockée, quelle
  qu'elle soit : les entrées écrites avant la correction restent exactement aussi vérifiables que
  celles écrites après. La liste des 18 champs est **inchangée**.
- **La clé JSON ne doit surtout pas être renommée** en `sessionRef`. Les noms de clés de
  `canonicalJson` sont un **contrat figé par l'enveloppe `v1.`**, pas une convention de nommage
  interne : les renommer changerait l'empreinte de **toutes** les entrées déjà chaînées et les
  ferait apparaître comme **altérées** au vérificateur — une fausse alerte d'intégrité, c'est-à-dire
  précisément ce qu'un registre de preuve ne doit jamais produire. Un renommage de clé n'est
  admissible qu'au prix d'un passage en `v2` et d'un vérificateur sachant traiter les deux versions ;
  rien ici ne le justifie. Un commentaire doit le dire dans `AuditEntryCanonicalPayload.ts`.

**Où vit ce calcul.** La **sérialisation canonique** est une fonction **pure du domaine**
(`audit/domain/AuditEntryCanonicalPayload.ts`) : c'est un contrat qui ne doit jamais dériver, et sa
non-régression doit être testable sans infrastructure. Le **hachage** passe par un port
`AuditEntryHasher` (`audit/domain/ports/`), implémenté par un `Sha256AuditEntryHasher`
(`node:crypto`) — même discipline que `PasswordHasher`/`TotpService`, et condition pour que les
tests unitaires du domaine restent déterministes avec un hacheur factice.

#### 5.3 Genèse, segment pré-chaîne, concurrence

- **Genèse** : la première entrée d'une chaîne porte `previous_entry_hash = NULL` et
  `chain_sequence = 0`. C'est un état **normal et attendu**, jamais une anomalie à signaler.
- **Segment pré-chaîne** : les entrées écrites **avant** cette migration ont `entry_hash IS NULL`.
  Elles ne sont **pas** rétro-chaînées — cela exigerait un `UPDATE`, donc la suspension du trigger
  append-only (§3), c'est-à-dire l'affaiblissement de la garantie que le chaînage vient renforcer.
  Le vérificateur les **compte et les signale explicitement comme non vérifiables**, jamais ne les
  ignore en silence. En pratique, ce segment n'existe que dans les bases de développement (Phase 0
  en construction, aucune donnée de production — même constat qu'ADR-0008 §9).
- **Aucune entrée future ne peut échapper à la chaîne** : un trigger `BEFORE INSERT` refuse une
  ligne dont `entry_hash` est `NULL`. Le contrat applicatif seul ne suffirait pas — **deux défenses
  indépendantes**, comme pour l'append-only.
- **Concurrence, deux défenses également** :
  1. `pg_advisory_xact_lock(hashtext(chain_key))` pris **avant** la lecture de la queue de chaîne,
     dans la transaction de l'action auditée ; libéré au commit. Deux écritures concurrentes sur la
     même chaîne se sérialisent au lieu de forker.
  2. Index uniques rendant la fourche **impossible** même si le verrou était oublié :
     `UNIQUE (chain_key, previous_entry_hash) WHERE previous_entry_hash IS NOT NULL` et
     `UNIQUE (chain_key) WHERE entry_hash IS NOT NULL AND previous_entry_hash IS NULL`
     (une seule genèse par chaîne).
  - **Règle d'implémentation** : au plus **une** chaîne écrite par transaction. Si une action devait
    un jour auditer dans deux chaînes, les verrous doivent être pris dans l'ordre lexicographique
    des `chain_key` — faute de quoi deux transactions symétriques se bloqueraient mutuellement.

#### 5.4 Vérification

Un **query handler** `VerifyAuditChainIntegrity` (lecture seule, aucun effet de bord, §7) parcourt
une chaîne par lots bornés via `readChainSegment` et renvoie
`{ chainKey, verifiedCount, preChainCount, firstBrokenSequence | null }`. Il est **soumis au même
périmètre d'isolation que la lecture** (§9) : un principal de tenant ne peut vérifier que sa propre
chaîne.

Il n'est **pas exposé en HTTP** à cette étape (B2 : *un* endpoint minimal) et **aucun job périodique
de vérification n'est planifié** — la vérification automatisée et son alerting sont tracés en
résidu (§Résidus 4), pas construits ici : sans destinataire d'alerte défini ni procédure de réponse
à incident, un job qui échoue en silence donnerait une fausse assurance, pire que son absence.

**Limite explicitement maintenue, non résolue** (reprise mot pour mot de l'esprit d'ADR-0005) :
ce chaînage détecte une **altération applicative** — une modification, une insertion ou une
suppression faite par le rôle `sih_app` ou par l'API. Il ne protège **pas** contre un **superuser
PostgreSQL**, qui peut supprimer les triggers, modifier les lignes **et recalculer l'intégralité de
la chaîne** pour la rendre à nouveau cohérente. Seul un ancrage externe write-once fermerait cette
brèche, et B4 l'écarte explicitement pour cette V1.

### 6. Port de lecture : des méthodes de liste dédiées, **aucun `tenantId` optionnel nulle part**

`AuditEntryRepository` gagne **trois méthodes de lecture** et **aucune** méthode de mutation — le
contrat reste append-only **par lui-même**, indépendamment des contraintes SQL (doctrine des deux
défenses, déjà inscrite en tête du fichier) :

```ts
listForTenant(tenantId: TenantId, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage>;
listForPlatform(scope: PlatformAuditScope, filter: AuditEntryFilter, page: AuditPageRequest): Promise<AuditEntryPage>;
readChainSegment(chain: AuditChainKey, fromSequence: number, limit: number): Promise<readonly AuditEntry[]>;
```

Règles de forme, toutes destinées à rendre la fuite inter-tenant **non exprimable** :

- **`listForTenant` prend un `TenantId` positionnel et obligatoire**, jamais un champ de `filter`.
  Un filtre tenant **optionnel** (`tenantId?: string`) est précisément le mécanisme par lequel une
  fuite arrive : un appelant l'oublie, et la requête renvoie tout. Ici, l'oublier ne compile pas.
- **`listForPlatform` est la seule méthode autorisée à traverser les tenants**, et son périmètre est
  un **discriminant obligatoire**, sans valeur par défaut :
  `PlatformAuditScope = { kind: 'ALL' } | { kind: 'PLATFORM_ONLY' } | { kind: 'TENANT'; tenantId: TenantId }`.
  Traité par un `switch` exhaustif avec garde `never` (F-7). `PLATFORM_ONLY` filtre
  `tenant_id IS NULL` — le `null` n'est **jamais** un joker, exactement comme `findById` l'impose
  déjà (F-6).
- **`AuditEntryFilter` ne contient aucun champ de tenant.** Il porte : `categories`, `eventTypes`,
  `outcomes`, `actorKinds`, `actorUserId`, `subjectUserId`, `targetType`, `targetId`,
  `occurredFrom`, `occurredTo`.
- **Pagination par curseur** (`keyset`), jamais par `OFFSET`. Motif : sur une table append-only en
  croissance non bornée (B3 : aucune purge), l'`OFFSET` dégrade linéairement et, surtout, **saute ou
  duplique des lignes** dès qu'une écriture survient pendant la pagination — inacceptable pour un
  registre de preuve. Le curseur est un couple `(occurredAt, id)` opaque en base64url.
- **Le curseur est une position, jamais une autorisation.** Le filtre de tenant est appliqué **en
  plus** du curseur, à chaque page. Un curseur obtenu depuis une lecture plateforme et rejoué sur
  une lecture tenant ne peut donc **rien** révéler. Un test dédié l'exige (§10).
- **`limit` borné** : défaut 50, plafond 200, rejet explicite au-delà (jamais un plafonnement
  silencieux).

### 7. Query handlers CQRS — et la tension « auditer une lecture » résolue explicitement

Le module `audit` reçoit sa première couche `application/`, sur le format déjà retenu par
`GetPlatformInvoiceBySourceReference` (`{ execute(...): Promise<Result<...>> }`) — **aucun
`QueryBus` n'est introduit**, aucune infrastructure de bus n'ayant été décidée par une ADR.

```
application/queries/ListAuditEntries.ts        → ListAuditEntriesHandler
application/queries/VerifyAuditChainIntegrity.ts → VerifyAuditChainIntegrityHandler
application/commands/RecordAuditAccess.ts      → RecordAuditAccessHandler
```

**`AuditReadPrincipal`, type possédé par le module `audit`** :

```ts
type AuditReadPrincipal =
  | { readonly kind: 'PLATFORM'; readonly actorUserId: string }
  | { readonly kind: 'TENANT'; readonly actorUserId: string; readonly tenantId: string;
      readonly roleCodes: readonly string[]; readonly permissionCodes: readonly string[] };
```

`audit` **n'importe jamais** `ServerContext` (module `identity`) : c'est `composition-root.ts`, seul
point du code autorisé à connaître deux modules, qui traduit l'un vers l'autre — même règle que
`AuditModuleBackedAuditTrail` et `TenantModuleBackedAccessChecker`.

**Le handler de liste ne reçoit jamais un `tenantId` fourni par le client.** Pour un principal
`TENANT`, le `tenantId` utilisé est **celui du principal**, point. Si la requête HTTP porte
néanmoins un paramètre de périmètre, elle est **rejetée** (§8) — jamais ignorée silencieusement.

**Tension CQRS assumée et résolue, pas contournée.** Tracer « qui a consulté le journal » est une
**écriture**, et [§6.1](../01-target-architecture.md) interdit tout effet de bord dans une query.
La résolution retenue : `ListAuditEntriesHandler` **reste pur** (aucune écriture), et la trace est
produite par une **commande distincte**, `RecordAuditAccess`, dans sa propre transaction courte,
invoquée par la couche de présentation **avant** la lecture :

- accès autorisé → `AUDIT_ACCESS` / `AUDIT_TRAIL_QUERIED` / `SUCCESS` ;
- accès refusé (permission absente, périmètre d'un autre tenant demandé) →
  `AUDIT_ACCESS` / `AUDIT_TRAIL_QUERY_DENIED` / `DENIED`, **écrite avant** tout accès aux données,
  et la lecture n'a jamais lieu.

C'est le refus qui a le plus de valeur probante : une tentative de lecture transverse laisse une
trace permanente, dans la chaîne du tenant de l'acteur.

**Conséquence de volume à assumer** : chaque page consultée écrit une entrée. Combinée à B3
(aucune purge), la consultation intensive du journal fait croître le journal. C'est acceptable et
volontaire à ce stade — c'est signalé en dette (§Dette assumée).

### 8. Le premier endpoint HTTP authentifié du dépôt — traité comme tel

**Un seul endpoint** est ajouté :

```
GET /api/v1/audit-entries
Authorization: Bearer <sessionId opaque>
```

Paramètres : `category`, `eventType`, `outcome`, `actorKind`, `actorUserId`, `subjectUserId`,
`targetType`, `targetId`, `from`, `to`, `cursor`, `limit`, et — **pour un contexte `PLATFORM`
uniquement** — `scope` (`all` | `platform` | `tenant`) et `tenantId`.

Réponses, sans aucun détail interne (§3.3, régime déjà appliqué par `PaymentWebhookController` et
`createErrorHandler`) : `200` `{ entries, nextCursor }` · `400 {"error":"invalid_request"}` ·
`401 {"error":"unauthenticated"}` · `403 {"error":"forbidden"}` ·
`403 {"error":"mfa_required"}` · `500 {"error":"internal_error"}`.

**Ce endpoint est le premier de son espèce dans ce dépôt** (§Contexte 6). Il reçoit donc le même
niveau de rigueur que `ServerContextResolver.resolve()` a reçu pour l'accès applicatif, et
**strictement rien de plus** que ce que l'étape exige :

1. **Aucune logique métier dans le contrôleur.** Il valide sa requête (zod), délègue à
   `RecordAuditAccess` puis `ListAuditEntries`, et sérialise un **DTO explicite** — jamais l'agrégat
   `AuditEntry`, jamais une ligne Prisma. Le DTO expose **`sessionRef`** (§3.1) et **jamais** un
   `sessionId` : cette republication était le dernier maillon du défaut corrigé — un jeton de
   session vivant quittait le serveur dans une réponse HTTP de lecture. `docs/api/openapi.yaml` doit
   refléter ce nom et cette sémantique (« référence dérivée non réversible, non rejouable »).
2. **Un middleware unique `requireAuthenticatedContext`, construit dans le composition-root** (seul
   endroit autorisé à connaître `identity` et `audit`). Il lit le `sessionId`, appelle
   `ServerContextResolver.resolve(sessionId, correlationId)` — **le point de passage obligatoire
   existant, jamais un second chemin de résolution** — et traduit :
   `SESSION_NOT_FOUND` → `401` ; `MFA_REQUIRED` → `403 mfa_required` ; succès → principal attaché.
   Une session `MFA_PENDING` ne peut donc **structurellement** pas lire le journal : elle ne produit
   aucun `ServerContext`.
3. **Transport du `sessionId` : en-tête `Authorization: Bearer`, pas un cookie.** Choix délibéré et
   minimaliste : un cookie imposerait de trancher immédiatement `SameSite`, `Secure`, domaine,
   durée **et une stratégie anti-CSRF**, c'est-à-dire une décision de sécurité transversale qui
   dépasse largement l'étape 11 et qui appartient à l'arrivée du frontend. Un jeton opaque porté
   par un en-tête est **immunisé contre le CSRF par construction** et n'engage aucune de ces
   décisions. Ce choix est **explicitement révisable** quand `apps/web` arrivera (§Résidus 5) ; le
   contrat de l'endpoint ne changerait pas, seul le middleware serait étendu.
4. **Aucune limitation de débit n'est ajoutée ici.** La dette de transport d'ADR-0005
   (anti-énumération, *rate limiting*) reste ouverte et concerne l'ensemble des futures routes —
   l'ouvrir sur cette seule route produirait une politique locale divergente. Signalé en dette.
5. **Le paramètre `tenantId`/`scope` est rejeté (`400`) pour un contexte `TENANT`**, jamais ignoré.
   Un paramètre silencieusement ignoré est indistinguable, côté client, d'un paramètre honoré — et
   c'est exactement le malentendu par lequel une fuite se croit prouvée absente.

### 9. Permissions : `audit:read` ajouté à `ADMIN_ETABLISSEMENT`, et le constat sur `platform-audit:read`

**Extension additive du catalogue** (`SystemRoleCatalog.ts`), dans la continuité littérale de
l'ajout de `mfa:reset` à l'étape 7 :

- `ADMIN_ETABLISSEMENT` reçoit **`audit:read`**. Nom retenu : la ressource `audit` (et non
  `platform-audit`) **encode le périmètre dans le nom lui-même** — `audit:read` est
  tenant-scopée, `platform-audit:read` est plateforme. Deux codes distincts pour deux portées
  distinctes, jamais une même permission dont la portée dépendrait du contexte d'appel.
- La ressource **`audit` est ajoutée à `TENANT_ADMIN_RESOURCES`** (`MfaPolicy.ts`) : quiconque
  détient `audit:read` — y compris via un **rôle personnalisé** d'établissement — est
  lui-même soumis au MFA. C'est l'application directe du point d'escalade que ce fichier documente
  (« à faire valider par l'architecte dès qu'un module ultérieur introduit une nouvelle ressource
  sensible ; en cas de doute, le choix retenu est d'inclure »). `ADMIN_ETABLISSEMENT` y était déjà
  soumis ; l'ajout couvre les rôles personnalisés futurs.

**Constat structurel sur `platform-audit:read`** (§Contexte 5, à ne pas contourner par un
raccourci) : cette permission **n'est jamais matérialisée dans aucune session**, un `SUPER_ADMIN`
n'ayant ni membership ni `permissionCodes` dans `PlatformSessionContext`. L'autorisation du
périmètre plateforme est donc dérivée de ce qui est **réellement prouvé côté serveur** : un
`ServerContext` de kind `PLATFORM` n'est émis par `SessionContextIssuer.resolveMaterials()` que si
`account.isSuperAdmin()` — sans quoi `NOT_SUPER_ADMIN`. `principal.kind === 'PLATFORM'` **est** la
preuve du statut `SUPER_ADMIN`.

`platform-audit:read` **reste au catalogue à titre documentaire** (elle décrit l'intention du rôle
et alimente `PERMISSION_CATALOG_CODES`) mais **ne doit être testée dans aucun code d'autorisation** :
une vérification `permissionCodes.includes('platform-audit:read')` refuserait systématiquement tout
`SUPER_ADMIN`, et un développeur pressé « corrigerait » ce refus en injectant des permissions dans
la session plateforme — c'est-à-dire en ouvrant précisément la brèche qu'ADR-0005 §4 a fermée
structurellement. Un commentaire explicite doit le dire dans `SystemRoleCatalog.ts`.

### 10. Garde-fou d'isolation à **trois niveaux**, sur PostgreSQL réel

Exigence transverse du responsable technique, non négociable : *le système d'audit ne doit jamais
devenir un moyen de contourner l'isolation multi-tenant*. `auditEntryTenantIsolation.test.ts` ne
couvre aujourd'hui que le **repository** (et uniquement `findById`). Les trois niveaux sont exigés,
tous avec **PostgreSQL réel** (`docker compose up -d`, migrations appliquées), **jamais un mock** :

| Niveau | Fichier | Ce qui doit être prouvé |
|---|---|---|
| **Repository** | `test/audit/integration/auditEntryTenantIsolation.test.ts` (**étendu**) | `listForTenant(A)` ne renvoie **jamais** une ligne de B, ni une ligne plateforme ; `listForPlatform({kind:'PLATFORM_ONLY'})` ne renvoie **jamais** une ligne tenant ; un curseur issu d'une page de B, rejoué sur `listForTenant(A)`, ne révèle **rien** de B ; le bloc « absence de RLS » existant est conservé tel quel |
| **Query handlers** | `test/audit/integration/auditQueryIsolation.test.ts` (**nouveau**) | Un principal `TENANT` de A demandant explicitement B → `Result.failure('FORBIDDEN')` **et** une entrée `AUDIT_TRAIL_QUERY_DENIED` écrite ; un principal `TENANT` sans `audit:read` → refus ; `VerifyAuditChainIntegrity` refuse la chaîne d'un autre tenant |
| **HTTP** | `test/audit/integration/auditHttpIsolation.test.ts` (**nouveau**) | Session A + `?tenantId=B` → `400`, corps ne contenant **aucune** donnée de B ; session A → seules les entrées de A, quel que soit le jeu de paramètres ; session `PLATFORM` → A et B visibles ; **aucun** en-tête `Authorization` → `401` ; session `MFA_PENDING` → `403 mfa_required` et aucune donnée |

**Tests d'intégrité de la chaîne** (`auditChainIntegrity.test.ts`, nouveau) : chaîne complète
vérifiée verte ; ligne altérée **via le rôle superuser `sih`** (le seul capable de contourner
trigger et `REVOKE`) → `firstBrokenSequence` pointe l'entrée attendue — ce test **démontre à la fois
la valeur et la limite** du §5.4 ; deux écritures concurrentes sur la même chaîne → aucune fourche,
séquence contiguë ; entrées pré-chaîne comptées et signalées, jamais ignorées.

**Test de non-réutilisabilité de la référence de session** (`auditSessionReferenceRedaction.test.ts`,
nouveau — §3.1). Trois assertions, dont la dernière est la seule qui prouve réellement la propriété
recherchée et doit être écrite telle quelle :

1. après une ouverture de contexte (`SESSION_CONTEXT_OPENED`) et un rafraîchissement, **aucune**
   entrée persistée ne contient le `sessionId` réel — vérifié **en base** (colonne `session_id`)
   **et** dans le corps de la réponse HTTP du §8 ;
2. la valeur lue **est égale** à la dérivation du `sessionId` connu — la corrélation exigée par B1
   est donc bien préservée, et deux entrées d'une même session portent bien la même référence ;
3. **la valeur lue, rejouée en `Authorization: Bearer`, produit `401`** — jamais `200`.

**`rlsGuard.test.ts` reste inchangé** : cette étape n'introduit **aucune nouvelle table plateforme**
(seulement des colonnes sur `AuditEntry`, déjà en liste blanche). Il doit néanmoins rester vert —
c'est la preuve qu'aucune table n'a été ajoutée en catimini.

Enfin, `auditEntryImmutability.test.ts` doit être **étendu** au nouveau trigger `BEFORE INSERT` :
une insertion sans `entry_hash` est refusée.

### 11. Ce que l'étape 11 ne fait pas

- **Aucune purge, aucune rétention, aucun cron, aucune durée en dur** (B3). O-15 reste **ouvert**,
  décideur Juridique. Aucune constante de durée ne doit apparaître dans le code, même « désactivée
  par défaut » — voir alternative écartée n° 3.
- **Aucune interface graphique** (B2). Le frontend consommera les contrats du SaaS Core ; il ne les
  précède pas (`02-roadmap-migration.md`).
- **Aucun audit médical** (§1), **aucun ancrage externe write-once** (B4), **aucun job périodique de
  vérification** (§5.4), **aucune limitation de débit HTTP** (§8.4).

---

## Alternatives écartées

| # | Alternative | Motif du rejet |
|---|---|---|
| 1 | **Arbre de Merkle** au lieu d'un chaînage linéaire | Le Merkle sert à prouver l'**inclusion** d'un élément dans un ensemble **sans le divulguer entièrement** — un besoin de tiers vérificateur externe qui n'existe pas ici (le vérificateur est l'application, qui lit déjà tout). Il exige en contrepartie de recalculer des nœuds internes à chaque insertion, donc de **modifier des lignes existantes** sur une table dont l'append-only est garanti par trigger : incompatible avec l'invariant central du module (§3/§5.3) |
| 2 | **Ancrage externe write-once dès la V1** (S3 Object Lock, service d'horodatage, registre tiers) | Écarté par B4. C'est la **seule** mesure qui fermerait la brèche superuser (§5.4), mais elle introduit une dépendance externe, un coût opérationnel et un mode de défaillance (ancrage indisponible : bloque-t-on l'écriture d'audit, donc l'action métier ?) sans qu'aucune exigence datée ne la réclame. Réévaluable si le rapport coût/risque évolue |
| 3 | **Implémenter une purge « désactivée par défaut »** plutôt que ne rien implémenter | Du code de suppression **existant** sur un registre append-only n'attend qu'une variable d'environnement pour effacer des preuves — et il faudrait inventer une durée par défaut, donc préempter O-15, dont le décideur est le Juridique et le cadre réglementaire sénégalais des données de santé explicitement non présumé. Cohérent avec la discipline du dépôt : aucune valeur numérique n'est inventée en silence (ADR-0005 §Résidus, ADR-0006 §3) |
| 4 | **Étendre `findById`** (filtres optionnels, `tenantId` nullable élargi) plutôt qu'ajouter des méthodes de liste dédiées | Transformerait une méthode dont le filtrage tenant est **obligatoire et positionnel** (correctif F-6) en une méthode à paramètres optionnels — c'est-à-dire réintroduirait exactement la forme d'API par laquelle une fuite inter-tenant devient possible par simple omission. Une méthode de liste porte en outre des préoccupations (pagination, tri, bornes) qui n'ont aucun sens sur une lecture par identifiant (ISP) |
| 5 | **Interface graphique d'administration** à cette étape | Écartée par B2. La console exige d'abord des contrats stables (port, query handlers, DTO, endpoint) ; les construire depuis une UI conduirait à figer des contrats dictés par un écran. Le frontend consomme les contrats du SaaS Core, il ne les précède pas |
| 6 | **Chaîne d'empreintes globale unique** (tous tenants confondus) | Obligerait tout vérificateur, y compris tenant-scopé, à lire les empreintes d'autres tenants : le mécanisme d'intégrité deviendrait lui-même un chemin de lecture transversal, en contradiction directe avec l'exigence transverse (§5.1) |
| 7 | **Identifiant sentinelle « utilisateur système »** pour les actions sans acteur humain | Une sentinelle est indiscernable d'un identifiant réel pour tout lecteur et tout filtre ; le discriminant `actorKind` + `CHECK` fait vérifier l'invariant par le moteur plutôt que par la discipline de chaque appelant (§3) |
| 8 | **Catégorie `PLATFORM_ADMIN`** pour tracer les actions `SUPER_ADMIN` | Créerait deux catégories possibles pour un même fait (une action de `SUPER_ADMIN` sur un abonnement), rendant l'écriture ambiguë et la recherche incomplète. `actorKind = 'USER_PLATFORM'` répond au besoin transversalement, sans énumération sans producteur (§2) |
| 9 | **Auditer les rejets de webhook et les échecs de connexion sur identifiant inconnu** | Points d'entrée **non authentifiés** écrivant des lignes définitives dans une table qu'aucun mécanisme ne peut purger (B3), sans limitation de débit disponible : vecteur de saturation auto-infligé. Exigerait de surcroît de stocker l'identifiant tenté, contre la minimisation d'ADR-0005 §6 (§2.1) |
| 10 | **Écrire l'audit des modules métier depuis des consommateurs Outbox dédiés** | Perd les échecs, autorise les doublons, rend la preuve dépendante du relais — les trois motifs d'ADR-0005 §5, inchangés. Un consommateur qui **exécute** la commande écrit, lui, dans sa propre transaction : c'est autorisé et distinct (§4) |
| 11 | **Écrire la trace de consultation depuis le query handler de lecture** | Un effet de bord dans une query, interdit par §6.1. La commande `RecordAuditAccess`, distincte et invoquée avant la lecture, préserve la pureté de la query **et** garantit que le refus est tracé avant tout accès aux données (§7) |
| 12 | **Cookie de session** pour le premier endpoint authentifié | Imposerait de trancher immédiatement `SameSite`/`Secure`/domaine **et** une stratégie anti-CSRF — décisions transversales appartenant à l'arrivée du frontend, sans rapport avec l'audit. Le jeton opaque en en-tête est immunisé contre le CSRF par construction (§8.3) |
| 13 | **Conserver le `sessionId` brut** et se contenter d'en restreindre la lecture (masquage au DTO, permission dédiée) | Laisserait un **jeton vivant** en base, et **définitivement** : B3 interdit la purge, l'append-only interdit l'`UPDATE`. La sécurité reposerait alors sur la discipline de **chaque futur chemin de lecture** — un export (résidu O-15), une requête d'exploitation, un second endpoint le republieraient. Une donnée qu'on ne doit jamais lire ne doit pas être écrite (§3.1) |
| 14 | **HMAC-SHA-256 poivré**, calque littéral d'ADR-0006 §4 | Le poivre protège un **vérificateur** interrogeable contre la validation d'hypothèses ; `sessionRef` n'authentifie rien et son entrée fait déjà 122 bits de CSPRNG. Surtout, un poivre est **rotatif** alors que le journal est append-only et non purgeable : une rotation briserait définitivement la corrélation de session, sans re-dérivation possible sur des lignes immuables (§3.1) |
| 15 | **Nouvelle colonne `session_ref`**, en laissant `session_id` en place | Exigerait une migration pour n'apporter **aucune** propriété supplémentaire, et **laisserait dans la table la colonne contenant les jetons vivants** : cela ne corrigerait rien. Le correctif est un changement de **valeur applicative**, pas de schéma (§3.1) |
| 16 | **Supprimer purement et simplement le champ de session** | Fermerait le défaut, mais supprimerait la traçabilité « depuis quel contexte » exigée par B1 : plus aucun moyen de rattacher entre elles les entrées d'une même session lors d'une investigation. La dérivation **conserve la capacité et retire le pouvoir** — c'est le seul compromis qui satisfait les deux exigences (§3.1) |

---

## Conséquences

**Acquis**

- Les actions sensibles du SaaS Core deviennent **traçables de bout en bout** : connexion,
  ouverture et refus de contexte, provisionnement, memberships, abonnements (mode dégradé compris),
  paiements, et consultation du journal lui-même — chacune répondant aux six questions de B1.
- La lacune la plus grave constatée au §Contexte 3 est fermée : **la connexion elle-même est
  auditée**, alors qu'elle ne l'était pas malgré l'existence de la catégorie `SESSION`.
- La **dette « aucun chaînage par empreinte » d'ADR-0005 est fermée** : toute altération
  applicative d'une entrée — modification, insertion intercalée, suppression intermédiaire — est
  détectable, chaîne par chaîne, sans jamais lire les données d'un autre tenant.
- Le journal devient **consultable** par des contrats stables (port → query handlers → DTO →
  endpoint), sur lesquels un frontend pourra se brancher sans qu'aucun de ces contrats n'ait été
  dicté par un écran.
- **`platform-audit:read` cesse d'être une permission morte** : son statut réel (documentaire, non
  matérialisable) est établi et écrit, au lieu de rester un piège pour le prochain développeur.
- L'isolation inter-tenant est prouvée **à trois niveaux** sur PostgreSQL réel, là où une seule
  couche l'était.
- Le premier endpoint HTTP authentifié du dépôt existe, **réutilisant** le point de passage
  obligatoire `ServerContextResolver` plutôt qu'en créant un second chemin de résolution.
- Le journal **cesse d'être lui-même un vecteur d'escalade de privilèges** (§3.1) : la référence de
  session qu'il porte et republie n'est plus rejouable, la corrélation d'investigation exigée par B1
  restant entière. La règle de minimisation d'ADR-0005 §6 est désormais énoncée pour ce qu'elle
  doit couvrir — **un identifiant qui sert de jeton est un secret**, quel que soit son nom.

**Dette assumée**

- **Croissance non bornée du volume.** B3 exclut toute purge : le journal croît indéfiniment tant
  qu'O-15 n'est pas clos. Deux nouveaux contributeurs s'y ajoutent — l'élargissement de la
  couverture (§2) et l'audit de la consultation elle-même (§7, une entrée par page lue). Aucun seuil
  de supervision de volume n'est posé. **Dette opérationnelle réelle**, à réévaluer dès que la
  volumétrie sera observable.
- **Aucune protection contre un superuser PostgreSQL** (§5.4). Le chaînage détecte l'altération
  applicative ; il ne survit pas à un acteur capable de reconstruire la chaîne. Inchangé depuis
  ADR-0005, désormais explicité.
- **Contention d'écriture par chaîne.** Le verrou consultatif (§5.3) sérialise les écritures
  d'audit d'un même tenant. Sur un tenant très actif, cela borne le débit des actions auditées.
  Acceptable en Phase 0, à mesurer.
- **Segment pré-chaîne non vérifiable** (entrées antérieures à la migration) — en pratique limité
  aux bases de développement, jamais rétro-chaîné par principe.
- **Entrées de développement portant encore un `sessionId` brut** (§3.1). Les entrées écrites
  **avant** cette correction conservent le jeton en clair dans la colonne `session_id`. Elles ne
  sont **ni purgées, ni mises à jour** : **même régime que le segment pré-chaîne** ci-dessus, et
  pour la même raison — un `UPDATE` rétroactif exigerait de suspendre le trigger append-only (§3),
  c'est-à-dire d'affaiblir la garantie que toute cette section sert à protéger. Le risque résiduel
  est nul en pratique : il s'agit exclusivement de sessions de **bases de développement** (Phase 0
  en construction, **aucune donnée de production n'a jamais existé** — même constat qu'ADR-0008 §9),
  toutes déjà expirées côté Redis, dont la TTL est bornée par `absoluteExpiresAt` (ADR-0006 §5) et
  dont la base sera repartie de zéro. Aucun `UPDATE`, aucune purge, aucune exception au contrat
  append-only n'est autorisée pour cette dette — **c'est la dette qui est acceptée, jamais
  l'invariant qui plie**.
- **Aucune limitation de débit sur l'endpoint** (§8.4), la dette de transport d'ADR-0005 restant
  ouverte pour l'ensemble des routes.
- **Aucune vérification périodique automatisée** de l'intégrité (§5.4) : la vérification existe mais
  doit être déclenchée.
- **Aucun export** du journal (CSV/archivage) : hors périmètre, et lié à O-15 (« modalités d'export
  des données », O-03.3).

**Résidus**

*Résidus d'ADR-0005 — statut établi explicitement, aucun n'est fermé par omission :*

1. **Valeurs numériques de limitation d'essais MFA** (seuil d'échecs, durée de verrouillage) —
   **sans rapport avec l'audit**, **reste ouvert**, à traiter ailleurs.
2. **Nombre de codes de récupération MFA et fenêtre de session `MFA_PENDING`** — **sans rapport**,
   **reste ouvert**.
3. **Procédure opérationnelle de récupération pour `ADMIN_ETABLISSEMENT`** — processus humain, sans
   rapport avec cette ADR technique, **reste ouvert**.
4. **Procédure *break-glass* pour `SUPER_ADMIN`** — **sans rapport**, **reste ouvert**, nécessite
   une décision humaine hors code. Rappel : un `SUPER_ADMIN` verrouillé le demeure ; cette ADR
   n'introduit **aucun** contournement, et l'endpoint d'audit n'en est pas un (il exige un
   `ServerContext`, donc un MFA satisfait).
5. **WebAuthn/Passkey différé** — **sans rapport**, **reste ouvert**.

> Le **seul** résidu/dette d'ADR-0005 traité ici est le **chaînage par empreinte sur `AuditEntry`**
> (§Dette assumée d'ADR-0005), **fermé par le §5** — avec la limite superuser PostgreSQL
> **explicitement maintenue, non résolue**.

*Résidus propres à cette ADR :*

1. **O-15 — rétention, purge, archivage, volumétrie et cadre réglementaire sénégalais applicable aux
   données de santé.** Reste **entièrement ouvert**, décideur **Juridique**. Aucune durée, aucun
   mécanisme, aucune constante n'est introduite par cette ADR.
2. **Seuil de supervision du volume d'audit** — aucune alerte n'existe sur la croissance de
   `platform.AuditEntry`. Même famille que les résidus de supervision d'ADR-0007 (F10/F11) et
   d'ADR-0008 (résidu 4).
3. **Stratégie de rotation/archivage à froid** si le volume devient problématique **avant** la
   clôture d'O-15. Contrainte non négociable de conception : toute solution devra **déplacer sans
   altérer** (le chaînage et l'append-only doivent survivre à l'archivage), jamais supprimer.
4. **Vérification périodique automatisée de l'intégrité et destinataire de l'alerte** — le
   mécanisme existe (§5.4), son déclenchement et sa réponse à incident non.
5. **Transport définitif du `sessionId`** (en-tête Bearer vs cookie, politique CSRF associée) — à
   trancher à l'arrivée d'`apps/web`. Le contrat de l'endpoint n'en dépend pas ; seul le middleware
   serait étendu.
6. **Catégorie `TENANT_CONFIG` / type `TENANT_CONFIG_UPDATED`** — à ajouter **additivement** dès
   qu'une commande de modification de configuration d'établissement existera (§2). Aucune commande
   de ce type n'existe aujourd'hui.
7. **Audit des refus liés au mode dégradé** — la restriction des fonctions non essentielles exigée
   par §6.3 n'est **pas implémentée** dans le dépôt ; dès qu'elle le sera, chaque refus devra
   produire une entrée `DENIED`. La moitié « transitions » de l'audit renforcé est livrée ici, la
   moitié « refus » ne peut pas l'être (§2.2).
8. **Traçabilité des actions plateforme sans commande** (administration de `Plan`/`PlanPrice`,
   suspension d'établissement, administration de `UserAccount`) : aucune commande n'existe, donc
   aucun type d'audit n'est déclaré. À traiter avec ces commandes, jamais par anticipation.
9. **`platform.RefreshToken.session_id` porte lui aussi le `sessionId` en clair.** Constat posé ici
   pour qu'il ne se perde pas, **pas** une décision de cette ADR : contrairement au journal, cette
   colonne n'est exposée par **aucun chemin de lecture** (aucun endpoint, aucune query, aucun DTO),
   le défaut corrigé au §3.1 n'y a donc pas d'équivalent exploitable aujourd'hui. À réexaminer
   **avant** qu'une console d'administration des sessions ou un export ne soit exposé. Hors
   périmètre de cette ADR, qui ne rouvre pas ADR-0006.

---

## Gate pour l'agent d'implémentation

Brief à donner tel quel, sans reformulation qui en élargirait la portée :

> Ne rien inventer concernant la rétention ou la purge : **aucun** code de suppression, **aucune**
> durée, **aucun** cron, même désactivé (B3, O-15 ouvert, décideur Juridique). Ne construire
> **aucune** interface graphique (B2). Ne pas ajouter d'ancrage externe (B4). Ne pas toucher au
> périmètre médical (§1). Étendre le module `audit` **additivement** : nouvelles catégories et
> types d'événement (§2), champs `actorKind`/`targetType`/`targetId` avec contraintes `CHECK` (§3),
> chaînage SHA-256 par périmètre (§5), méthodes de **lecture** au port (§6) — **aucune** méthode de
> mutation, à aucun niveau. La migration doit être **strictement additive** : aucun `UPDATE` sur
> `platform.AuditEntry`, et le trigger append-only ne doit **jamais** être désactivé, même
> temporairement. Écrire l'audit **dans la transaction du handler qui mute l'agrégat** ; un
> consommateur Outbox dont la seule fonction serait d'écrire de l'audit est **interdit** (§4). Un
> port d'audit **par module producteur**, un adaptateur **par port** dans `composition-root.ts` —
> jamais un adaptateur générique avec un `if` sur l'appelant. Ne **jamais** introduire de paramètre
> `tenantId` optionnel, dans aucune signature (§6). Ne **jamais** tester
> `permissionCodes.includes('platform-audit:read')` : cette permission n'est matérialisée dans
> aucune session — l'autorisation plateforme est `principal.kind === 'PLATFORM'` (§9). Un seul
> endpoint HTTP, réutilisant `ServerContextResolver.resolve()` — jamais un second chemin de
> résolution de contexte (§8). **Ne jamais écrire un `sessionId` de session vivante dans une
> `AuditEntry`** : le champ s'appelle `sessionRef` et ne porte qu'une dérivation SHA-256 calculée
> **dans `AuditEntry.record()` et nulle part ailleurs** (§3.1) — jamais chez un producteur, jamais
> republiée telle quelle par le DTO. Cette correction ne crée **aucune** migration : la colonne
> `session_id` est inchangée, c'est une valeur applicative qui change, et **aucun `UPDATE`
> rétroactif** n'est émis sur les entrées existantes. Ne **pas** renommer la clé `sessionId` de la
> charge canonique (§5.2) : cela invaliderait toutes les empreintes déjà calculées. Mettre à jour
> `docs/api/openapi.yaml` en conséquence. Les trois niveaux de test d'isolation (§10) s'exécutent sur
> **PostgreSQL réel**, jamais sur des mocks. Lire ADR-0001 à ADR-0009 et les contrats existants
> avant toute modification. Toute décision non couverte par cette ADR (résidus ci-dessus) doit être
> remontée, jamais devinée.

## Tests attendus (critère de sortie de l'étape, en complément de `02-roadmap-migration.md`)

- Isolation à trois niveaux, PostgreSQL réel : les quatre lignes du tableau §10, sans exception.
- Curseur de pagination issu du périmètre plateforme, rejoué sur une lecture tenant → aucune donnée
  d'un autre tenant, jamais une erreur 500.
- `?tenantId=<autre tenant>` avec une session tenant → `400`, **et** entrée
  `AUDIT_TRAIL_QUERY_DENIED` écrite dans la chaîne du tenant de l'acteur.
- Session `MFA_PENDING` sur l'endpoint → `403 mfa_required`, aucune donnée, aucune transaction
  ouverte (même garantie que `mfaSessionGate.test.ts`).
- Chaîne : genèse correcte ; ligne altérée via le rôle superuser `sih` → rupture localisée à la
  bonne séquence ; écritures concurrentes sur une même chaîne → aucune fourche, séquence contiguë ;
  entrées pré-chaîne comptées et signalées.
- Insertion sans `entry_hash` → refusée par le trigger `BEFORE INSERT`
  (`auditEntryImmutability.test.ts` étendu).
- **Aucune entrée ne contient de jeton de session rejouable** (§3.1/§10) : la colonne `session_id`
  et le DTO HTTP ne portent jamais le `sessionId` réel ; la valeur portée **égale** sa dérivation
  (corrélation préservée) ; **rejouée en `Authorization: Bearer`, elle produit `401`**.
- Le hachage de chaîne reste vérifiable de part et d'autre de la correction : une entrée écrite
  avec l'ancienne valeur et une écrite avec `sessionRef` se vérifient **toutes deux** (§5.2), la
  clé canonique `sessionId` étant inchangée.
- `UPDATE`/`DELETE`/`TRUNCATE` toujours refusés pour `sih_app` (non-régression stricte des
  migrations `20260826150000` / `20260826160000`).
- Un échec de connexion sur un compte **existant** produit exactement **une** entrée par fenêtre de
  déduplication ; un échec sur identifiant **inconnu** n'en produit **aucune** et ne stocke aucun
  identifiant tenté.
- Entrée de catégorie `SUBSCRIPTION` produite par le planificateur : `actorKind = 'SYSTEM'`,
  `actor_user_id IS NULL`, contrainte `CHECK` satisfaite.
- Rejeu d'un consommateur Outbox qui exécute une commande déjà appliquée (ex.
  `MEMBERSHIP_ALREADY_EXISTS`, ADR-0008 §4) → **aucune** entrée d'audit dupliquée.
- `rlsGuard.test.ts` vert et **inchangé** (aucune table plateforme ajoutée).
- Non-régression complète de la suite existante.
