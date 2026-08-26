# ADR-0005 — MFA TOTP : agrégat dédié, chiffrement réversible du secret, et journal `AuditEntry` minimal

- **Statut** : **Accepté** (2026-08-26) — validé par le responsable technique, y compris le
  risque de verrouillage définitif d'un `SUPER_ADMIN` (§ Résidus 4) et les valeurs numériques
  proposées (§ Résidus 1-2), retenues comme défauts d'implémentation à confirmer ultérieurement
- **Date** : 2026-08-26
- **Décideurs** : Architecture (proposition) + responsable technique (validation attendue)
- **Contexte technique** : module `identity` (MFA) + amorce du module `audit`, Phase 0, étape 7/13
  (« MFA »)

---

## Contexte

Le périmètre **métier** du MFA est **gelé** par [O-04](../03-open-decisions.md#o-04--périmètre-du-mfa-obligatoire)
(clos structurellement le 2026-08-23) et détaillé en
[01-target-architecture.md §7.1](../01-target-architecture.md#71-authentification-et-contexte).
Cette ADR ne rouvre **aucune** de ces décisions : elle ne traite que leur **traduction technique**.

État réel du dépôt à la date de cette ADR (vérifié par lecture du code, pas supposé) :

1. Le **déclenchement** du MFA est déjà implémenté et testé
   (`modules/identity/domain/services/MfaPolicy.ts` : `requiresMfaForPlatformContext()` /
   `requiresMfaForMembership(roles)`), et déjà branché dans
   `application/commands/ResolveTenantContext.ts`, qui pose un booléen `requiresMfa` sur le
   `SessionContext`.
2. **Rien n'exploite ce booléen.** Une session pleinement utilisable — porteuse de
   `permissionCodes` — est émise même lorsque `requiresMfa === true`. Le plancher MFA est
   aujourd'hui **déclaratif, pas opposable**.
3. **Aucune donnée MFA n'existe** : ni secret, ni facteur, ni code de récupération, dans le
   domaine comme dans `prisma/schema.prisma`.
4. **`AuditEntry` n'existe nulle part**, alors qu'il est listé comme agrégat SaaS Core en
   [§6.3](../01-target-architecture.md#63-saas-core) et qu'O-04.7 en fait le réceptacle
   obligatoire de tout événement MFA. La roadmap rattache le module `Audit plateforme`
   (requêtes, rétention O-15, console) à l'**étape 11/13**.

Trois arbitrages du responsable technique encadrent cette ADR et ne sont pas rediscutés :
**WebAuthn/Passkey est différé** (hors étape 7, résidu tracé) ; **un `AuditEntry` minimal est
construit dès l'étape 7** (persistance append-only + enregistrement simple), étendu à l'étape 11 ;
le travail « Sessions avancées » (rotation de refresh-token, expirations différenciées O-06)
**reste à l'étape 8** et ne doit pas être anticipé ici.

---

## Décision

### 1. `MfaEnrollment` est un agrégat distinct, pas une extension de `UserAccount`

Un agrégat racine `MfaEnrollment` est introduit dans `modules/identity/domain/`, lié à
`UserAccount` **par identifiant uniquement** (`userId`), avec **au plus une ligne par
utilisateur** (`@@unique([user_id])`). Il porte : le facteur actif (secret TOTP chiffré), un
facteur *en attente* (ré-enrôlement), l'ensemble des codes de récupération (entités internes),
le compteur d'échecs consécutifs et le verrou temporaire.

**Pourquoi pas une extension de `UserAccount`** (option sérieusement considérée, `UserAccount`
et `MfaEnrollment` vivant tous deux dans le schéma `platform`, hors RLS) :

- **Chemin de connexion.** `AuthenticateUserHandler` charge `UserAccount` par email à **chaque**
  tentative de connexion. Y rattacher 10 codes de récupération et un secret chiffré ferait payer
  à ce chemin chaud un coût permanent pour une donnée utile à une minorité de requêtes.
- **Fréquence et nature des écritures.** Un compteur d'échecs TOTP et un anti-rejeu s'écrivent à
  chaque tentative ; l'identité (email, `passwordHash`, `platformRole`) est quasi immuable.
  Fusionner les deux, c'est mettre en contention deux rythmes d'écriture sans rapport.
- **SRP.** `UserAccount` protège l'invariant « qui est cette personne » ; `MfaEnrollment` protège
  « comment cette personne prouve un second facteur ». Deux raisons de changer, deux acteurs.
- **Cycle de vie.** Un compte existe sans MFA ; un enrôlement naît, est confirmé, est remplacé ou
  réinitialisé — sans que l'identité ne change jamais.

**Pourquoi une seule ligne par utilisateur, plutôt qu'une ligne par facteur** : le remplacement
de facteur (ré-enrôlement) doit être **atomique** — activer le nouveau et révoquer l'ancien dans
la même transaction. Avec un agrégat par facteur, ce remplacement traverserait deux agrégats, en
violation de « une transaction = un agrégat » ([§9.2](../01-target-architecture.md#92-cohérence)),
ou laisserait une fenêtre pendant laquelle un compte soumis au MFA n'aurait plus de facteur.
Modéliser « facteur courant + facteur en attente » **dans un seul agrégat** rend cette fenêtre
structurellement impossible.

**Conséquence non négociable** : l'agrégat n'expose **aucune** méthode de désactivation
(O-04.5 : « aucune désactivation silencieuse »). L'unique chemin de sortie d'un facteur actif est
`forceReEnrollment(actor, reason)`, qui exige un motif, émet un événement et **replace le compte
en état « ré-enrôlement requis »** — jamais en état « MFA non requis ».

### 2. Secret TOTP : enveloppe **AES-256-GCM** derrière un port, clé par variable d'environnement

Le secret TOTP doit être **récupérable** pour vérifier un code : le hachage à sens unique
(Argon2id, `Argon2PasswordHasher`) est structurellement inapplicable. Le chiffrement retenu est
**AES-256-GCM** (`node:crypto`, aucune dépendance nouvelle), IV aléatoire de 96 bits par
chiffrement, tag d'authentification de 128 bits, avec **liaison à l'utilisateur par AAD**
(`mfa-totp-secret:v1:<userAccountId>`) : un chiffré déplacé d'une ligne à une autre par un
attaquant disposant d'un accès en écriture à la base est **rejeté** au déchiffrement.

Format persisté, chaîne opaque unique : `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url). Le
préfixe de version et le `keyId` existent dès maintenant pour qu'une rotation de clé ou un
changement d'algorithme reste une évolution **additive**, sans migration de schéma.

Clé : `MFA_SECRET_ENCRYPTION_KEY` (base64, **exactement 32 octets** après décodage) validée par
zod dans `config/env.ts`, au même titre que `PAYMENT_PROVIDER_WEBHOOK_SECRET` — jamais dans le
dépôt (§7.1).

**Le secret en clair ne franchit jamais la frontière de l'infrastructure.** Le domaine et
l'application ne manipulent que le VO `EncryptedTotpSecret` (l'enveloppe). Le port
`TotpService` (dans `domain/ports/`, aux côtés de `PasswordHasher`) expose
`generateSecret()` et `verify(encryptedSecret, code, at)` : c'est l'**adaptateur** qui déchiffre
en mémoire, applique RFC 6238 et n'en ressort qu'un booléen. Aucun code applicatif ne peut donc
journaliser, sérialiser ou renvoyer un secret par accident.

### 3. Codes de récupération : **HMAC-SHA-256 avec poivre serveur**, pas Argon2id

Format : 10 codes de **20 caractères** en base32 Crockford (alphabet sans `I`/`L`/`O`/`U`, non
ambigu à la transcription), affichés `XXXXX-XXXXX-XXXXX-XXXXX`, soit **100 bits d'entropie** par
code, tirés d'un CSPRNG par échantillonnage sans biais de modulo.

Stockage : `HMAC-SHA-256(pepper, code_normalisé)`, poivre `MFA_RECOVERY_CODE_PEPPER` (≥ 32
caractères, environnement), enveloppe `v1.<pepperId>.<hmac>`. **Argon2id est explicitement
écarté** :

- Argon2id existe pour défendre un secret **à faible entropie choisi par un humain**. Un code
  aléatoire de 100 bits n'est pas attaquable hors ligne, poivre ou non.
- La vérification devrait comparer le code soumis à **10 hachages** successifs, soit ~0,5 à 1 s de
  CPU par tentative : un vecteur de déni de service auto-infligé sur un point d'entrée
  pré-authentifié au second facteur.
- Un HMAC **déterministe** permet la consommation à usage unique en **un seul UPDATE conditionnel
  indexé** (`WHERE enrollment_id = ? AND code_hash = ? AND consumed_at IS NULL`), atomique par
  construction — impossible avec un hachage salé par ligne.

Le poivre étant une clé secrète de 256 bits absente de la base, une compromission de la base
seule ne permet **aucune** attaque hors ligne. Nuance assumée et documentée : NIST SP 800-63B
§5.1.2.2 réserve le hachage simple aux secrets de rappel ≥ 112 bits d'entropie ; 100 bits est en
deçà, ce que compense ici le **caractère clé** (HMAC) plutôt que simplement salé du condensat.
Conséquence opérationnelle : une rotation du poivre invalide **tous** les codes en circulation et
impose une régénération pour tous les comptes enrôlés — d'où le `pepperId` dans l'enveloppe.

Consommation : usage unique strict, jamais de recharge partielle. La régénération remplace
**l'ensemble** du jeu et exige une preuve TOTP fraîche (step-up, O-06.3).

### 4. Le blocage effectif : un **état de session `MFA_PENDING`** sans aucune permission

`SessionContext` (`application/ports/SessionStore.ts`) reçoit une **troisième variante** dans son
union discriminée : `MfaPendingSessionContext`. Elle porte l'utilisateur et l'**intention déjà
validée serveur** (`PLATFORM`, ou `TENANT` + `tenantId`), et **ne porte ni `permissionCodes`, ni
`roleCodes` exploitables, ni `membershipId`**. Le blocage n'est donc pas une vérification qu'un
développeur pourrait oublier : il est **structurel** — il n'existe aucune permission à fuir dans
cet objet.

Le point de passage obligatoire `ServerContextResolver.resolve()` (déjà « le seul endroit où ce
que le client prétend devient un contexte RLS ») renvoie `Result.failure('MFA_REQUIRED')` pour
cette variante. Aucun `ServerContext` ne peut en être construit, donc aucun `UnitOfWorkContext`,
donc **aucune transaction ne s'ouvre jamais** sous une session en attente de second facteur.

Règle d'émission appliquée par un service applicatif unique (`SessionContextIssuer`), utilisé à
la fois par `ResolveTenantContext` et par `VerifyMfaChallenge` :

| `requiresMfa` (MfaPolicy, inchangé) | Enrôlement actif | Session émise |
|---|---|---|
| `true` | oui | `MFA_PENDING` · `CHALLENGE_REQUIRED` |
| `true` | non | `MFA_PENDING` · `ENROLLMENT_REQUIRED` |
| `false` | oui | `MFA_PENDING` · `CHALLENGE_REQUIRED` |
| `false` | non | session complète (comportement actuel, inchangé) |

La troisième ligne est un **choix conservateur explicite** : un facteur une fois activé est
toujours exigé, même si le rôle courant ne l'impose pas. Il applique la doctrine déjà inscrite
dans `MfaPolicy.ts` (« en cas de doute, le choix retenu est d'inclure ») et respecte O-04.2
(« renforcer, jamais abaisser »). L'absence d'enrôlement ne produit **jamais** une session
utilisable quand le MFA est exigé — le défaut est le refus.

Après validation du second facteur, les rôles et permissions sont **re-résolus depuis la base**,
jamais relus depuis la session en attente : un membership révoqué pendant la fenêtre de challenge
est ainsi détecté sans mécanisme supplémentaire.

**Ce que cette décision n'anticipe pas** (périmètre étape 8) : aucune rotation de refresh-token,
aucune chaîne de session, aucune expiration différenciée par catégorie O-06. La session
`MFA_PENDING` reçoit une **fenêtre de challenge courte** (proposition : 5 minutes), de même
nature que la TTL d'hygiène déjà documentée dans `RedisSessionStore.ts` — c'est une borne
technique, pas une politique de durée de session opposable. Conséquence assumée : un changement
d'établissement vers un contexte soumis au MFA **redemande systématiquement** le second facteur,
même si le contexte précédent l'avait déjà satisfait. C'est plus strict que la règle dérivée
d'O-05 (qui ne l'exige que si le contexte précédent ne l'imposait pas) ; mémoriser la
satisfaction du facteur au travers d'un changement de contexte suppose une **lignée de session**,
qui appartient à l'étape 8.

### 5. `AuditEntry` : schéma `platform`, écrit **dans la même transaction**, **jamais** via l'Outbox

**Schéma retenu : `platform.AuditEntry`, hors RLS, `tenant_id` nullable, filtrage tenant
purement applicatif** dans le repository, avec test d'isolation dédié — exactement le régime déjà
acté pour `Subscription`, `SubscriptionPlanChange`, `Payment` et `PlatformInvoice`
([ADR-0001 §3.3](0001-multi-tenancy-strategy.md)).

Pourquoi pas `public` avec RLS, alors que l'isolation tenant est le mécanisme par défaut du
dépôt :

- Un événement MFA en contexte `PLATFORM` (`SUPER_ADMIN`) **n'a pas de tenant**. Une table du
  schéma `public` doit satisfaire le garde-fou générique `tenant_id NOT NULL` + politique RLS
  active (`test/tenant/integration/rlsGuard.test.ts`) ; une politique RLS refuserait purement et
  simplement l'insertion d'une ligne sans `app.tenant_id` positionné. Le journal serait alors
  **muet précisément sur le rôle le plus sensible de la plateforme**.
- Contourner ce refus imposerait une politique de dérogation sur la table d'audit elle-même —
  c'est-à-dire ouvrir un trou dans le seul objet dont l'intégrité doit être hors de discussion.
- Le journal est **par nature transversal aux tenants** : la console Super Admin de l'étape 11 le
  lira pour tous les établissements. C'est le même argument, mot pour mot, que celui déjà retenu
  pour `platform.OutboxMessage` (« processus de niveau plateforme qui doit lire les messages de
  TOUS les tenants »).

Contrepartie explicite, non négociable : `AuditEntry` est ajouté à la **liste blanche consciente**
`PLATFORM_TABLES_WITHOUT_RLS` du garde-fou miroir, le repository filtre `tenant_id` sur **chaque**
méthode de lecture, et un test d'isolation dédié le prouve.

**Immuabilité** : `REVOKE UPDATE, DELETE` sur la table pour le rôle applicatif `sih_app`
(non-superuser, celui que l'application utilise réellement) **plus** un trigger
`BEFORE UPDATE OR DELETE` qui lève. Le repository n'expose que `append()` et `findById()` — aucune
méthode de mise à jour ni de suppression n'existe dans le contrat.

**Canal d'écriture : direct, dans la transaction de l'action MFA — jamais l'Outbox.** Trois
raisons, dans cet ordre :

1. **Un échec doit être audité alors qu'aucun agrégat n'est sauvegardé.** Une tentative de
   contournement (action tentée depuis une session `MFA_PENDING`) ne modifie rien : elle n'émet
   donc aucun événement de domaine et ne produirait **aucune** ligne d'Outbox. Un journal d'audit
   qui ne voit pas les échecs ne remplit pas O-04.7.
2. **Non perdable.** Un message Outbox épuisant ses 8 tentatives finit `FAILED` : acceptable pour
   une intégration, inacceptable pour une preuve. L'écriture transactionnelle garantit que
   l'action et sa preuve commitent ensemble, ou pas du tout.
3. **Pas de doublon.** La garantie *at-least-once* produirait des entrées d'audit dupliquées, à
   dédupliquer — sur un registre append-only immuable, c'est un contresens.

Sur « une transaction = un agrégat » : la règle protège les **invariants métier** d'un
étalement sur plusieurs frontières de cohérence. `AuditEntry` est une ligne **immuable, sans
invariant propre, sans contention possible, jamais mise à jour** — l'écrire dans la même
transaction n'y couple aucun invariant, cela ajoute une garantie d'atomicité. C'est exactement le
raisonnement déjà accepté dans ce dépôt pour la ligne Outbox elle-même (D9 : « persisté dans la
même transaction que l'agrégat »), qui n'est pas davantage « l'agrégat ».

Les événements `Mfa*` continuent, eux, de transiter normalement par l'Outbox : **deux canaux, deux
rôles** — l'`AuditEntry` est la **preuve** (synchrone, atomique, immuable), l'événement est le
mécanisme d'**intégration** (asynchrone, at-least-once, pour de futurs consommateurs). Interdit
explicite : ne **jamais** produire une entrée d'audit depuis un consommateur Outbox des `Mfa*`
(doublons + perte des échecs).

**Emplacement : un module `audit` distinct**, pas `identity`. L'audit sera écrit par de nombreux
modules (§7.3, étape 11) et ne peut pas appartenir à l'un d'eux. `identity` déclare donc un port
sortant `application/ports/AuditTrail.ts` à contrat primitif ; `composition-root.ts` câble
l'adaptateur qui traduit vers le module `audit` — le seul endroit du code autorisé à connaître
deux modules à la fois, exactement comme `TenantModuleBackedAccessChecker`. L'écriture rejoint la
transaction courante sans plomberie supplémentaire, via `resolvePrismaClient` (AsyncLocalStorage)
déjà utilisé par tous les repositories.

### 6. Ce que le journal ne contient jamais

Aucun secret TOTP, aucun code OTP, aucun code de récupération ni son condensat (O-04.7). Aucune
adresse IP : elle n'est pas exigée par O-04.7 (« corrélation session/device **si disponible** ») et
la minimisation prévaut — même arbitrage que le retrait d'`email` du payload de
`UserAccountCreated` à l'étape 6. Le **motif** d'un ré-enrôlement administré (texte libre, pouvant
contenir des éléments personnels) est stocké dans l'`AuditEntry` mais **pas** dans le payload de
l'événement Outbox correspondant.

---

## Alternatives écartées

| # | Alternative | Motif du rejet |
|---|---|---|
| 1 | MFA porté par `UserAccount` (VO ou entité interne) | Alourdit le chemin de connexion, mêle deux rythmes d'écriture et deux raisons de changer (§1) |
| 2 | Un agrégat par facteur MFA | Le remplacement de facteur traverserait deux agrégats, ou ouvrirait une fenêtre sans facteur (§1) |
| 3 | Secret TOTP haché (Argon2id) | Structurellement impossible : la vérification TOTP exige le secret en clair (§2) |
| 4 | Secret TOTP en clair + chiffrement au niveau volume | Un dump SQL, une sauvegarde ou un accès en lecture à la base suffirait à cloner tous les facteurs (§2) |
| 5 | Codes de récupération en Argon2id | 10 vérifications par tentative = déni de service auto-infligé, sans gain réel sur un secret de 100 bits (§3) |
| 6 | Booléen `mfaSatisfied` ajouté à la session complète existante | Une session porteuse de `permissionCodes` existerait avant la validation du facteur : un seul oubli de vérification suffirait à la rendre exploitable (§4) |
| 7 | `AuditEntry` en `public` avec RLS | Rendrait les événements MFA du contexte `PLATFORM` (sans tenant) inscriptibles uniquement via une dérogation RLS sur la table d'audit (§5) |
| 8 | `AuditEntry` écrit par un consommateur Outbox | Perd les échecs, autorise les doublons, et rend la preuve dépendante de la survie du relais (§5) |

---

## Conséquences

**Acquis**

- Le plancher MFA d'O-04 devient **opposable** : `requiresMfa === true` sans second facteur validé
  ne produit plus aucune permission, par construction du type de session.
- Aucun secret d'authentification n'est stockable en clair ni exposable hors de l'infrastructure.
- Toute action MFA — y compris les échecs et les tentatives de contournement — laisse une trace
  atomique et immuable, satisfaisant O-04.7 sans attendre l'étape 11.
- Le module `audit` démarre avec le contrat minimal exigé, extensible additivement à l'étape 11
  (requêtes, rétention O-15, console) sans réécriture de ce qui est livré ici.
- `MfaPolicy.ts` est réutilisé **tel quel** ; sa seule évolution est l'ajout de la ressource `mfa`
  à `TENANT_ADMIN_RESOURCES` — c'est-à-dire l'application du point d'escalade que ce fichier
  documente lui-même (« à faire valider par l'architecte dès qu'un module ultérieur introduit une
  nouvelle ressource sensible »), arbitrée ici par l'inclusion : détenir `mfa:reset` soumet
  soi-même au MFA.

**Dette assumée**

- **Aucun chaînage par empreinte** sur `AuditEntry`. §7.3 le prévoit pour le journal d'audit
  **médical** ; O-04.7 ne l'exige pas ici. La conséquence honnête est que l'immuabilité est
  garantie contre le rôle applicatif et contre l'API, **pas** contre un superuser PostgreSQL, qui
  pourrait supprimer le trigger. L'ajout de `previous_hash` / `entry_hash` reste une migration
  purement additive sur une table append-only — à traiter à l'étape 11.
- **Aucune rotation de clé implémentée.** Le format d'enveloppe (`v1.<keyId>`) la rend possible
  sans migration ; la procédure (re-chiffrement des enrôlements actifs) n'est pas écrite.
- **Aucun gestionnaire de secrets.** Les clés vivent en variables d'environnement, cohérent avec
  §7.1 et l'existant du dépôt ; la migration vers un KMS ne touchera que l'adaptateur.
- **Aucune couche HTTP.** Le module `identity` n'expose aujourd'hui aucune route (seul le webhook
  de paiement en a une) : l'étape 7 livre des commandes applicatives, pas des endpoints.
  L'anti-énumération et la limitation de débit au niveau transport restent à traiter avec la
  couche de présentation.
- **Ré-authentification systématique au changement d'établissement** vers un contexte soumis au
  MFA (§4) — plus strict que nécessaire, à assouplir à l'étape 8 avec la lignée de session.

**Résidus à fermer avant la fin de Phase 0** (aucun n'est tranché ici, aucune valeur n'est
inventée en silence)

1. **Valeurs numériques de la limitation d'essais** : seuil d'échecs consécutifs et durée de
   verrouillage. Le **mécanisme** est exigé par cette ADR (un code à 6 chiffres sans limitation
   d'essais est brute-forçable) ; les valeurs proposées — 5 échecs, 15 minutes — sont des défauts
   techniques alignés sur la pratique courante, **à confirmer**, au même titre que les valeurs
   numériques d'O-06.
2. **Nombre de codes de récupération** (proposition : 10) et **fenêtre de challenge** de la
   session `MFA_PENDING` (proposition : 5 minutes).
3. **Procédure de récupération pour `ADMIN_ETABLISSEMENT`** (O-04, résidu 1) : la vérification
   d'identité est un **processus humain**, hors code. La commande `ForceMfaReEnrollment` en est
   l'exécution technique, pas la procédure.
4. **Procédure *break-glass* pour `SUPER_ADMIN`** (O-04, résidu 2) — **conséquence à signaler
   explicitement au responsable technique** : avec la présente conception, un `SUPER_ADMIN` qui
   perd son facteur TOTP **et** épuise ses codes de récupération est **définitivement verrouillé**,
   aucune autorité supérieure n'existant dans l'application. C'est le prix direct de « aucune
   désactivation silencieuse » (O-04.5), et ce n'est **pas** un défaut de conception à corriger par
   une porte dérobée. Aucun contournement n'est implémenté ni prévu tant que ce résidu n'est pas
   fermé par une décision humaine.
5. **WebAuthn/Passkey** (O-04.3) : différé par arbitrage du responsable technique. Aucun modèle
   WebAuthn n'est conçu ici ; l'énumération `MfaFactorType` ne déclare **que** `TOTP` — aucune
   valeur non émise n'est introduite, conformément à la discipline déjà appliquée à
   `SubscriptionPlanChangeType` et `PlatformInvoicePurpose`.
