# ADR-0007 — Notifications Email/SMS : contexte découplé, pipeline de livraison à la OWASP/Outbox

- **Statut** : **Accepté** (2026-08-28) — validé par le responsable technique après porte
  technique complète (`typecheck`/`lint`/`build`/`arch:check` sans violation, 485/485 tests),
  vérification que les réserves bloquantes F1/F2 (§9) sont bien corrigées, et acceptation des
  résidus §8 ainsi que de la dette de sécurité non bloquante §9 (F0, F3-F11) tels que tracés —
  notamment F3, explicitement conditionné à la montée en charge horizontale et non traité ici
- **Date** : 2026-08-28
- **Décideurs** : Architecture (proposition) + responsable technique (validé le 2026-08-28)
- **Contexte technique** : nouveau module `notifications`, Phase 0, étape 9/13

---

## Contexte

O-07 est **clos** depuis le 2026-08-23 ([01-target-architecture.md §9.4](../01-target-architecture.md#94-notifications-28-o-07-clos-le-2026-08-23),
[03-open-decisions.md O-07](../03-open-decisions.md#o-07--canaux-de-notification-réellement-intégrés-en-v1)) :
canaux V1 (Email + SMS), politique de contenu (aucune donnée médicale, aucune pièce jointe,
notification d'existence uniquement), port `NotificationChannel` par canal. Trois résidus
explicites restent ouverts et **ne sont pas rouverts par cette ADR** : fournisseur SMS,
calendrier exact des 3 rappels d'impayé dans la fenêtre de grâce de 7 jours, décision WhatsApp.

Deux événements de domaine portent déjà, depuis leur création, un commentaire les désignant
explicitement comme des points d'extension pour cette étape :
`SubscriptionStarted` (« notification de bienvenue, étape 9 ») et `SubscriptionPlanChanged`
(« notification de confirmation, étape 9 »). Ce sont les deux seuls déclencheurs câblés ici — voir
§1 pour la justification de ne pas aller au-delà.

---

## Décision

### 1. Périmètre des déclencheurs câblés — deux, pas plus

Seuls `SubscriptionStarted` et `SubscriptionPlanChanged` sont consommés dans cette étape. Motifs,
un par candidat écarté :

- **Rappels d'impayé** (`SubscriptionGracePeriodStarted`/`DegradedModeEntered`/`DegradedModeSustained`,
  O-03.2 → O-07.5) : le mécanisme O-06.5-like (SMS + email en parallèle) est acté, mais le
  **calendrier exact des 3 rappels dans la fenêtre de 7 jours reste un résidu explicite** (O-07,
  résidu 2). Câbler un envoi arbitraire (« un envoi à l'entrée en grâce ») inventerait un début de
  calendrier non arbitré. Reporté à la fermeture de ce résidu.
- **`UserAccountCreated`** (email de bienvenue compte) : n'a jamais été désigné comme un hook
  étape 9 dans `docs/domain/events.md`, et son payload a été délibérément vidé de `email` à la
  revue de sécurité de l'étape 6 (minimisation) — le récupérer suppose une relecture
  `UserAccountRepository.findById()`, faisable, mais hors du périmètre explicitement documenté.

### 2. Résidu technique nouveau : aucun agrégat ne porte de numéro de téléphone

Vérifié par lecture exhaustive du dépôt (grep repo-wide) : `UserAccount`, `UserTenantMembership`
et `HealthFacility` ne portent tous les trois AUCUN champ téléphone. Le VO `PhoneNumber`
(`shared-kernel/domain/value-objects/PhoneNumber.ts`, format E.164 Sénégal) existe mais n'est
câblé sur aucun agrégat. **Conséquence assumée** : le canal SMS est construit intégralement
(port `SmsProvider`, adaptateur sandbox, agrégat `Notification` supportant `channel: 'SMS'`,
pipeline de livraison générique) et **testé** au niveau mécanique (validation de numéro,
dispatch par canal, retry/backoff/dead-letter), mais **aucun déclencheur réel n'envoie de SMS
dans cette étape** — il n'existe simplement personne à qui en envoyer un de façon non devinée.
Ajouter un champ téléphone à `UserAccount` serait une décision de modèle de données (quel
agrégat le porte, obligatoire ou non, validation, consentement) non demandée par le brief de
cette étape — **non inventée ici**, tracée comme résidu ci-dessous.

Ceci ne contredit pas « un canal n'est exposé que s'il est réellement intégré et testé »
(01-target-architecture.md §9.4) : SMS est intégré (port + adaptateur + pipeline complets,
adversarialement testés) et testé — il n'a simplement aucun événement métier légitime à
transporter pour l'instant, ce qui est une situation différente d'un canal factice ou non testé.

### 3. Ports par canal, adaptateurs Sandbox pour les DEUX canaux (pas seulement SMS)

`EmailProvider`/`SmsProvider` (`domain/ports/`), calqués sur `PaymentProvider` (O-25.3) : aucun
type ni vocabulaire fournisseur dans le domaine, `infrastructure/` porte l'intégralité de l'ACL
(D10). Adaptateurs `SandboxEmailProviderAdapter`/`SandboxSmsProviderAdapter` — **aucun fournisseur
réel choisi pour NI L'UN NI L'AUTRE canal**. Pour SMS c'est un résidu explicite (O-07.3,
« fournisseur SMS » — plusieurs vendeurs réels aux API incompatibles, une vraie décision
commerciale/technique). Pour Email, **aucun résidu équivalent n'est déclaré dans O-07** ; le choix
d'un sandbox plutôt qu'un adaptateur SMTP générique réel est donc une décision de cette ADR, pas
une conséquence directe d'un résidu déjà tracé — justifiée ainsi : même si SMTP est un protocole
standard (pas un fournisseur au sens propre), le rendre réellement opérationnel exigerait un relais
sortant réel (compte, identifiants, réputation d'envoi, SPF/DKIM), une ressource opérationnelle non
plus neutre que le choix d'un agrégateur SMS. Traiter les deux canaux **symétriquement** (sandbox
pour les deux) évite de prendre implicitement une décision d'infrastructure de production non
demandée, tout en gardant un adaptateur SMTP réel comme évolution **additive** ultérieure derrière
le même port, sans changement du domaine.

### 4. Résolution de destinataire : `ADMIN_ETABLISSEMENT` du tenant, mécaniquement

Un nouveau port `application/ports/RecipientDirectory.ts` (implémenté en ACL cross-module dans
`composition-root.ts`, même régime que `TenantModuleBackedAccessChecker`) résout les emails des
membres actifs portant le rôle `ADMIN_ETABLISSEMENT` du tenant émetteur de l'événement. Ce choix
n'est **pas** une nouvelle politique métier de ciblage de notification inventée : c'est
l'audience structurellement désignée par la décision déjà actée O-04.1 (`ADMIN_ETABLISSEMENT` =
administrateur de l'établissement) — appliquée mécaniquement à « qui gère l'abonnement de cet
établissement », pas une préférence ou un consentement construit ad hoc (voir §7 pour ce qui,
lui, reste un résidu explicite).

`UserTenantMembershipRepository` gagne une méthode `listActiveByTenantAndRole(tenantId, roleId)` —
absente jusqu'ici, ajoutée additivement, même discipline RLS/tenant-scoping que les méthodes
existantes.

### 5. Agrégat `Notification` : vocabulaire de statut étendu, justifié

01-target-architecture.md §9.4 propose `queued/sent/delivered/failed`. Cette ADR retient
`PENDING → PROCESSING → SENT`, plus `FAILED` et `DEAD_LETTER` **distincts** (pas un simple
remap terminologique) :

- `PENDING` : en file, prochaine tentative pas encore due (respect du backoff, voir §6).
- `PROCESSING` : réclamée par un worker, envoi en cours.
- `SENT` : le fournisseur a accepté l'envoi (`providerMessageId` conservé). **Pas de `DELIVERED`** :
  aucun adaptateur réel n'expose de confirmation de livraison en V1 (§9.4 le rend explicitement
  conditionnel — « lorsque le fournisseur l'expose ») ; annoncer un état qu'aucun fournisseur ne
  confirme réellement serait la même faute que d'annoncer une conformité FHIR non testée.
- `FAILED` : erreur **définitive**, jamais retentée (ex. destinataire structurellement invalide) —
  distinct de `DEAD_LETTER` (échecs **transitoires** répétés jusqu'à épuisement). Le port
  (`EmailProvider`/`SmsProvider`) signale cette distinction via `NotificationDeliveryError.retryable`
  — jamais devinée côté worker à partir du message d'erreur.
- `DEAD_LETTER` : `NOTIFICATION_MAX_ATTEMPTS` atteint sans succès sur des échecs transitoires.

Constante `NOTIFICATION_MAX_ATTEMPTS` : paramètre **opérationnel** (comme `OUTBOX_MAX_ATTEMPTS = 8`
déjà en production sans être traité comme un résidu métier) — n'affecte aucun des résidus O-07
réels (fournisseur, calendrier de rappels), donc non escaladée.

### 6. Pipeline de livraison : second « Outbox » spécialisé, même doctrine de source de vérité unique

Réutilise EXACTEMENT la doctrine déjà actée pour l'Outbox (ADR-0004, `OutboxRelay.ts` §tête de
fichier) plutôt que le retry natif de BullMQ : « une seule politique de nouvelle tentative, jamais
deux qui pourraient diverger ». `Notification` porte son propre `status`/`attempts`/`lockedAt`/
`lockedBy`/`nextAttemptAt` ; BullMQ (file `notification-delivery`, distincte de `outbox-relay`)
sert uniquement de distributeur de charge (`attempts: 1` à l'enfilage, aucun retry BullMQ). Le
`jobId` réutilise `buildOutboxJobId`/`parseOutboxJobId` (`shared-kernel/infrastructure/queue/
OutboxJob.ts`) — génériques malgré leur nom (encodage `<id>#<attempts>`, aucune dépendance à
`OutboxMessage`), réutilisés tels quels plutôt que dupliqués.

**Ajout au-delà du calque Outbox, demandé explicitement pour ce module** : un **backoff exponentiel
contrôlé** (`NotificationBackoff.ts`, fonction pure) — absent du relais Outbox actuel (qui
retente au cycle suivant, 5 s, sans délai croissant). `nextAttemptAt` est recalculé à chaque échec
transitoire (`30s, 60s, 120s, 240s`, plafonné) ; la requête de réclamation du relais de
notification filtre `next_attempt_at IS NULL OR next_attempt_at <= now()`. Ceci ne modifie EN RIEN
la politique de retry de l'Outbox existant — deux pipelines distincts, deux politiques
délibérément différentes, documentées séparément, jamais confondues.

Défense en profondeur : la création d'une `Notification` (dans les deux consommateurs Outbox de
cette étape) utilise `createMany({ skipDuplicates: true })` sur la contrainte
`@@unique([sourceEventId, channel, recipient])` — jamais un `create()` rattrapant un P2002 (même
idiome que `PrismaSubscriptionRepository`/`PrismaPaymentRepository`/`PrismaPlatformInvoiceRepository`)
— seconde ligne de défense derrière `withOutboxIdempotency`, exactement la nuance documentée dans
`docs/domain/events.md` (« ce registre est une garantie de premier niveau, pas absolue »).
`recipient` fait PARTIE de la clé (constat corrigé pendant l'implémentation, voir les tests) : un
même événement produit légitimement PLUSIEURS notifications sur le même canal — un
`ADMIN_ETABLISSEMENT` peut en compter plusieurs pour un même tenant (O-05.2, plusieurs rôles/
memberships simultanés). Une clé `(sourceEventId, channel)` sans `recipient` aurait silencieusement
fait disparaître toutes les notifications sauf la première insérée.

### 7. Contenu minimal, gabarits fermés — jamais de texte libre assemblé depuis un payload

`NotificationTemplates.ts` (domaine, fonction pure) associe un `templateKind` fermé
(`SUBSCRIPTION_WELCOME` | `SUBSCRIPTION_PLAN_CHANGED`) à un couple `{ subject, body }`/`{ text }`
fixe, sans injection de données sensibles (aucun montant, aucune date, aucune donnée clinique) —
« notification d'existence », conforme à O-07.2. Aucun consommateur ne peut construire un contenu
arbitraire : c'est structurellement fermé, pas une discipline laissée à la relecture de code.

### 8. Résidus explicitement non tranchés par cette ADR

1. **Fournisseur SMS** (O-07.3, inchangé).
2. **Calendrier exact des 3 rappels d'impayé** (O-07, résidu 2, inchangé) — bloque le câblage des
   événements de cycle de vie de grâce/dégradé.
3. **Fournisseur Email** (nouveau constat de cette ADR, §3) — aucun SMTP réel choisi.
4. **Numéro de téléphone absent de tout agrégat** (nouveau constat, §2) — bloque tout envoi SMS
   réel indépendamment du fournisseur.
5. **Préférences/consentement de notification** (O-07 ne définit aucune politique d'opt-out ou de
   préférence de canal) — aucune n'est inventée ici ; tout destinataire résolu reçoit la
   notification, sans mécanisme de désabonnement. À arbitrer explicitement avant toute notification
   à caractère commercial/marketing (celles de cette étape sont strictement transactionnelles :
   démarrage d'abonnement, changement de forfait déjà décidé par l'action de l'administrateur
   lui-même).
6. **Rétention/purge de `platform.Notification.recipient`** (constat de la revue de sécurité §9,
   F ci-dessous) — nouvelle donnée à caractère personnel stockée (email nominatif d'administrateur)
   sans durée de conservation ni purge définie ; se rattache à O-15 (rétention/purge, déjà
   « à valider » pour le reste du dépôt), non traité spécifiquement ici.

## 9. Revue de sécurité indépendante (étape 9/13) — verdict et résidus

Revue conduite par l'agent `security` avant commit, même discipline qu'aux étapes 5-8. **Verdict :
GO avec réserves.** Aucun constat Critique ni Élevé ; les 8 exigences du commanditaire sont
vérifiées satisfaites. Deux réserves étaient bloquantes avant commit et ont été corrigées :

- **F1** — `NotificationRepository.findById(id)` ne prenait pas `tenantId` alors que
  `platform.Notification` est hors RLS par construction (§6) : le filtrage applicatif en est donc
  la SEULE couche d'isolation restante, et un accesseur non scopé aurait été une régression prête
  à l'emploi dès qu'un futur endpoint l'exposerait. Corrigé : `findById(id, tenantId)`, aligné sur
  `PrismaPaymentRepository`. Test de régression ajouté (`notificationDelivery.test.ts`, « findById
  exige le tenantId de l'appelant »).
- **F2 (volet mémoire)** — les adaptateurs Sandbox accumulaient `{recipient, subject, body}` sans
  aucune borne pendant toute la durée de vie du processus : un inventaire non borné d'adresses
  email d'administrateurs en mémoire de processus, seul constat de la revue exposant directement de
  la PII. Corrigé : `sentMessages()` ne retourne plus que `{idempotencyKey, providerMessageId}`
  (`SandboxSentRecord`), historique borné à 500 entrées (`SANDBOX_SENT_HISTORY_LIMIT`).

Constats non bloquants, tracés comme résidus (délais indiqués par la revue, tickets séparés — non
traités par cette étape pour ne pas rouvrir un scope non demandé) :

- **F0** — la garantie d'idempotence porte sur la LIGNE (`(sourceEventId, channel, recipient)`
  unique), pas sur l'ENVOI : la livraison reste at-least-once, et seul un futur adaptateur réel
  honorant `idempotencyKey` fermerait l'écart. Sans conséquence pour les deux gabarits actuels
  (contenu non sensible, non transactionnel financier) ; **à réévaluer avant le câblage des
  rappels d'impayé** (résidu 2 ci-dessus).
- **F2 (volet configuration)** — rien n'empêche aujourd'hui de déployer les adaptateurs Sandbox en
  production/staging ; `config/env.ts` n'a pas encore de garde-fou dédié (même famille que les
  refus déjà en place pour `redis://` en clair ou les secrets MFA d'exemple). À faire avant tout
  déploiement non-dev, conditionné au choix d'un fournisseur réel (résidus 3/4 ci-dessus).
- **F3** — `workerId` dérivé de `process.pid` : en conteneur (PID 1 quasi systématique), deux
  répliques calculent la MÊME valeur, ce qui vide silencieusement le garde-fou de verrou ; à
  l'inverse, avec des PID réellement distincts, un job réclamé par une réplique peut être
  distribué au worker d'une autre, qui l'ignore (`foreign-lock-skipped`) jusqu'à `DEAD_LETTER`
  sans qu'aucun appel fournisseur n'ait jamais été tenté. **À corriger avant toute mise à l'échelle
  horizontale de l'API** (identifiant de déploiement explicite requis, pas une propriété de
  processus).
- **F4** — aucun délai maximal sur l'appel sortant au fournisseur (`EmailProvider.send`/
  `SmsProvider.send`) ; un fournisseur qui ne répond jamais gèle le pipeline jusqu'à la reprise de
  verrou périmé (5 min), avec risque de double appel fournisseur pour la même notification.
- **F5** — les `UPDATE` terminaux du worker (succès/échec) ne re-vérifient pas `attempts` dans leur
  clause `WHERE`, seulement `status`/`lockedBy` — fenêtre étroite où une génération de réclamation
  périmée pourrait écrire l'état terminal d'une génération plus récente. Même défaut hérité,
  non corrigé, dans `OutboxWorker.ts` (ticket séparé, hors périmètre notifications).
- **F6** — le rattrapage d'échec d'enfilage BullMQ (`NotificationRelay.ts`) réinitialise la ligne en
  `PENDING` sans clause `WHERE` conditionnelle, contrairement au reste du pipeline.
- **F7/F8** — le message d'erreur fournisseur/domaine n'a pas de contrat explicite de non-
  divulgation du destinataire ; pas de fuite constatée avec les adaptateurs Sandbox actuels
  (F8 est même structurellement inatteignable, `Email.create()` normalisant en amont), mais rien
  n'empêche un futur adaptateur réel de la réintroduire.
- **F9** — un `template_kind` présent en base mais absent de `NotificationTemplates.ts` (dérive de
  migration) serait mal classé `retryable` au lieu d'une erreur définitive immédiate, contrairement
  au traitement déjà correct du canal inconnu.
- **F10/F11** — pas de supervision dédiée sur le taux de `DEAD_LETTER` ; index de réclamation non
  aligné sur `next_attempt_at` (impact disponibilité à moyen terme, pas confidentialité).
