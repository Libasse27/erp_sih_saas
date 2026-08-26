# Catalogue des événements de domaine

- **Statut** : Vivant — mis à jour à chaque événement de domaine ajouté, modifié ou retiré.
- **Créé** : Phase 0, étape 6/13 (« Outbox + événements + idempotence »), 2026-08-25.
- **Exigé par** : [01-target-architecture.md §9.3](../architecture/01-target-architecture.md#93-evenementiel)
  — « Chaque événement est versionné et documenté dans un catalogue (`docs/domain/events.md`) ».

Ce document liste **tous** les `DomainEvent` existants dans le dépôt à la date ci-dessus : module
d'origine, nom, version, forme du payload, producteur (agrégat + commande/service qui l'émet) et
consommateur(s) Outbox actuel(s), le cas échéant. Un événement **sans consommateur actuel** est
noté explicitement comme tel — jamais un consommateur n'est inventé pour « combler » cette
colonne : voir la règle d'escalade du system prompt de l'agent `backend-dev` (« ne jamais inventer
un barème, un taux ou un protocole », généralisée ici à « ne jamais inventer une réaction métier »).

---

## Convention de versionnage

- Tout `DomainEvent` démarre à **`eventVersion = 1`**.
- Une évolution **additive** (nouveau champ optionnel, consommé via un schéma de validation
  `.passthrough()` qui le traite comme facultatif — voir `SaaSPaymentSucceeded` ci-dessous pour un
  exemple réel) **n'incrémente pas** la version : les messages déjà présents dans l'Outbox,
  émis avant l'évolution, restent traitables sans erreur par les consommateurs existants.
- Une évolution **non rétrocompatible** (renommage de champ, changement de sens, suppression d'un
  champ consommé) **DOIT** incrémenter `eventVersion` et introduire une nouvelle classe
  (`XxxV2` ou équivalent) — jamais une mutation silencieuse de la classe existante. Le consommateur
  aiguille alors explicitement sur `envelope.eventVersion`, jamais par déduction de la forme du
  payload.
- `eventType` est **stable et definitif** dès la première publication — ne jamais renommer un
  `eventType` existant, y compris lors d'une évolution non rétrocompatible (c'est `eventVersion`
  qui porte l'évolution, pas `eventType`).

---

## Module `identity`

