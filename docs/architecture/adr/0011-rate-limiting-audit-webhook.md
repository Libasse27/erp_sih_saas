# ADR-0011 — Limitation de débit des deux routes restantes : journal d'audit (authentifiée) et webhook de paiement (serveur-à-serveur)

- **Statut** : **Accepté** (2026-09-05) — les cinq arbitrages (D1 à D5) sont **rendus par le
  responsable technique**. Les trois recommandations d'architecte du §9 (modèle de données de
  l'entrée d'audit de rejet §4.2, borne d'amplification §4.3, valeurs numériques §6) ont été
  **validées telles quelles par le responsable technique le 2026-09-05**. **Amendement 1
  (2026-09-05)** : revue de sécurité indépendante de l'implémentation, 2 constats bloquants fermés
  (mode de défaillance fail-closed du webhook en cas de panne du limiteur ; levée ciblée du gel de
  `rateLimiting.test.ts`), 2 résidus ajoutés (7, 8) — voir en fin de document.
- **Date** : 2026-09-05
- **Décideurs** : Architecture (proposition) + responsable technique (D1–D5 et §9 A/B/C validés le
  2026-09-05)
- **Contexte technique** : modules `audit` et `payment`, `shared-kernel` (port `RateLimiter`,
  middleware et fichier de réglage partagés), `composition-root.ts` et `server.ts` pour le câblage —
  Phase 0, étape 12/13 (« Tests d'isolation multi-tenant/sécurité »), **item 9 des résidus** du
  sweep de sécurité (commit `649a7b6`).

---

## Contexte

État du dépôt **vérifié par lecture du code**, jamais supposé :

1. **Le mécanisme de limitation de débit existe et fonctionne** depuis ADR-0010 §8 (+ Amendement 1,
   BLOQUANT-3/AC-B) : port `shared-kernel/domain/ports/RateLimiter.ts`, implémentation
   `shared-kernel/infrastructure/RedisRateLimiter.ts` (script Lua unique `INCR` + `EXPIRE`, aucune
   clé possible sans TTL, auto-réparation d'une clé sans TTL), factory
   `shared-kernel/infrastructure/RateLimitMiddleware.ts` (garde de construction sur
   `maxRequests`/`windowSeconds`, réponse `429 {"error":"too_many_requests"}` + `Retry-After` égal à
   la durée **nominale** de la fenêtre), réglages isolés dans
   `shared-kernel/domain/RateLimitTuning.ts` (marqués **non définitifs**), câblage unique dans
   `composition-root.ts` (trois appels de la même factory), montage en **premier** middleware de
   chaque route dans `server.ts`. **Rien de tout cela n'est à réinventer : cette ADR réutilise.**
2. **Ce mécanisme ne couvre que cinq routes** — les cinq surfaces **pré-authentification**
   d'ADR-0010. Les deux routes restantes du dépôt susceptibles d'être martelées ne sont **pas
   couvertes** :
   - `GET /api/v1/audit-entries` (`server.ts` ~ligne 152, schéma
     `modules/audit/presentation/http/ListAuditEntriesQuerySchema.ts`) — ADR-0009 §8.4 avait
     explicitement refusé de la limiter (« l'ouvrir sur cette seule route produirait une politique
     locale divergente ») ; ADR-0010 §Conséquences reconduit ce constat (« **Aucune limitation de
     débit sur les routes authentifiées** ») et §Résidus 9 laisse la question ouverte jusqu'à ce
     qu'« une politique globale couvre les routes authentifiées » ;
   - `POST /api/v1/payments/webhook` (`server.ts` ~ligne 97) — ADR-0009 §2.1 note d'ailleurs, pour
     justifier de **ne pas** auditer les rejets de webhook, qu'il n'existe « **aucune limitation de
     débit en place** » sur ce point d'entrée.
3. **L'argument d'ADR-0009 §8.4 ne tient plus.** Il portait sur le risque d'une **politique locale
   divergente** créée pour une route isolée. Depuis ADR-0010, la politique n'est plus locale : il
   existe **un** port, **un** compteur atomique, **une** factory, **un** fichier de réglage. Étendre
   ce mécanisme aux deux dernières routes exposées ne crée aucune divergence — c'est au contraire
   l'état actuel (cinq routes protégées, deux non protégées, sans raison écrite autre que
   chronologique) qui est la divergence.
4. **Les deux routes de cette ADR ne sont PAS de même nature que les cinq d'ADR-0010**, et c'est le
   fait dominant du présent document :
   - `GET /api/v1/audit-entries` est **authentifiée** : `requireAuthenticatedContext`
     (`composition-root.ts`) a déjà résolu une session complète et déposé
     `res.locals.auditPrincipal` (`actorUserId`, `tenantId`, `roleCodes`, `permissionCodes`) **avant**
     le contrôleur. Un **sujet imputable existe** — ce qui n'était le cas d'aucune des cinq routes
     d'ADR-0010 ;
   - `POST /api/v1/payments/webhook` est **serveur-à-serveur, signée HMAC par le PSP**, jamais
     appelée par un client final humain, et surtout : elle répond **TOUJOURS `200`** par un
     invariant antérieur, fermé et testé (`PaymentWebhookController.ts`, commentaire de tête ;
     `test/payment/integration/paymentWebhookHttp.test.ts`, commit `649a7b6` item 6).
   Appliquer mécaniquement la recette d'ADR-0010 (clé IP, réponse `429`, aucun audit) à ces deux
   routes serait donc **faux dans les deux cas** : elle punirait le mauvais périmètre sur l'une, et
   casserait un invariant de sécurité déjà acquis sur l'autre.

---

## Décision

### 1. Périmètre : exactement deux routes, aucune autre

```
GET  /api/v1/audit-entries        — authentifiée, sujet connu           (§2, §4)
POST /api/v1/payments/webhook     — serveur-à-serveur signée HMAC       (§3, §5)
```

Les deux routes break-glass SUPER_ADMIN (`POST /api/v1/platform/super-admin/break-glass-requests`
et `.../:requestId/approval`, ADR-0005 Amendement 1) **ne sont pas** ajoutées ici : elles sont
authentifiées **et** protégées par un quorum de deux `SUPER_ADMIN` distincts avec step-up MFA, et
les inclure exigerait une politique numérique supplémentaire non demandée. Résidu 3.

Après cette ADR, **toute route du dépôt sauf `/health` porte une limitation de débit** — la dette de
transport d'ADR-0005 (« anti-énumération et limitation de débit au niveau transport »), reconduite
par ADR-0006, ADR-0009 §8.4 et ADR-0010, est **entièrement fermée** pour la surface HTTP existante.

### 2. `GET /api/v1/audit-entries` — clé = **sujet authentifié (`userId`)**, jamais l'IP (D1)

**Décision** : la clé de compteur est `sih:rate-limit:audit-entries:<actorUserId>`, où
`actorUserId` provient **exclusivement** de `res.locals.auditPrincipal` déposé par
`requireAuthenticatedContext` — jamais de `req.ip`, jamais d'un paramètre de requête, jamais d'un
en-tête choisi par l'appelant.

**Motif, tel qu'acté** : cette route est **déjà authentifiée** au moment où le limiteur s'exécute.
Limiter par IP y pénaliserait à tort **tous les administrateurs d'un même réseau** — un même
établissement derrière un NAT unique, cas normal et non pathologique au Sénégal : le premier admin
qui pagine le journal épuiserait le compteur de ses collègues. Le risque réel que l'on veut borner
sur cette route n'est pas « un réseau qui martèle », c'est « **un compte qui aspire le journal
d'audit** ». La clé doit donc désigner le compte.

C'est la **différence assumée** avec ADR-0010 §8 (« la clé est l'adresse IP de l'appelant, et rien
d'autre »), et elle n'est **pas** une contradiction : la règle d'ADR-0010 est motivée mot pour mot
par le fait que « ces routes sont **anonymes et pré-tenant** — au moment où le limiteur s'exécute,
aucun tenant n'est authentifié, et le seul `tenantId` observable est celui que le client a lui-même
écrit ». Cette prémisse est **fausse** ici : `actorUserId` n'est pas une valeur soumise par le
client, c'est le résultat d'une résolution de session côté serveur. La règle « jamais une donnée
contrôlée par le client dans la clé » est donc **respectée**, pas contournée.

**Conséquence d'ordonnancement, obligatoire et contraire à l'habitude d'ADR-0010 §9** : le limiteur
de cette route est monté **APRÈS** `requireAuthenticatedContext`, jamais avant — sa clé n'existe pas
avant. Il reste monté **avant** le contrôleur, donc avant toute lecture PostgreSQL du journal.
Le coût payé par une requête finalement rejetée est celui de la résolution de session (une lecture
Redis, aucune écriture, aucun accès PostgreSQL) : borné et sans effet de bord.

**Conséquence acceptée** : un flot de requêtes **non authentifiées** sur cette route n'est **pas**
limité (il n'a pas de sujet). Chacune coûte une lecture Redis et retourne `401`, sans écriture ni
entrée d'audit (ADR-0009 §2.1 inchangé). Une requête anonyme ne peut donc **jamais** consommer le
quota d'un sujet — propriété à tester explicitement (§Tests). Ajouter plus tard un limiteur par IP
**en amont** de l'authentification sur cette route resterait possible **additivement**, jamais en
remplacement du compteur par sujet. Résidu 1.

### 3. `POST /api/v1/payments/webhook` — clé **globale unique** pour toute la route (D2)

**Décision** : un **compteur unique partagé par toutes les requêtes de la route**, clé
`sih:rate-limit:payment-webhook:global` — pas de clé par IP, pas de clé par tenant, pas de clé par
`providerTransactionId`.

**Motifs, tels qu'actés** :

- **L'IP du PSP est mutualisée.** Un prestataire de paiement émet ses callbacks depuis une
  infrastructure partagée entre **ses** clients. Une clé par IP ferait donc courir un risque
  inversé : un pic parfaitement légitime chez **un autre client du PSP** — dont nous ne saurions
  rien — consommerait notre compteur et ferait ignorer **nos** webhooks. La protection deviendrait
  un vecteur de perte de confirmations de paiement piloté par un tiers.
- **Le tenant n'est pas connu à ce stade.** Il n'est déterminé qu'après lecture du corps brut,
  vérification HMAC et résolution du `Payment` par `providerTransactionId`
  (`ConfirmPayment.ts` : « le tenant n'est connu **qu'après** avoir retrouvé le Payment »). Une clé
  par tenant exigerait donc de faire, avant de décider de limiter, **tout le travail** que la
  limitation est censée éviter — et reposerait sur un identifiant issu du corps de requête, ce que
  la règle d'ADR-0010 §8 interdit.
- **Ce que le compteur global protège réellement** : un flood **générique** (bug de boucle de
  re-livraison côté PSP, rejeu massif, pair hostile qui a découvert l'URL). C'est exactement le
  risque que cette route porte, et il ne se distingue pas par source.

**Conséquence assumée, écrite sans détour** : au-delà du seuil, **des webhooks légitimes de tous les
tenants sont ignorés**, sans distinction. Ce n'est acceptable que parce que **le webhook n'est pas
la source de vérité du dépôt** : `ReconcilePendingPayments` (job périodique, O-25.5) rattrape
indépendamment tout `Payment` resté `PENDING` — c'est déjà le raisonnement écrit dans
`PaymentWebhookController.ts` pour le cas d'erreur technique (« le rapprochement périodique (O-25.5)
rattrape ce cas indépendamment »). Cette ADR **n'invente pas** ce filet de sécurité, elle s'appuie
sur lui, et en fait la **condition** de la valeur numérique du §6 : le seuil doit rester d'un ordre
de grandeur au-dessus de tout pic légitime plausible, sans quoi cette décision devrait être
reconsidérée.

### 4. Dépassement sur `/audit-entries` : `429` **et** entrée d'audit dédiée (D3)

#### 4.1 Invariant d'ordre — l'audit AVANT la réponse, sans exception

La réponse est le `429 {"error":"too_many_requests"}` standard du mécanisme partagé, avec
`Retry-After` égal à la durée **nominale** de la fenêtre (ADR-0010 §8, règle inchangée). **Mais**,
contrairement aux cinq routes d'ADR-0010 où **aucune entrée d'audit n'est écrite** sur un rejet, une
entrée **est** écrite ici.

La raison de la différence est écrite noir sur blanc, pour qu'aucun futur lecteur ne « harmonise »
les deux comportements : ADR-0010 §8 ne renonce pas à l'audit par principe, il y renonce parce que
ses routes sont **anonymes** — « point d'entrée non authentifié, aucune purge disponible », et
surtout **aucun sujet à qui imputer l'entrée**. Ici le sujet est identifié et prouvé côté serveur.
Et le fait lui-même a une valeur probante : **un rythme anormal de requêtes sur le journal d'audit
est un signal de sécurité**, pas un incident de transport. Ne pas le tracer reviendrait à ce que le
seul endpoint censé garder trace des accès sensibles soit précisément celui dont l'abus ne laisse
aucune trace.

**L'entrée d'audit est écrite AVANT que le `429` soit envoyé au client**, dans sa propre transaction
courte — même invariant, littéralement, qu'ADR-0009 §2.1/§7/§10 et que
`RecordAuditAccess.ts` (« l'entrée `AUDIT_TRAIL_QUERY_DENIED` doit être écrite **AVANT** que le
refus soit renvoyé au client »), déjà appliqué par `AuditEntryController.list`.

**Si l'écriture d'audit échoue** (PostgreSQL indisponible), la requête se termine en
`500 internal_error` via `createErrorHandler`, **jamais** en `429` et **jamais** en réponse servie :
aucun refus n'est prononcé sans trace, exactement comme aucune lecture n'est servie sans trace.

#### 4.2 Modèle de données de l'entrée — **recommandation d'architecte** (point non tranché)

Deux options réelles ont été instruites contre le dépôt :

| | Option A — réutiliser `AUDIT_TRAIL_QUERY_DENIED` + motif distinct | Option B — nouveau `AuditEventType` (`AUDIT_TRAIL_QUERY_THROTTLED`) |
|---|---|---|
| Coût schéma | **Nul** : `AuditEntry.reason` est déjà `String?` en base, déjà exposé par `AuditEntryDto` | `AuditEventType` est un **enum PostgreSQL** (`prisma/schema.prisma`) : migration `ALTER TYPE … ADD VALUE` + union `AuditEventType.ts` |
| Complétude de recherche | Un opérateur qui filtre `eventType=AUDIT_TRAIL_QUERY_DENIED` obtient **tous** les refus de consultation, throttling compris | Le même filtre **manque** les rejets de débit : recherche incomplète par construction |
| Discrimination | Portée par `reason`, **non filtrable** aujourd'hui (`AuditEntryFilter` n'expose pas `reason`) | Portée par `eventType`, filtrable immédiatement |
| Cohérence ADR-0009 | Conforme à l'alternative écartée n° 8 (« deux catégories possibles pour un même fait … rendant l'écriture ambiguë et la **recherche incomplète** ») | En tension directe avec elle |

