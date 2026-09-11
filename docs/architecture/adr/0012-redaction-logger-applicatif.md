# ADR-0012 — Rédaction automatique des champs sensibles dans le logger applicatif

- **Statut** : **Accepté** (2026-09-11) — revue de sécurité indépendante : GO, après correction de
  l'inventaire du Contexte (le premier comptage, basé sur un grep sans forme `logger?.`, annonçait
  7 sites/5 fichiers au lieu des 39 sites/12 fichiers réels ; les deux conclusions qui s'appuient
  sur cet inventaire — aucune clé sensible déjà loggée, aucune structure imbriquée — ont été
  revérifiées et tiennent sur l'inventaire corrigé).
- **Date** : 2026-09-11
- **Décideurs** : responsable technique (choix du mécanisme et de la profondeur de scan)
- **Contexte technique** : `shared-kernel/infrastructure/ConsoleStructuredLogger.ts` — Phase 0,
  étape 12/13 (« Tests d'isolation multi-tenant/sécurité »), **item 7** des résidus du sweep de
  sécurité (commit `649a7b6`), explicitement hors mandat de `649a7b6`/`fa015d1`.

---

## Contexte

État du dépôt **vérifié par lecture du code**, jamais supposé.

Un seul logger existe dans tout le dépôt : `ConsoleStructuredLogger`, JSON structuré via
`console.log/warn/error`, interface `{info,warn,error}(fields: Record<string, unknown>,
message: string)`. Pino a été explicitement écarté à sa création (« décision transverse hors
mandat », commentaire de tête du fichier) au profit d'un point d'implémentation unique, pensé
pour être remplaçable sans toucher les appelants.

La rédaction des secrets y est **100 % déclarative, 0 % mécanique** : le commentaire de tête du
fichier énonce la règle (« aucun champ `password`/`token`/`authorization`/`cardNumber`/
`phone`/`email`/`nin` ne doit jamais être passé en `fields` ») mais la classe ne vérifie rien —
aucun test ne la fait respecter, contrairement au journal d'audit (`AuditEntry`) qui a sa propre
suite de tests dédiée.

Inventaire complet des 39 sites d'appel existants (12 fichiers) — `grep -E
'logger\??\.(info|warn|error|debug)\('` sur `apps/api/src`, y compris la forme `logger?.` (relais
BullMQ, câblage optionnel) omise par une première lecture incomplète et corrigée par la revue de
sécurité indépendante de cette ADR (voir Gate ci-dessous) :

| Fichier                                 | Occurrences | Champs passés                                                                                                                                          |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `composition-root.ts`                   | 3           | `reason` (enum), `error: error.message` (jamais l'objet brut)                                                                                          |
| `server.ts`                             | 1           | `error: err.message`                                                                                                                                   |
| `RegistrationController.ts`             | 2           | `error` = union de string literals (`EMAIL_ALREADY_REGISTERED`, `INVALID_OWNER_USER_ID`, …), jamais un objet complexe                                  |
| `SessionController.ts`                  | 2           | `error` = union de string literals (`ACCOUNT_NOT_FOUND`, …), ou aucun champ de contexte                                                                |
| `PaymentWebhookController.ts`           | 1           | `error: error.message`                                                                                                                                 |
| `ConfirmPayment.ts`                     | 4           | `reason` (enum : `invalid_signature`/`invalid_payload`/`unknown_transaction`/`amount_mismatch`)                                                        |
| `ApplyPlanUpgradeOnPaymentSucceeded.ts` | 1           | ids (`tenantId`/`subscriptionId`/`planChangeId`/`platformInvoiceId`), `reason` — type explicitement scalaire (voir signature de `logUnmatchedPayment`) |
| `OutboxWorker.ts`                       | 11          | ids (`outboxMessageId`/`jobId`/`eventType`/`tenantId`), `attempts`, `deadLettered`, `error.message` tronqué                                            |
| `NotificationWorker.ts`                 | 11          | ids (`notificationId`/`jobId`/`tenantId`), `channel`, `templateKind`, `attempts`, `retryable`, `nextStatus`                                            |
| `OutboxRelay.ts`                        | 1           | `outboxMessageId`, `eventType`                                                                                                                         |
| `NotificationRelay.ts`                  | 1           | `notificationId`                                                                                                                                       |
| `PeriodicJobRunner.ts`                  | 1           | `job` (nom du job), `error.message`                                                                                                                    |

**Constat empirique : zéro violation aujourd'hui, sur les 39 sites.** Les secrets eux-mêmes (mot
de passe, refresh token, code de récupération MFA, secret TOTP) sont protégés en amont par des
value objects dédiés (`RefreshTokenHash`, `RecoveryCodeHash`, `EncryptedTotpSecret`) — ils ne
transitent jamais en clair vers un objet destiné au logger. Aucun des 39 sites ne loggue de
structure imbriquée (§2 ci-dessous s'appuie sur cet inventaire corrigé, pas sur le premier
comptage erroné).

**Le risque n'est donc pas une fuite existante, mais l'absence de garde-fou.** `fields:
Record<string, unknown>` accepte n'importe quoi. Deux sites (`RegistrationController.ts`,
`SessionController.ts`) passent déjà l'objet `error` entier plutôt que `.message` — sûr
aujourd'hui parce que ce sont des string literals, mais rien n'empêche demain un appelant de
passer un `Error` enrichi, un DTO de requête, ou un champ sensible nommé différemment de la
liste du commentaire (qui n'est vérifiée par personne).

---

## Décision

### 1. Mécanisme : rédaction runtime par liste noire de noms de champs, dans `ConsoleStructuredLogger`

Pas de nouvelle dépendance (Pino reste hors périmètre, cohérent avec la décision initiale du
fichier), pas de vérification statique seule (un scan runtime protège même un appelant qui
n'a pas relu la discipline documentée). `ConsoleStructuredLogger` reste le point
d'implémentation unique : un remplacement futur par Pino n'aura qu'à porter la même liste vers
son option `redact`.

### 2. Profondeur : premier niveau de `fields` uniquement, jamais récursif

Aucun appelant actuel ne loggue de structure imbriquée (voir tableau ci-dessus) ; un scan
récursif ajouterait de la complexité et un risque de sur-rédaction (masquer un id imbriqué dont
le nom matche par coïncidence) pour un besoin non observé. Si un futur appelant a besoin de
loguer une structure imbriquée contenant potentiellement un champ sensible, il doit
l'aplatir/l'extraire explicitement avant l'appel — pas compter sur un scan profond implicite.

### 3. Correspondance : nom de clé exact, insensible à la casse, sur une liste explicite

```ts
const REDACTED_FIELD_NAMES = new Set([
  'password',
  'plainpassword',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'mfacode',
  'totpsecret',
  'totpcode',
  'recoverycode',
  'cardnumber',
  'cvv',
  'phone',
  'phonenumber',
  'email',
  'nin',
  'secret',
]);
```

Correspondance **exacte** (après mise en minuscule de la clé), pas de correspondance par
sous-chaîne : une clé `emailTemplate` ou `phoneCountryCode` n'est **pas** redactée — la
sous-chaîne masquerait des champs légitimes de manière imprévisible et rendrait la liste
impossible à auditer par lecture. La liste reprend et complète celle déjà énoncée dans le
commentaire actuel du fichier (`password`, `token`, `authorization`, `cardNumber`, `phone`,
`email`, `nin`), étendue aux variantes déjà utilisées ailleurs dans le domaine (`plainPassword`
au sens de `CreateUserAccount.execute`, `refreshToken`/`accessToken` de la rotation de session,
`totpSecret`/`totpCode`/`recoveryCode`/`mfaCode` du module MFA) et aux champs de paiement/2FA
qui n'ont pas encore de site d'appel logger aujourd'hui mais qui sont des secrets par nature
(`cvv`, `cardNumber`).

### 4. Comportement sur détection : valeur remplacée, jamais le champ supprimé

Une clé qui matche voit sa valeur remplacée par la chaîne littérale `'[REDACTED]'` — le champ
reste visible dans le JSON produit (structure de l'événement lisible pour le diagnostic), seule
la valeur disparaît. Supprimer le champ rendrait invisible le fait qu'une donnée sensible avait
été tentée en journalisation — un signal utile en revue.

### 5. Ce que cette ADR ne fait pas

- **N'introduit aucune dépendance** (Pino reste différé, décision inchangée).
- **Ne scanne pas les valeurs** (pas de détection de motif dans une chaîne libre, ex. un email
  qui apparaîtrait dans un champ `message` texte libre) — seuls les **noms de clés** de premier
  niveau de `fields` sont vérifiés. Résidu 1.
- **Ne touche à aucun site d'appel existant** : les 39 sites recensés au Contexte continuent de
  passer les mêmes champs, tous déjà sûrs (constat empirique ci-dessus) ; ils bénéficient de la
  garde-fou sans modification.
- **Ne modifie pas le journal d'audit (`AuditEntry`)** : hors périmètre, déjà couvert par sa
  propre discipline (ADR-0009).

---

## Alternatives écartées

| #   | Alternative                                                         | Motif du rejet                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Vérification statique seule (lint/test scannant le code source)     | Ne protège pas un appelant qui construit dynamiquement l'objet `fields` ou qui ignore la règle documentée ; le scan runtime protège aussi ce cas, sans coût perceptible (une liste de ~18 clés, exécutée sur un objet de quelques champs par appel de log) |
| 2   | Adopter Pino maintenant avec `redact` paths                         | Rouvrirait une décision d'infrastructure plus large qu'écartée à la création du logger (« hors mandat »), pour un item borné à une politique de rédaction — disproportionné                                                                                |
| 3   | Scan récursif de toute la structure de `fields`                     | Aucun appelant actuel n'en a besoin (tableau du Contexte) ; ajoute un risque de sur-rédaction sur un id imbriqué homonyme, pour un besoin non observé                                                                                                      |
| 4   | Correspondance par sous-chaîne (ex. toute clé contenant `password`) | Rendrait la liste imprévisible à la lecture (`emailTemplate`, `phoneCountryCode` seraient redactés à tort) ; la correspondance exacte reste auditable d'un coup d'œil                                                                                      |
| 5   | Supprimer le champ plutôt que remplacer sa valeur                   | Perd le signal qu'une tentative de journalisation d'un champ sensible a eu lieu — utile en revue de code/incident                                                                                                                                          |

---

## Conséquences

**Acquis**

- Un appel `logger.*({ password: '...' }, ...)` produit désormais `{"password":"[REDACTED]", ...}`
  au lieu du littéral — garde-fou actif même en cas d'erreur future d'un appelant, plutôt qu'une
  discipline non vérifiée.
- Item 7 du sweep de sécurité de l'étape 12/13 fermé.
- Aucune régression sur les 39 sites d'appel existants (aucune de leurs clés ne matche la liste,
  vérifié par lecture exhaustive et par la revue de sécurité indépendante).

**Dette assumée / résidus**

1. **Pas de détection de valeur dans un champ texte libre** (ex. `message` ou un champ non
   listé contenant accidentellement un email) — seuls les noms de clés de premier niveau sont
   vérifiés (§5).
2. **Liste de noms figée en dur dans le fichier**, pas configurable — cohérent avec le reste du
   dépôt (pas de mécanisme de configuration dynamique du logging), mais toute extension future du
   vocabulaire de champs sensibles exige une modification de ce fichier.
3. **Aucun test de non-régression n'existe à ce jour sur les 39 sites d'appel existants** au-delà
   du nouveau test unitaire de `ConsoleStructuredLogger` lui-même (voir Tests attendus) — un futur
   appelant qui introduirait un champ sensible sous un nom absent de la liste ne serait pas
   détecté.
4. **Vocabulaire de la liste noire incomplet face à des noms plausibles non encore utilisés dans
   le dépôt**, relevé par la revue de sécurité indépendante : `webhookSecret`/`clientSecret` (vs
   `secret` seul), `sessionToken`/`resetToken` (vs `token` seul), `recoveryCodes` au pluriel (vs
   `recoveryCode`), et des noms absents de tout domaine du dépôt à ce jour mais pertinents
   (`otp`, `pin`, `signature`, `apikey`, `iban`, `accountnumber`, `msisdn`). Assumé par
   construction de la correspondance exacte (§3, alternative 4 écartée) : à étendre au cas par cas
   quand un site d'appel introduit effectivement l'un de ces noms, jamais en ajoutant des entrées
   spéculatives non couvertes par un test.

---

## Tests attendus

`apps/api/src/shared-kernel/infrastructure/ConsoleStructuredLogger.test.ts` :

- Une clé de la liste noire (dans n'importe quelle casse, ex. `Password`/`PASSWORD`/`password`)
  voit sa valeur remplacée par `'[REDACTED]'` dans le JSON produit par `info`/`warn`/`error`.
- Une clé absente de la liste (ex. `tenantId`, `eventType`, `userAccountId`) traverse
  inchangée.
- Une clé qui **contient** un mot de la liste sans la matcher exactement (ex. `emailTemplate`,
  `phoneCountryCode`) traverse inchangée — preuve directe de la correspondance exacte (§3).
- Une valeur imbriquée sous une clé sûre (ex. `{ context: { password: '...' } }`) traverse
  inchangée — preuve directe de la non-récursivité (§2).
- Le champ redacté reste présent dans le JSON produit (`"password":"[REDACTED]"`), jamais
  absent — preuve directe de §4.