| Événement | `eventType` | Version | Producteur (agrégat / commande) | Payload (au-delà des champs `DomainEvent` communs) | Consommateur(s) Outbox actuel(s) |
|---|---|---|---|---|---|
| `UserAccountCreated` | `identity.user-account.created` | 1 | `UserAccount.register()`, via `CreateUserAccountHandler` | *(aucun champ additionnel — `tenantId` toujours `null`, identité de niveau plateforme)*. **`email` retiré du payload à la revue de sécurité de cette étape** : aucun consommateur n'existe, persister une donnée personnelle sans besoin fonctionnel identifié violerait la minimisation ; `aggregateId` (`UserAccountId`) suffit à un futur consommateur pour relire le compte via `UserAccountRepository.findById()`. | **Aucun.** Branché sur l'Outbox à l'étape 6/13 (`PrismaUserAccountRepository.save()`) ; aucun besoin fonctionnel déjà spécifié ne justifie un consommateur à ce stade. |
| `MembershipGranted` | `identity.membership.granted` | 1 | `UserTenantMembership.grant()`, via `GrantMembershipHandler` | `userId: string` | **Aucun.** Branché à l'étape 6/13 (`PrismaUserTenantMembershipRepository.save()`). |
| `MembershipRevoked` | `identity.membership.revoked` | 1 | `UserTenantMembership.revoke()`, via `RevokeMembershipHandler` | `userId: string` | **Aucun consommateur Outbox.** L'invalidation des sessions déjà ouvertes (O-05) est effectuée **synchroniquement** par `RevokeMembershipHandler` (`sessionStore.deleteAllForMembership`, hors mécanisme Outbox) — cet événement est publié pour un futur consommateur asynchrone (audit, notification), pas encore requis. |
| `MembershipRoleAssigned` | `identity.membership.role-assigned` | 1 | `UserTenantMembership.grant()` / `.assignRole()` | `roleId: string` | **Aucun.** |
| `MembershipRoleUnassigned` | `identity.membership.role-unassigned` | 1 | `UserTenantMembership.removeRole()` | `roleId: string` | **Aucun.** |
| `MfaEnrollmentStarted` | `identity.mfa-enrollment.started` | 1 | `MfaEnrollment.start()`, via `StartMfaEnrollmentHandler` | `userAccountId: string` (`aggregateId` = `MfaEnrollmentId`, `tenantId` toujours `null` — niveau identité globale, voir ADR-0005 §1) | **Aucun.** |
| `MfaEnrollmentConfirmed` | `identity.mfa-enrollment.confirmed` | 1 | `MfaEnrollment.confirmEnrollment()` (toute première activation), via `ConfirmMfaEnrollmentHandler` | `userAccountId: string` | **Aucun.** |
| `MfaFactorReplaced` | `identity.mfa-enrollment.factor-replaced` | 1 | `MfaEnrollment.confirmEnrollment()` (ré-enrôlement après `RESET_REQUIRED`), via `ConfirmMfaEnrollmentHandler` | `userAccountId: string` | **Aucun.** |
| `MfaReEnrollmentForced` | `identity.mfa-enrollment.re-enrollment-forced` | 1 | `MfaEnrollment.forceReEnrollment()`, via `ForceMfaReEnrollmentHandler` | `userAccountId: string`, `requestedByUserId: string`. **Ne porte JAMAIS le motif** (minimisation, ADR-0005 §6) : le motif est stocké UNIQUEMENT dans l'`AuditEntry` correspondante. | **Aucun.** |
| `MfaRecoveryCodeConsumed` | `identity.mfa-enrollment.recovery-code-consumed` | 1 | `MfaEnrollment.consumeRecoveryCode()`, via `VerifyMfaChallengeHandler` | `userAccountId: string` | **Aucun.** |
| `MfaRecoveryCodesExhausted` | `identity.mfa-enrollment.recovery-codes-exhausted` | 1 | `MfaEnrollment.consumeRecoveryCode()` (dernier code disponible), via `VerifyMfaChallengeHandler` | `userAccountId: string` | **Aucun.** |
| `MfaRecoveryCodesRegenerated` | `identity.mfa-enrollment.recovery-codes-regenerated` | 1 | `MfaEnrollment.regenerateRecoveryCodes()`, via `RegenerateMfaRecoveryCodesHandler` | `userAccountId: string` | **Aucun.** |
| `MfaFactorLockedOut` | `identity.mfa-enrollment.factor-locked-out` | 1 | `MfaEnrollment.registerFailedChallenge()` (seuil d'échecs consécutifs atteint) | `userAccountId: string` | **Aucun.** |

**Note (ADR-0005 §5)** : les succès/échecs de **challenge de routine** (`MFA_CHALLENGE_SUCCEEDED`,
`MFA_CHALLENGE_FAILED`, `MFA_CHALLENGE_BLOCKED`, `MFA_BYPASS_ATTEMPTED`) ne transitent **jamais**
par l'Outbox — contrairement aux huit `DomainEvent` `Mfa*` ci-dessus, ce sont des **entrées
`AuditEntry`** (module `audit`), écrites **directement, dans la transaction** de l'action MFA,
jamais via un consommateur Outbox. Trois raisons (voir ADR-0005 §5 pour le détail complet) : un
échec ne modifie aucun agrégat et n'émettrait donc aucun événement de domaine (un journal qui ne
voit pas les échecs ne remplirait pas O-04.7) ; l'écriture transactionnelle garantit que l'action
et sa preuve commitent ensemble ; la garantie *at-least-once* de l'Outbox produirait des doublons
sur un registre append-only immuable, qui n'a pas vocation à être dédupliqué.

**Note** : `Role` (`modules/identity/domain/Role.ts`) étend `Entity`, pas `AggregateRoot` — il
n'émet structurellement aucun `DomainEvent` (aucune classe `RoleCreated`/`RoleUpdated` n'existe).
`PrismaRoleRepository.ts` ne branche donc rien sur l'Outbox à cette étape (voir le commentaire de
tête de ce fichier) ; ce n'est pas une omission mais un constat sur l'état actuel du domaine.

`AuditEntry` (module `audit`, ADR-0005 §5) étend `AggregateRoot` mais N'ÉMET JAMAIS de
`DomainEvent` non plus — documenté explicitement dans `modules/audit/domain/AuditEntry.ts` : ce
n'est pas un événement d'intégration (asynchrone, at-least-once), c'est directement la preuve
persistée, écrite dans la transaction de l'action auditée.

## Module `tenant`