**Recommandation retenue : Option A.** Le fait énoncé est rigoureusement le même — *une tentative de
consultation du journal a été refusée* ; seul le **motif** du refus change (autorisation vs rythme).
C'est exactement le raisonnement déjà appliqué au §5 d'ADR-0010 pour refuser un code
`invalid_mfa_code` distinct d'`invalid_credentials`. Et l'argument décisif est probatoire : la
question qu'un enquêteur pose au journal est « qui a tenté de lire le journal et s'est vu refuser ? »
— cette question doit avoir **une** réponse, jamais deux requêtes à réunir manuellement.

Concrètement :

```
category   : AUDIT_ACCESS          (inchangé)
eventType  : AUDIT_TRAIL_QUERY_DENIED   (inchangé, aucun nouvel enum, aucune migration)
outcome    : DENIED                (inchangé)
targetType : AUDIT_TRAIL           (inchangé)
reason     : 'RATE_LIMIT_EXCEEDED' (constante nommée, jamais un littéral disséminé)
tenantId / actorUserId / actorRoleCodes / sessionId / correlationId : issus du principal et
             de la requête, exactement comme aujourd'hui — l'entrée vit dans la chaîne du tenant
             de L'ACTEUR (ADR-0009 §7), jamais ailleurs.
```

Deux changements **strictement additifs** sont nécessaires, et deux seulement :
`RecordAuditAccessCommand` gagne un champ `reason: string | null` (les appels existants passent
`null`, **non-régression exacte** : les refus d'autorisation actuels conservent `reason: null` et
restent donc distinguables des rejets de débit), et le commentaire de documentation du modèle
`AuditEntry` dans `prisma/schema.prisma` — qui affirme aujourd'hui que `reason` n'est renseigné que
pour `MFA_RE_ENROLLMENT_FORCED` et `SUPER_ADMIN_BREAK_GLASS_REQUESTED` — est mis à jour, sans quoi
il deviendrait mensonger.

**Tension assumée et écrite** : `reason` était jusqu'ici un **motif humain de justification**
(texte libre saisi par un acteur) ; il porte désormais aussi un **discriminant machine** sur un
`outcome: DENIED`. Le mélange est acceptable parce que les deux usages sont disjoints par
`eventType` et par `outcome`, mais il doit être connu. L'ajout d'un filtre `reason` à
`AuditEntryFilter` fermerait la seule faiblesse réelle de l'option A — additif, non requis ici.
Résidu 2.

#### 4.3 Borne d'amplification : **au plus une entrée par sujet et par fenêtre** — choix d'architecte

ADR-0009 §2.1 refuse explicitement qu'un point d'entrée puisse « insérer une ligne définitive par
requête » dans une table qu'**aucun mécanisme ne peut purger** (B3) : « vecteur de saturation
auto-infligé ». Écrire une entrée à **chaque** requête rejetée reproduirait exactement ce défaut,
cette fois sur une route authentifiée : un compte hostile obtiendrait un débit d'écriture d'audit
**non borné** alors même que ses lectures sont bornées. La protection financerait l'attaque.

**Décision de conception** : l'entrée n'est écrite que sur le **premier franchissement du seuil dans
la fenêtre** — c'est-à-dire lorsque le compteur atteint exactement `maxRequests + 1`. Les rejets
suivants de la même fenêtre reçoivent le même `429`, sans nouvelle écriture. L'information n'est pas
perdue : l'épisode est daté, imputé, et les requêtes **acceptées** qui l'ont précédé ont chacune
produit leur `AUDIT_TRAIL_QUERIED`.

C'est le régime **déjà en vigueur** dans le dépôt pour les faits répétitifs :
`SESSION_LOGIN_FAILED` est dédupliqué par fenêtre (ADR-0009 §2.1) et `MFA_FACTOR_LOCKED_OUT` est
écrit « **une seule fois par épisode** » (ADR-0010, Tests attendus). Aucun mécanisme nouveau n'est
inventé : le script Lua **retourne déjà le compteur**, il suffit que le port `RateLimiter` expose
`firstRejectionInWindow` (vrai si et seulement si `count === limit + 1`) — champ additif, sans effet
sur les cinq routes existantes qui l'ignorent.

### 5. Dépassement sur `/payments/webhook` : **200 silencieux — exception explicite et assumée** (D4)

#### 5.1 L'invariant préexistant prime, et n'est pas rouvert

`PaymentWebhookController.handle` **répond toujours `200`**, quelle que soit l'issue (signature
absente ou invalide, corps illisible, transaction inconnue, montant incohérent, erreur technique) —
« rejet silencieux, pas d'erreur qui fuite d'info » (O-25.5), et protection contre les tempêtes de
re-livraison du PSP. Cet invariant est **fermé et testé** au niveau HTTP réel depuis le commit
`649a7b6` (`test/payment/integration/paymentWebhookHttp.test.ts`), dont l'en-tête énonce :
« **AUCUNE assertion de ce fichier ne porte sur le code de statut HTTP pour distinguer un cas d'un
autre** ».

**Un `429` sur cette route serait une régression de sécurité**, à deux titres : il fournirait à
l'appelant un oracle (« ma requête a été traitée différemment ») que quatre autres cas de rejet
s'interdisent déjà de fournir, et il déclencherait précisément la boucle de re-livraison agressive
que le `200` systématique existe pour éviter.

**Décision** : au-delà du seuil, la requête est **silencieusement ignorée** — le traitement métier
n'a **pas** lieu (aucune vérification de signature, aucun accès `Payment`, rien écrit en base) — et
la réponse HTTP reste **`200`, corps vide**, indistinguable des autres. L'état réel en base demeure
la seule source de vérité, comme pour tous les autres cas de cette route.

#### 5.2 Mécanisme retenu — **recommandation d'architecte** (point laissé à ma discrétion)

Contrainte fixée : **le middleware générique `createRateLimitMiddleware` reste inchangé dans son
comportement de rejet (`429`)** — il protège cinq routes en production de la surface d'inscription et
ne doit jamais devenir configurable sur son point le plus sensible.

Trois options ont été pesées :

1. **Wrapper qui « avale » le `429`** produit par le middleware générique (interception de
   `res.status`/`res.json`). **Écartée** : réécrire une réponse déjà commencée est fragile,
   invisible à la lecture, et fait dépendre une garantie de sécurité d'un détour sur l'API d'Express.
2. **Appeler le port `RateLimiter` directement dans `PaymentWebhookController.handle`**, avant
   `confirmPayment.execute()`. **Écartée**, bien que propre en apparence : à ce point de la chaîne,
   `express.raw({ limit: '256kb' })` a **déjà lu et bufferisé le corps**. Sous flood, on paierait
   donc le coût que la limitation existe pour éviter — c'est exactement l'invariant d'ADR-0010 §9
   (« avant toute désérialisation applicative ») et la raison du correctif BLOQUANT-3
   (`express.json()` monté **après** le limiteur, jamais avant). Cette option ferait, sur le webhook,
   la faute que l'amendement 1 d'ADR-0010 a corrigée ailleurs.
3. **Une seconde factory, distincte, explicitement nommée** — `createSilentRateLimitGuard` dans
   `shared-kernel/infrastructure/SilentRateLimitGuard.ts` — dont **l'unique** chemin de réponse est
   `res.status(200).end()` et qui n'appelle `next()` que lorsque la requête est acceptée. Montée en
   **premier** middleware de la route, **avant** `express.raw()`. **Retenue.**

Motif du choix : l'exception au comportement standard devient **structurelle et lisible**, pas
conditionnelle. Le fichier ne contient **aucune** occurrence de `429` — un `grep` suffit à le
prouver, et aucune valeur de configuration ne peut faire dériver la route vers un `429`. C'est la
même discipline que « rendre la faute impossible par ajout de champ, pas seulement interdite »
(ADR-0010 §7 bis). Les deux factories partagent le **même** port `RateLimiter`, le **même**
`RedisRateLimiter` atomique, le **même** fichier de réglage et la **même** garde de construction
(`maxRequests`/`windowSeconds` entiers positifs, AC-B) — cette garde est **extraite** dans une
fonction partagée, jamais dupliquée : la dupliquer garantirait qu'une des deux copies soit un jour
oubliée.

**Interdiction explicite** : ne **pas** ajouter un drapeau `silent: boolean` à
`createRateLimitMiddleware`. Une politique de réponse pilotée par un booléen rendrait possible, par
une simple erreur de câblage dans `composition-root.ts`, soit un `429` sur le webhook, soit un
**`200` silencieux sur l'inscription** — c'est-à-dire une inscription refusée annoncée comme
acceptée. Deux fichiers, deux noms, aucune ambiguïté.