| Événement | `eventType` | Version | Producteur (agrégat / commande) | Payload | Consommateur(s) Outbox actuel(s) |
|---|---|---|---|---|---|
| `HealthFacilityCreated` | `tenant.health-facility.created` | 1 | `HealthFacility.create()`, via `CreateHealthFacilityHandler` | `name: string` (`tenantId === aggregateId` : l'agrégat EST le tenant) | **Aucun.** Branché sur l'Outbox à l'étape 6/13 (`PrismaHealthFacilityRepository.save()`). |

## Module `subscription`

| Événement | `eventType` | Version | Producteur (agrégat / commande) | Payload | Consommateur(s) Outbox actuel(s) |
|---|---|---|---|---|---|
| `SubscriptionStarted` | `subscription.subscription.started` | 1 | `Subscription.startTrial()`, via `StartTrialSubscriptionHandler` | `planId: string`, `trialEndsAt: string \| null` | **Aucun.** Hook prévu pour une notification de bienvenue (étape 9) et un suivi commercial des essais — non implémenté. |
| `SubscriptionPlanChanged` | `subscription.subscription.plan-changed` | 1 | `Subscription.applyPlanUpgrade()`, via le consommateur Outbox `ApplyPlanUpgradeOnPaymentSucceeded` | `fromPlanId: string`, `toPlanId: string` (le montant proratisé n'est PAS porté ici — la source de vérité est la ligne `SubscriptionPlanChange` persistée dans la même transaction) | **Aucun.** Hook prévu pour une notification de confirmation (étape 9). |
| `SubscriptionRenewalDue` | `subscription.subscription.renewal-due` | 1 | Scheduler `ProcessSubscriptionRenewals` (jamais un webhook) | `planPriceId: string`, `amountXof: number`, `newPeriodStartsAt: string`, `newPeriodEndsAt: string` | `payment.issuePlatformInvoiceOnRenewalDue` (module `payment`) |
| `SubscriptionGracePeriodStarted` | `subscription.subscription.grace-period-started` | 1 | Scheduler (transition J+7 sans régularisation, O-03.2) | `gracePeriodStartedAt: string`, `graceEndsAt: string` | **Aucun.** Point d'extension prévu pour les rappels d'impayé (O-03.2/O-07, calendrier exact en résidu — voir 03-open-decisions.md) ; aucun envoi de notification implémenté. |
| `SubscriptionDegradedModeEntered` | `subscription.subscription.degraded-mode-entered` | 1 | Scheduler (transition J+7→J+37, O-03.2) | `degradedModeEnteredAt: string` | **Aucun.** |
| `SubscriptionDegradedModeSustained` | `subscription.subscription.degraded-mode-sustained` | 1 | Scheduler (émis UNE SEULE FOIS à J+37, O-03.3) | *(aucun champ additionnel)* | **Aucun.** |
| `SubscriptionReactivated` | `subscription.subscription.reactivated` | 1 | `Subscription.reactivate()`, via le consommateur Outbox `ReactivateSubscriptionOnPaymentSucceeded` | `newPeriodStartsAt: string`, `newPeriodEndsAt: string` | **Aucun.** |
| `SubscriptionRenewed` | `subscription.subscription.renewed` | 1 | `Subscription.renew()`, via le consommateur Outbox `ReactivateSubscriptionOnPaymentSucceeded` (branche abonnement encore `ACTIVE`/`TRIALING`) | `newPeriodStartsAt: string`, `newPeriodEndsAt: string` | **Aucun.** |
| `SubscriptionUpgradeRequested` | `subscription.subscription.upgrade-requested` | 1 | `Subscription.requestUpgrade()`, via `UpgradeSubscriptionPlanHandler` | `planChangeId: string`, `fromPlanId`, `fromPlanPriceId`, `toPlanId`, `toPlanPriceId: string`, `proratedAmountXof: number`, `coveredPeriodStartsAt`, `coveredPeriodEndsAt`, `expiresAt: string` | `payment.issuePlatformInvoiceOnUpgradeRequested` (module `payment`) |

## Module `payment`

| Événement | `eventType` | Version | Producteur (agrégat / commande) | Payload | Consommateur(s) Outbox actuel(s) |
|---|---|---|---|---|---|
| `SaaSPaymentSucceeded` | `payment.payment.saas-payment-succeeded` | 1 | `Payment.confirm()`, via `ConfirmPaymentHandler` (webhook signé) ou `ReconcilePendingPaymentsHandler` (rapprochement périodique) — jamais un retour frontend | `platformInvoiceId: string`, `subscriptionId: string`, `purpose: PaymentPurpose`, `sourceReference: string \| null`, `providerTransactionId: string`, `newPeriodStartsAt`, `newPeriodEndsAt: string` | **Trois consommateurs**, tous filtrant eux-mêmes sur `purpose` :  `payment.markPlatformInvoicePaidOnPaymentSucceeded` (module `payment`), `subscription.reactivateSubscriptionOnPaymentSucceeded` (ignore `purpose === 'UPGRADE'`), `subscription.applyPlanUpgradeOnPaymentSucceeded` (ne traite que `purpose === 'UPGRADE'`) |

---

## Registre d'idempotence consommateur

Chaque consommateur listé ci-dessus est enregistré dans `composition-root.ts` sous un nom de
handler **stable** (`<module>.<service>`, ex. `payment.issuePlatformInvoiceOnRenewalDue`) et
décoré par `withOutboxIdempotency` (`shared-kernel/infrastructure/persistence/
OutboxIdempotencyGuard.ts`) avant d'entrer dans la table de dispatch `eventType -> handlers[]` du
relais. Le registre `platform.OutboxConsumedEvent` (clé `(outbox_message_id, handler_name)`)
garantit qu'un même message, re-livré *at-least-once*, n'applique l'effet de CHAQUE handler
qu'une seule fois — voir [ADR-0004](../architecture/adr/0004-relais-outbox-bullmq.md) §4 et
`test/shared-kernel/integration/outboxIdempotency.test.ts`.

Tout futur consommateur (Identity/Tenant ou nouveau module) **DOIT** suivre la même convention de
nommage et être enregistré via ce même décorateur — jamais une déduplication ad hoc réinventée par
le handler lui-même.

**Nuance obligatoire (revue de sécurité, non négociable)** : ce registre est une garantie de
**premier niveau**, PAS une garantie absolue qui dispenserait un handler d'être lui-même
idempotent. La réclamation est désormais **atomique** (`INSERT ... ON CONFLICT DO NOTHING` avant
d'invoquer le handler, avec retrait de la réclamation si le handler échoue — voir le commentaire de
tête d'`OutboxIdempotencyGuard.ts`), ce qui ferme la fenêtre de concurrence entre deux livraisons
strictement simultanées. Une fenêtre résiduelle, plus étroite mais non nulle, subsiste : un crash
du processus **pendant** l'exécution du handler (ni succès, ni erreur interceptée) laisserait la
réclamation en place sans certitude que l'effet métier a bien été appliqué. **Tout nouveau
consommateur DOIT donc rester idempotent par lui-même** (garde sur son propre agrégat, contrainte
UNIQUE métier...), exactement comme les consommateurs Payment/Subscription existants — ce registre
réduit drastiquement le risque de double exécution, il ne le supprime pas.

---

## Procédure de rebuild des projections (§9.3)

Le §9.3 de [01-target-architecture.md](../architecture/01-target-architecture.md#93-evenementiel)
exige que « les projections disposent d'une procédure de **rebuild** documentée et testée ».

**Constat, vérifié par audit du code à cette étape (`apps/api/src/**`)** : **aucune projection ni
read model n'existe encore dans ce dépôt.** Les tableaux de bord par rôle (§29,
01-target-architecture.md §9.1) et les projections CQRS mentionnées dans la documentation
d'architecture appartiennent à des modules/phases ultérieurs (Phase 1+), pas encore implémentés.

**Décision explicite** : la procédure de rebuild est donc **différée jusqu'à l'introduction de la
première projection** — fabriquer une procédure aujourd'hui, sans aucune projection réelle à
rejouer, produirait une documentation fictive, contraire à la règle « ne jamais inventer un
protocole non spécifié ». Le principe que cette future procédure **devra** respecter est fixé dès
maintenant, pour ne pas être oublié lors de l'introduction de la première projection :

> Un rebuild de projection rejoue les événements **depuis leur persistance dans l'Outbox**
> (`platform.OutboxMessage`, source de vérité transactionnelle — voir ADR-0004), **jamais depuis
> une source non versionnée** (état courant d'un agrégat, log applicatif, ou toute autre
> reconstruction approximative). Concrètement, cela implique que `OutboxMessage` conserve
> l'historique des messages `PROCESSED` (aucune purge n'est en place à ce jour) au moins jusqu'à ce
> qu'une politique de rétention explicite soit définie en tenant compte du besoin de rebuild.

Ce point est à rouvrir explicitement dès qu'un module introduit sa première projection.