#### 5.3 Observabilité du rejet : log structuré, **jamais** une `AuditEntry`

Le rejet de débit d'un webhook n'est **pas un événement métier** : aucun acteur imputable, aucun
sujet, aucun tenant connu (§3), et un fait de niveau **transport**. L'inscrire dans `AuditEntry`
contredirait frontalement ADR-0009 §2.1 et son alternative écartée n° 9 (« points d'entrée non
authentifiés écrivant des lignes définitives dans une table qu'aucun mécanisme ne peut purger …
vecteur de saturation auto-infligé ») — d'autant qu'ici, sous flood, l'écriture serait par
construction massive.

La trace est donc un **log structuré**, dans la convention **déjà en place** dans le module
`payment` (`ConfirmPayment.ts` : `invalid_signature`, `invalid_payload`, `unknown_transaction`,
`amount_mismatch`) :

```ts
logger.warn(
  { event: 'payment.webhook.rejected', reason: 'rate_limited' },
  'Webhook paiement ignore (limitation de debit)',
);
```

Niveau `warn`, comme tous les autres rejets de webhook ; `error` est réservé à l'inattendu
(`payment.webhook.unhandled-error`). **Aucun** corps brut, **aucune** signature, **aucune** IP dans
le log (ADR-0009 §3 : l'IP n'est pas une donnée d'audit ; ADR-0010 §8 : elle ne vit qu'en Redis — et
ici, la clé étant globale, aucune IP n'est même manipulée). Le `logger` est fourni au guard par
`composition-root.ts` via un callback : la factory partagée ne connaît ni le module `payment`, ni le
vocabulaire de ses codes de log.

### 6. Valeurs numériques — **non définitives**, même régime qu'ADR-0010 (D5)

Quatre constantes nouvelles, dans **le même fichier** `shared-kernel/domain/RateLimitTuning.ts`,
avec la **même** mention « **À VALIDER MÉTIER — NON DÉFINITIF** » que les six existantes, et la même
règle absolue : **aucun littéral numérique ailleurs** — ni dans les middlewares, ni dans
`composition-root.ts`, ni dans `server.ts`, ni dans les tests (qui importent les constantes, comme
le fait déjà `test/server/rateLimiting.test.ts`).

```ts
/** `GET /api/v1/audit-entries` — route AUTHENTIFIEE, cle = sujet (`actorUserId`), ADR-0011 §2. */
export const AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS = 30;
export const AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS = 60;

/** `POST /api/v1/payments/webhook` — compteur GLOBAL unique, jamais par IP ni par tenant, ADR-0011 §3. */
export const PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS = 120;
export const PAYMENT_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 60;
```

**Aucune de ces valeurs n'est une politique de production opposable.** Le raisonnement qui les
produit — et qui doit être refait le jour où un arbitrage produit/anti-abus sera rendu — est le
suivant, exactement dans l'esprit d'ADR-0010 §8 (résidu 4) :

- **Fenêtre de 60 s dans les deux cas** : alignement strict sur les six constantes existantes
  (inscription 5/60 s, connexion 10/60 s, MFA 10/60 s). Une seconde valeur de fenêtre créerait deux
  régimes de `Retry-After` à expliquer sans bénéfice démontré.
- **`audit-entries` : 30 requêtes / 60 s, soit ~1 requête toutes les 2 s en régime soutenu, par
  compte.** Trois fois la limite de connexion, parce que le profil est inverse : la connexion est
  soumise 1 à 3 fois par un humain, tandis qu'une consultation d'audit est une **navigation**
  (pagination, changement de filtre, retour arrière) où un faux positif frappe un administrateur
  légitime **en plein travail**. 30/min reste très au-dessus de tout rythme humain observé et borne
  une extraction scriptée à 30 × `AUDIT_PAGE_MAX_LIMIT` (200) = 6 000 entrées/minute — un rythme qui,
  de surcroît, **s'auto-dénonce** : chaque requête acceptée écrit son propre `AUDIT_TRAIL_QUERIED`.
- **`payments/webhook` : 120 requêtes / 60 s, soit 2/s, pour la TOTALITÉ de la plateforme.** Le
  compteur étant global (§3), la valeur doit dominer d'un ordre de grandeur le pic légitime cumulé —
  qui, en Phase 0, se compte en quelques paiements par jour, majorés d'un lot de renouvellements et
  des re-livraisons normales du PSP. 120/min laisse une marge considérable tout en coupant un flood
  générique. **C'est la constante la plus fragile de tout le fichier**, pour une raison structurelle
  à écrire : elle **ne s'échelonne pas avec le nombre de tenants**. Elle doit être réévaluée contre
  le volume réel du PSP **avant** toute mise en production, au même titre qu'AC-G (`trust proxy`).
  Résidu 4.

### 7. Câblage — invariants d'ordre dans `server.ts`

```ts
app.post(
  '/api/v1/payments/webhook',
  root.payment.presentation.rateLimitWebhook,   // NOUVEAU — PREMIER, avant express.raw()
  express.raw({ type: '*/*', limit: '256kb' }), // INCHANGE
  root.payment.presentation.webhookController.handle,   // INCHANGE (repond toujours 200)
);
…
app.get(
  '/api/v1/audit-entries',
  root.presentation.requireAuthenticatedContext,   // INCHANGE, et TOUJOURS EN PREMIER ici
  root.presentation.rateLimitAuditEntries,         // NOUVEAU — APRES l'authentification (§2)
  asyncRoute(root.presentation.auditEntryController.list),   // INCHANGE
);
```

Quatre invariants explicites : le guard du webhook est **avant** `express.raw()` (sinon 256 ko sont
lus par requête de flood) ; le limiteur d'`audit-entries` est **après** `requireAuthenticatedContext`
(sa clé n'existe pas avant) et **avant** le contrôleur (aucun accès PostgreSQL sur une requête
rejetée) ; `createErrorHandler` reste le **dernier** middleware ; les deux middlewares sont
**construits dans `composition-root.ts`**, seul point de câblage, par appel des factories partagées
avec les constantes du §6 — aucune instanciation ailleurs.

Le middleware d'`audit-entries` a besoin du `RecordAuditAccessHandler` (module `audit`) pour son
rappel `onRejected` : il est donc construit dans `composition-root.ts`, qui connaît déjà ce module
(`auditEntryController` y est instancié ligne ~826). Aucune règle de frontière n'est franchie : la
factory partagée reçoit une **fonction**, elle n'importe rien du module `audit`.

### 8. Ce que cette ADR ne fait pas

- **Aucun nouveau code d'erreur HTTP** : `too_many_requests` (429) existe déjà dans `SimpleError`
  (ADR-0010 §5). Aucune extension de l'énumération.
- **Aucun nouveau `AuditEventType`, aucune migration Prisma** (§4.2, option A).
- **Aucune modification du comportement de `createRateLimitMiddleware` pour les cinq routes
  d'ADR-0010** : leurs clés, leurs valeurs, leurs réponses et leur absence d'audit sont inchangées,
  octet pour octet.
- **Aucune modification de `PaymentWebhookController`, de `ConfirmPaymentHandler` ni du contrat du
  webhook** : le guard s'intercale en amont, la route continue de répondre `200` partout.
- **Aucune limitation sur les deux routes break-glass SUPER_ADMIN** (§1), ni sur `/health`.
- **Aucune purge, aucun `UPDATE`, aucune exception au contrat append-only de l'audit** (ADR-0009 B3).
- **Aucune décision sur `trust proxy`** : AC-G d'ADR-0010 reste ouvert et **n'est plus bloquant pour
  `/audit-entries`**, dont la clé ne dépend plus de l'IP — il le demeure pour les cinq routes
  d'ADR-0010 et sans objet pour le webhook (clé globale).

### 9. Points laissés à l'appréciation de l'architecte — **validés le 2026-09-05**

Les décisions D1 à D5 sont closes. Ces trois points étaient des **propositions** d'architecte,
tranchées pour que l'implémentation soit exécutable ; le responsable technique les a **validées
telles quelles** :

| # | Point | Décision validée | Effet si l'arbitrage avait différé |
|---|---|---|---|
| A | **Modèle de données de l'entrée de rejet** (§4.2) | **Validé** — réutiliser `AUDIT_TRAIL_QUERY_DENIED` / `DENIED` avec `reason: 'RATE_LIMIT_EXCEEDED'` — aucune migration, recherche des refus restant complète | L'option B (`AUDIT_TRAIL_QUERY_THROTTLED`) exige une migration d'enum PostgreSQL et rend incomplet tout filtre existant sur `AUDIT_TRAIL_QUERY_DENIED` |
| B | **Borne d'amplification de l'audit** (§4.3) | **Validé** — au plus **une** entrée par sujet et par fenêtre (premier franchissement) | Écrire à chaque rejet rouvre le vecteur de saturation refusé par ADR-0009 §2.1, cette fois sur une route authentifiée |
| C | **Valeurs numériques** (§6) | **Validé** — 30/60 s (audit) et 120/60 s (webhook, global) | Ordres de grandeur uniquement ; toute autre valeur entière positive est un simple changement de constante, sans impact de conception |

---

## Alternatives écartées

| # | Alternative | Motif du rejet |
|---|---|---|
| 1 | **Clé par IP sur `GET /api/v1/audit-entries`** (recette ADR-0010 §8 appliquée telle quelle) | La route est **authentifiée** : le sujet réel est connu et prouvé côté serveur. Limiter par IP punirait tous les administrateurs d'un même établissement derrière un NAT unique pour l'abus d'un seul compte, et laisserait ce compte repartir à zéro depuis un autre réseau. La justification textuelle d'ADR-0010 (« ces routes sont anonymes et pré-tenant ») ne s'applique pas ici (D1, §2) |
| 2 | **Clé par IP sur `POST /api/v1/payments/webhook`** | L'IP du PSP est mutualisée entre ses clients : un pic légitime chez un tiers dont nous ne savons rien ferait ignorer **nos** webhooks. La protection deviendrait un vecteur de perte de confirmations piloté de l'extérieur (D2, §3) |
| 3 | **Clé par tenant sur le webhook** | Le tenant n'est connu qu'**après** vérification HMAC et résolution du `Payment` (`ConfirmPayment.ts`) : il faudrait faire tout le travail que la limitation évite, à partir d'un identifiant issu du corps de requête — interdit par ADR-0010 §8 |
| 4 | **`429` explicite et assumé sur le webhook** | Régression directe d'un invariant fermé et testé (commit `649a7b6`, `paymentWebhookHttp.test.ts`) : fournirait un oracle que quatre autres cas de rejet s'interdisent déjà, et déclencherait la tempête de re-livraison que le `200` systématique existe pour éviter (D4, §5.1) |
| 5 | **Retirer le webhook du périmètre** de cette ADR (« route signée, donc déjà protégée ») | La signature HMAC protège l'**intégrité**, jamais la **disponibilité** : un pair qui connaît l'URL peut inonder la route sans aucune signature valide, et chaque requête coûte alors une lecture de 256 ko + un HMAC. C'est la seule route publique du dépôt sans borne de transport, et ADR-0009 §2.1 s'appuyait explicitement sur cette absence pour justifier de ne pas auditer ses rejets |
| 6 | **Drapeau `silent: boolean` sur `createRateLimitMiddleware`** | Rendrait la politique de réponse configurable au point le plus sensible : une erreur de câblage produirait soit un `429` sur le webhook, soit un `200 silencieux` sur l'inscription — une inscription refusée annoncée comme acceptée. Deux factories distinctes rendent l'erreur impossible, pas seulement interdite (§5.2) |
| 7 | **Wrapper interceptant le `429` du middleware générique pour le réécrire en `200`** | Réécrire une réponse déjà commencée est fragile et invisible à la lecture ; ferait dépendre une garantie de sécurité d'un détour sur l'API d'Express (§5.2, option 1) |
| 8 | **Consommer le compteur du webhook depuis `PaymentWebhookController`** | `express.raw({limit:'256kb'})` a déjà bufferisé le corps à ce point : sous flood, on paierait le coût que la limitation existe pour éviter. C'est la faute exacte corrigée par BLOQUANT-3 d'ADR-0010 (`express.json()` monté avant le limiteur) (§5.2, option 2) |
| 9 | **Aucune entrée d'audit sur le rejet `/audit-entries`**, par symétrie avec ADR-0010 §8 | La symétrie serait fausse : ADR-0010 renonce à l'audit parce que ses routes sont **anonymes** (aucun sujet à qui imputer l'entrée), jamais par principe. Ici le sujet est prouvé, et un rythme anormal sur le journal d'audit est lui-même un signal de sécurité (D3, §4.1) |
| 10 | **Une entrée d'audit à chaque requête rejetée** | Débit d'écriture non borné sur une table qu'aucun mécanisme ne peut purger (ADR-0009 B3) : la protection financerait l'attaque. Déduplication par fenêtre, régime déjà appliqué à `SESSION_LOGIN_FAILED` et `MFA_FACTOR_LOCKED_OUT` (§4.3) |
| 11 | **Nouvel `AuditEventType` `AUDIT_TRAIL_QUERY_THROTTLED`** | Migration d'enum PostgreSQL pour un fait déjà couvert, et surtout : tout filtre existant sur `AUDIT_TRAIL_QUERY_DENIED` deviendrait incomplet — le défaut nommé par l'alternative écartée n° 8 d'ADR-0009 (§4.2) |
| 12 | **Écrire une `AuditEntry` sur le rejet du webhook** | Point d'entrée non authentifié, aucun acteur, aucun tenant connu, écriture massive sous flood dans une table non purgeable : exactement l'alternative écartée n° 9 d'ADR-0009. Log structuré uniquement (§5.3) |
| 13 | **Attendre « une politique globale des routes authentifiées »** (ADR-0010 §Résidus 9) | La politique globale **existe** depuis ADR-0010 : un port, un compteur atomique, une factory, un fichier de réglage. Attendre davantage revient à laisser indéfiniment deux routes exposées pour une raison purement chronologique (§Contexte 3) |

---

## Conséquences

**Acquis**

- **Toute route HTTP du dépôt sauf `/health` porte une limitation de débit.** La dette de transport
  d'ADR-0005, reconduite par ADR-0006, ADR-0009 §8.4 et ADR-0010, est **fermée** pour la surface
  existante ; ADR-0010 §Résidus 9 (`Retry-After` sur les routes authentifiées) est **fermé** pour
  `/audit-entries`.
- **Item 9 du sweep de sécurité de l'étape 12/13 fermé** (`docs/architecture/03-open-decisions.md`,
  résidus de l'étape 12) : la « nouvelle politique numérique à trancher » l'est, sous le même régime
  explicitement non définitif que les six constantes existantes.
- L'abus du journal d'audit par un compte devient **imputable et tracé**, dans la chaîne du tenant de
  l'acteur, sans nouvelle catégorie ni migration.
- Le mécanisme partagé est **réutilisé sans être affaibli** : les cinq routes d'ADR-0010 conservent
  un comportement identique, et l'unique exception (`200` silencieux) est portée par un fichier
  séparé dont le nom l'énonce.

**Dette assumée**

- **Des webhooks légitimes peuvent être ignorés** au-delà du seuil global, tous tenants confondus
  (§3). Filet de sécurité : `ReconcilePendingPayments` (O-25.5). Aucune alerte n'existe aujourd'hui
  sur ce cas au-delà du log `payment.webhook.rejected` — un flood prolongé serait donc visible en
  exploitation, pas notifié.
- **Le compteur du webhook ne s'échelonne pas avec le nombre de tenants** : la valeur du §6 devra
  être réévaluée avant toute mise en production, et à chaque changement d'ordre de grandeur du parc.
- **Le flot non authentifié sur `/audit-entries` reste non limité** (§2) : chaque requête coûte une
  lecture Redis et un `401`, sans écriture ni entrée d'audit.
- **`reason` porte désormais deux sémantiques** (motif humain de justification / discriminant machine
  de refus), disjointes par `eventType` + `outcome` mais non filtrables (§4.2).
- **Au plus une entrée d'audit par épisode de throttling** (§4.3) : le **nombre exact** de requêtes
  rejetées dans une fenêtre n'est pas conservé en base. Il reste observable dans les logs applicatifs
  et par le compteur Redis vivant, jamais a posteriori.
- **Une clé Redis contient un `userId`** (`sih:rate-limit:audit-entries:<userId>`). Même régime que
  les sessions déjà stockées dans le même Redis : donnée technique à TTL borné, jamais persistée en
  base, jamais journalisée.

**Résidus**

1. **Limiteur par IP en amont de l'authentification sur `/audit-entries`** — additif, jamais en
   remplacement du compteur par sujet (§2). Non requis en Phase 0, aucun déploiement public.
2. **Filtre `reason` dans `AuditEntryFilter`/`ListAuditEntriesQuerySchema`** — fermerait la seule
   faiblesse de l'option A du §4.2. Additif.
3. **Limitation des deux routes break-glass SUPER_ADMIN** (§1) — exige une politique numérique
   propre, non demandée ici.
4. **Valeurs numériques du §6** — non décidées, même régime qu'ADR-0010 §Résidus 4. Celle du webhook
   est explicitement signalée comme la plus fragile.
5. **AC-G (`trust proxy`) d'ADR-0010 reste ouvert** pour les cinq routes à clé IP ; sans objet pour
   les deux routes de cette ADR.
6. **Interférence entre fichiers de test sur le compteur global du webhook** (§Tests) : un compteur
   partagé par tout le processus **et** par tous les fichiers de test parallèles sur le même Redis.
   Même famille que le résidu `CI-01` (course de *seeding* en CI) — à traiter par isolation
   explicite de la clé dans le test de flood, jamais en relevant le seuil pour faire passer la suite.

---

## Gate pour l'agent d'implémentation

Brief à donner tel quel, sans reformulation qui en élargirait la portée :

> Ajouter une limitation de débit sur **exactement deux** routes : `GET /api/v1/audit-entries` et
> `POST /api/v1/payments/webhook`. Ne toucher à **aucune** autre route, ne créer **aucune** route,
> **aucun** nouveau code d'erreur HTTP, **aucun** nouveau `AuditEventType`, **aucune** migration
> Prisma. Ne modifier **ni** `PaymentWebhookController`, **ni** `ConfirmPaymentHandler`, **ni** le
> comportement de `createRateLimitMiddleware` pour les cinq routes d'ADR-0010.
>
> **`GET /api/v1/audit-entries`** — clé `sih:rate-limit:audit-entries:<actorUserId>` lue
> **exclusivement** dans `res.locals.auditPrincipal` (déposé par `requireAuthenticatedContext`) :
> **jamais** `req.ip`, jamais un en-tête, jamais un paramètre de requête. Le middleware est monté
> **APRÈS** `requireAuthenticatedContext` (sa clé n'existe pas avant) et **AVANT** le contrôleur
> (aucun accès PostgreSQL sur une requête rejetée). Si le principal est absent (ne doit jamais
> arriver), répondre `500 internal_error` — **jamais** de repli silencieux sur l'IP, qui créerait une
> politique divergente invisible. Sur dépassement : écrire l'entrée d'audit **AVANT** d'envoyer le
> `429`, via `RecordAuditAccessHandler` (`outcome: 'DENIED'` → `AUDIT_TRAIL_QUERY_DENIED`) avec
> `reason` = la constante `'RATE_LIMIT_EXCEEDED'` ; les appels existants continuent de passer
> `reason: null` (non-régression exacte). Si l'écriture d'audit échoue → `500`, **jamais** `429`,
> **jamais** de réponse servie. N'écrire l'entrée que sur le **premier** franchissement du seuil dans
> la fenêtre (`count === maxRequests + 1`, exposé par le port `RateLimiter`) — jamais une entrée par
> requête rejetée. Réponse : `429 {"error":"too_many_requests"}` + `Retry-After` = durée **nominale**
> de la fenêtre, constante (règle ADR-0010 §8 inchangée).
>
> **`POST /api/v1/payments/webhook`** — clé **globale unique** `sih:rate-limit:payment-webhook:global`
> : jamais l'IP, jamais le tenant, jamais un champ du corps. **NE JAMAIS RÉPONDRE `429` SUR CETTE
> ROUTE, sous aucune condition** : au-delà du seuil, la requête est ignorée (aucune vérification de
> signature, aucun accès base, aucun traitement métier) et la réponse est `200` **corps vide**,
> indistinguable de tous les autres cas de cette route (invariant fermé et testé, commit `649a7b6`).
> Implémenter une factory **séparée** `createSilentRateLimitGuard`
> (`shared-kernel/infrastructure/SilentRateLimitGuard.ts`) dont l'unique chemin de réponse est
> `res.status(200).end()` — **pas** de drapeau `silent` sur la factory générique, **pas** de wrapper
> qui réécrit un `429`. Monter ce guard en **PREMIER** middleware de la route, **avant**
> `express.raw()`. Tracer le rejet par `logger.warn({ event: 'payment.webhook.rejected', reason:
> 'rate_limited' }, …)` — convention existante du module `payment` — et **aucune `AuditEntry`**.
> Jamais le corps brut, jamais la signature, jamais une IP dans le log.
>
> **Valeurs** : quatre constantes nouvelles dans le **seul** fichier
> `shared-kernel/domain/RateLimitTuning.ts` (`AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS`/
> `_WINDOW_SECONDS`, `PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS`/`_WINDOW_SECONDS`), marquées
> « À VALIDER MÉTIER — NON DÉFINITIF » comme les six existantes. **Aucun littéral numérique
> ailleurs** : ni dans les middlewares, ni dans `composition-root.ts`, ni dans `server.ts`, ni dans
> les tests (qui importent les constantes).
>
> **Partage** : les deux factories utilisent le **même** port `RateLimiter` et le **même**
> `RedisRateLimiter` (script Lua atomique, aucune clé sans TTL) ; extraire la garde de construction
> AC-B (`maxRequests`/`windowSeconds` entiers positifs, échec au **démarrage**) dans une fonction
> partagée plutôt que la dupliquer. Les deux middlewares sont construits **uniquement** dans
> `composition-root.ts` et exposés via `presentation` ; la factory partagée reçoit une **fonction**
> de rappel (`onRejected`), elle n'importe **jamais** le module `audit` ni le module `payment`.
>
> Mettre à jour `docs/api/openapi.yaml` : réponse `429` + en-tête `Retry-After` sur
> `GET /api/v1/audit-entries` — et **surtout PAS** de `429` sur `POST /api/v1/payments/webhook`, qui
> reste documentée comme répondant `200` en toute circonstance. Mettre à jour le commentaire de
> documentation du modèle `AuditEntry` dans `prisma/schema.prisma` (l'usage de `reason` n'est plus
> limité à `MFA_RE_ENROLLMENT_FORCED`/`SUPER_ADMIN_BREAK_GLASS_REQUESTED`). Lire ADR-0001 à ADR-0011
> avant toute modification. Toute décision non couverte ici (résidus ci-dessus) doit être remontée,
> jamais devinée.

## Tests attendus

Style et outillage repris de `test/server/rateLimiting.test.ts` (Redis **réel**, jamais un double en
mémoire — c'est l'atomicité de la primitive qui est éprouvée ; une IP source distincte par scénario
via `nextLoopbackIp()` ; constantes **importées**, jamais recopiées) et de
`test/payment/integration/paymentWebhookHttp.test.ts` (assertions sur l'**état réel en base**,
jamais sur le code de statut pour distinguer deux cas).

**`GET /api/v1/audit-entries` — seuil et clé par sujet**

- Session valide portant `audit:read` : les `AUDIT_ENTRIES_RATE_LIMIT_MAX_REQUESTS` premières
  requêtes ne reçoivent **jamais** `429` ; la suivante reçoit `429 {"error":"too_many_requests"}`
  avec `Retry-After` **exactement** égal à `AUDIT_ENTRIES_RATE_LIMIT_WINDOW_SECONDS`.
- **Preuve directe de D1 — deux sujets, une seule IP** : deux comptes distincts appelant depuis la
  **même** adresse source ; après épuisement du compteur de A, la première requête de B est
  **acceptée**. Un `429` ici prouverait une clé IP.
- **Preuve inverse — un sujet, deux IP** : le **même** compte appelant depuis deux adresses sources
  différentes atteint le `429` **au même rang** que depuis une seule. Changer de réseau ne remet
  jamais le compteur à zéro.
- **Deux sessions distinctes du même compte** (deux `sessionId`, même `actorUserId`) partagent le
  **même** compteur : ouvrir une seconde session ne double pas le quota.
- **Requêtes non authentifiées** : `MAX + 5` requêtes sans `Authorization` → **toutes** en `401`,
  **jamais** `429`, et le compteur d'un compte légitime reste **intact** (sa requête suivante passe).
  Une requête anonyme ne peut pas consommer le quota d'un sujet.
- Le rejet survient **avant** toute lecture PostgreSQL du journal : aucune entrée
  `AUDIT_TRAIL_QUERIED` n'est écrite par une requête rejetée, et aucun corps de liste n'est renvoyé.
- **Aucune clé sans TTL** : après une rafale, toute clé `sih:rate-limit:audit-entries:*` présente en
  Redis a un `TTL > 0` (recherche par **motif**, jamais une clé construite en dur — voir la note de
  `rateLimiting.test.ts` sur `::ffff:` pour les sockets dual-stack).
- **`Retry-After` constant** : deux rejets observés à des instants différents d'une même fenêtre
  portent une valeur **strictement identique**, entière, jamais une date HTTP.
- **Concurrence** : `2 × N` requêtes simultanées du **même** sujet → **au plus N** acceptées.

**`GET /api/v1/audit-entries` — entrée d'audit du rejet**

- Sur le premier `429` : **exactement une** entrée `AUDIT_TRAIL_QUERY_DENIED` / `outcome: DENIED` /
  `targetType: AUDIT_TRAIL` / `reason: 'RATE_LIMIT_EXCEEDED'`, portant l'`actorUserId` du sujet et
  écrite dans la chaîne du tenant **de l'acteur** (jamais celle d'un tenant visé), avec le
  `correlationId` de `X-Correlation-Id` s'il est fourni.
- **Écrite AVANT la réponse** : l'entrée est **déjà visible en base** au moment exact où le client
  reçoit le `429`, sans attente ni relecture différée (même style d'assertion que le test existant
  d'`AUDIT_TRAIL_QUERY_DENIED` du sweep, commit `649a7b6` item 4).
- **Borne d'amplification** : 5 rejets supplémentaires dans la **même** fenêtre → **aucune** nouvelle
  entrée (total inchangé). Une nouvelle fenêtre en produit à nouveau **une**.
- **Non-régression du refus d'autorisation** : un `403 forbidden` ou un `400` de périmètre continue
  d'écrire `AUDIT_TRAIL_QUERY_DENIED` avec `reason: null` — les deux motifs de refus restent
  distinguables en base.
- **Échec d'écriture d'audit** : avec un enregistreur d'audit qui rejette (double injecté au niveau
  de la factory, l'assemblage réel ne le permettant pas), la requête se termine en
  `500 internal_error` — **jamais** `429`, **jamais** de liste servie.
- Aucun secret, aucune IP, aucun corps de requête n'apparaît dans les logs de ce chemin.

**`POST /api/v1/payments/webhook` — 200 systématique et compteur global**

- **Jamais `429`** : `3 × PAYMENT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS` requêtes consécutives → l'ensemble
  des statuts observés est **exactement `{200}`**, corps vide dans tous les cas. C'est le test qui
  verrouille D4 et interdit toute « harmonisation » avec le `429` des autres routes.
- **Rejet silencieux réellement silencieux** : après épuisement du compteur, un webhook
  **valide et correctement signé** visant un `Payment` `PENDING` → `200`, mais le `Payment` reste
  `PENDING` en base et **aucune** entrée `BILLING_PAYMENT_CONFIRMED` n'est écrite. Preuve que le
  traitement métier n'a pas eu lieu et que le seul discriminant reste l'état en base.
- **Preuve directe de D2 — compteur global** : compteur épuisé depuis l'adresse source A, puis un
  webhook émis depuis l'adresse source B est **également** ignoré (`Payment` toujours `PENDING`).
  Une clé par IP le ferait passer.
- **Aucune clé par tenant** : deux webhooks concernant deux tenants distincts consomment le **même**
  compteur.
- **Aucune `AuditEntry` produite par un rejet de débit** : `count()` sur `AuditEntry` identique avant
  et après la rafale (même forme d'assertion que le test « aucune entrée d'audit sur un rejet 429 »
  de `rateLimiting.test.ts`).
- Un log `{ event: 'payment.webhook.rejected', reason: 'rate_limited' }` est émis, et **ni** le corps
  brut, **ni** l'en-tête `x-payment-signature`, **ni** une IP n'y figurent.
- La clé `sih:rate-limit:payment-webhook:global` a un `TTL > 0` après la rafale.
- **Isolation du test de flood** : ce scénario **supprime explicitement la clé globale avant et après
  son exécution** — le compteur étant partagé par tout le processus, il est sensible aux autres
  fichiers de test exécutés en parallèle sur le même Redis (résidu 6). Ne **jamais** « corriger » une
  instabilité de ce test en augmentant le seuil du §6.
- **Non-régression intégrale de `paymentWebhookHttp.test.ts`** : les quatre scénarios existants
  (signature absente, signature invalide, rejeu idempotent, `Content-Type` JSON) restent verts sans
  modification — ils s'exécutent très en deçà du seuil.

**Non-régression transverse**

- `test/server/rateLimiting.test.ts` **inchangé et vert** : les cinq routes d'ADR-0010 conservent
  clé IP, `429`, `Retry-After` nominal et absence d'audit sur rejet.
- `auditHttpIsolation.test.ts`, `mfaSessionGate.test.ts`, `errorHandler.test.ts`, `rlsGuard.test.ts`
  (aucune table ni colonne ajoutée) et la suite de l'étape 12 restent verts.
- **Test d'architecture** : `shared-kernel/infrastructure/SilentRateLimitGuard.ts` ne contient
  **aucune** occurrence de `429`, et `RateLimitMiddleware.ts` ne contient **aucun** chemin de réponse
  `200` — vérifiable par simple lecture, à énoncer dans le commentaire de tête de chaque fichier.

---

## Amendement 1 (2026-09-05) — revue de sécurité indépendante : 2 constats bloquants fermés, 1 résidu ajouté

Revue de sécurité indépendante de l'implémentation (arbre de travail non commité à ce stade),
préalable obligatoire au commit selon le protocole de clôture d'étape de ce dépôt. Verdict initial
**NO-GO conditionnel** : 8 des 10 invariants du §"Gate" vérifiés conformes par exécution réelle
(pas seulement par lecture), 2 constats bloquants. Les deux sont fermés par cet amendement, arbitrés
par le responsable technique le 2026-09-05.

### BLOQUANT-1 — le webhook pouvait répondre `500`, pas seulement `200`/jamais-`429`

**Constat** : `SilentRateLimitGuard.ts` livré laissait échapper toute exception de
`limiter.consume(...)` ou du callback `onRejected` vers `.catch(next)` → `createErrorHandler` →
`500 {"error":"internal_error"}`. Le Gate du §5.2 (« l'**unique** chemin de réponse est
`res.status(200).end()` ») a été respecté à la lettre pour le cas « seuil dépassé » mais pas pour le
cas « le limiteur lui-même est en panne » (Redis en bascule, timeout, `OOM`, erreur `EVAL`) — un cas
non distingué dans le texte original de l'ADR. Un `500` uniforme n'est certes pas un oracle
exploitable, mais il déclenche exactement la tempête de re-livraison PSP que le `200` systématique
existe pour éviter, au moment le plus défavorable (Redis déjà dégradé).

**Décision** : **fail-closed silencieux**. Quand `limiter.consume` (ou son callback) échoue, la
requête est traitée **comme un dépassement de seuil** — ignorée, aucune vérification de signature,
aucun accès base — et la réponse reste `200`, corps vide, avec le **même** unique chemin de sortie
que le cas normal. Motif retenu : `ReconcilePendingPayments` (O-25.5, déjà la justification écrite du
§3 pour le cas de dépassement légitime) rattrape indépendamment tout `Payment` resté `PENDING` — ce
filet couvre aussi bien « seuil dépassé » que « limiteur indisponible ». L'alternative (fail-open,
traitement normal si Redis est en panne) a été écartée : elle perdrait la protection anti-flood
précisément quand une panne d'infrastructure peut aussi signaler une attaque en cours.

**Distinction imposée à l'implémentation** : l'échec du limiteur **doit** produire un motif
d'observabilité distinct de « seuil dépassé » — `reason: 'rate_limiter_unavailable'`, **jamais**
`'rate_limited'`, qui mentirait sur la cause réelle. Le test de non-régression exigé : un
`RateLimiter` double qui rejette sa promesse → statut observé **exactement `200`**, corps vide, log
portant `reason: 'rate_limiter_unavailable'`.

**Dette pré-existante non aggravée, non fermée ici** : un corps de requête `> 256 Ko` produisait déjà
un `500` via `express.raw` → `createErrorHandler` avant cette ADR. Même classe de défaut, même
raisonnement de correctif, mais hors périmètre de ce mandat — **Résidu 7**.

### BLOQUANT-2 — le test gelé `rateLimiting.test.ts` devenait rouge en exécution partagée

**Constat** : `rateLimiting.test.ts` compare un `count()` **global** d'`AuditEntry` avant/après une
requête pour prouver « aucune entrée d'audit sur un rejet 429 ». Le nouveau fichier
`auditEntriesRateLimiting.test.ts` écrit plusieurs centaines d'`AuditEntry` (`AUDIT_TRAIL_QUERIED`)
en parallèle sur la même base PostgreSQL partagée en test → collision quasi certaine
(`AssertionError: expected 15240 to be 15239`, reproduite deux fois sur deux). Le §"Gate" exigeait
ce fichier « inchangé et vert » ; les deux exigences (nouveau test + fichier byte-identique) étaient
incompatibles telles qu'écrites, une fois le volume d'écriture du nouveau test connu.

**Décision** : le gel de `rateLimiting.test.ts` est **levé pour cette seule modification, ciblée et
autorisée explicitement** — borner l'assertion existante au périmètre du scénario (delta compté sur
le tenant/l'acteur/le `correlationId` propres à ce scénario, jamais un `count()` global sur toute la
table) plutôt que de désactiver l'assertion ou le parallélisme des tests. Le fichier reste par
ailleurs inchangé : mêmes scénarios, mêmes clés IP, même comportement `429` vérifié pour les cinq
routes ADR-0010.

**Condition de clôture** : `pnpm -r run test` doit passer **deux fois de suite** en exécution
parallèle réelle (pas seulement les deux fichiers isolés l'un de l'autre) avant tout commit.

### Résidus ajoutés par cet amendement

7. **`POST /api/v1/payments/webhook` peut encore répondre `500` pour un corps `> 256 Ko`**
   (`express.raw` → `createErrorHandler`, comportement antérieur à cette ADR, non aggravé, non
   fermé). Même classe de défaut que BLOQUANT-1, même correctif possible (absorber en `200`
   silencieux), mandat séparé.
8. **Perte de trace si l'écriture d'audit du *premier* rejet dans une fenêtre échoue elle-même**
   (panne PostgreSQL) : ce rejet devient `500` (correct, §4.1), mais tous les rejets **suivants** de
   la même fenêtre reçoivent alors un `429` sans qu'aucune entrée n'ait jamais été écrite pour
   l'épisode — §4.1 (« aucun refus prononcé sans trace ») et §4.3 (une entrée par fenêtre) n'avaient
   pas été arbitrés ensemble pour ce cas composé. Atténuation partielle : sous panne PostgreSQL, la
   route est de toute façon en `500` pour les requêtes **acceptées** au même moment. Non corrigé,
   probabilité jugée faible (suppose une panne PostgreSQL concomitante à un dépassement de seuil),
   à reprendre si l'observation en production le justifie.

### Revue de confirmation (2026-09-05) — verdict GO, deux durcissements appliqués, un résidu précisé

Une seconde revue de sécurité, ciblée sur les deux correctifs ci-dessus (pas une relecture complète),
a vérifié par exécution directe que BLOQUANT-1 et BLOQUANT-2 sont réellement fermés (chemin de
réponse unique confirmé ligne à ligne, motif `limiter_unavailable`/`rate_limiter_unavailable`
structurellement infalsifiable par typage, test de non-régression exerçant le câblage réel via un
spy sur `redis.eval`) et a rendu **GO**. Deux points mineurs ont été corrigés dans la foulée, sans
nouvelle revue nécessaire (corrections mécaniques d'un seul fichier, prescrites mot pour mot par la
revue) :

- **`respondRejected` de `SilentRateLimitGuard.ts`** encadre désormais l'appel à `config.onRejected`
  d'un `try/catch` qui **avale** silencieusement toute exception du callback avant de répondre `200`
  — durcissement : sans lui, une exception du callback de log (aujourd'hui inatteignable en pratique,
  le seul callback câblé étant un `logger.warn` sur un littéral) traverserait l'IIFE sans être
  interceptée par le `try` de `consume`, produisant une requête sans réponse. C'est le **seul**
  endroit du fichier où avaler une exception est la décision de sécurité correcte : le commentaire
  du code l'explicite pour qu'un futur lecteur ne le "corrige" pas dans l'autre sens.
- **`rateLimitArchitecture.test.ts`** gagne une assertion structurelle symétrique de celle de
  `SilentRateLimitGuard.ts` : `RateLimitMiddleware.ts` (les cinq routes ADR-0010) n'importe ni
  Prisma ni le module `audit`. Motif : la revue a montré que l'assertion par `count()` corrigée dans
  `rateLimiting.test.ts` (BLOQUANT-2) est *vacuously true* — `POST /api/v1/registrations` ne propage
  le `correlationId` nulle part, donc l'assertion passerait même en cas de régression. Elle n'est
  pas retirée (elle prouve toujours le `429`), mais la garantie réelle d'absence d'écriture d'audit
  repose désormais sur cette preuve structurelle, indépendante de tout comportement HTTP observé.
- **Résidu 6 précisé** : la revue de confirmation a montré que la course inter-fichiers sur la clé
  Redis globale du webhook (déjà notée ci-dessus) s'étend désormais à **deux** fichiers de test
  (`paymentWebhookRateLimiting.test.ts` et le nouveau `paymentWebhookRateLimiterFailure.test.ts`),
  tous deux manipulant `sih:rate-limit:payment-webhook:global` sous exécution Vitest parallèle.
  Verte dans les deux exécutions observées ; non corrigée (regroupement des scénarios dans un seul
  fichier, ou désactivation ciblée du parallélisme, proposés mais non requis pour ce mandat) —
  **jamais** en relevant le seuil du §6, qui resterait un résidu distinct (4).
