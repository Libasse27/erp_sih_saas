# ADR-0003 — Upgrade proratisé conditionné à un paiement confirmé

- **Statut** : **Accepté** — trois points business tranchés par le product owner le 2026-08-25
  (statut éligible, TTL de la demande, périmètre downgrade)
- **Date** : 2026-08-25
- **Décideurs** : Architecture + product owner
- **Contexte technique** : modules `subscription` et `payment` (Phase 0, étapes 4 et 5 déjà
  livrées) — voir [O-02.6](../03-open-decisions.md) (proratisation) et O-25 (encaissement SaaS)

---

## Contexte

L'étape 4 a livré `UpgradeSubscriptionPlanHandler` avec un comportement provisoire : la commande
calculait le montant proratisé (O-02.6), **puis appliquait immédiatement le changement de forfait**
et écrivait la ligne d'historique `SubscriptionPlanChange`. Aucune `PlatformInvoice`, aucun
`Payment`, aucune confirmation du prestataire n'intervenaient.

Autrement dit : **le montant proratisé était calculé, affiché, historisé — et jamais encaissé.**
Un tenant pouvait monter de STANDARD à COMPLET, obtenir les capacités supérieures immédiatement
(O-02.6 : « nouvelles capacités disponibles aussitôt ») et ne rien payer. Le module `payment`,
livré à l'étape 5, n'était branché que sur le chemin de renouvellement : son énumération
`PaymentPurpose` portait déjà une valeur `UPGRADE` explicitement documentée comme « non émise par
cette étape ».

Cette passe rebranche l'upgrade sur un paiement réellement confirmé, sans toucher au calcul de
proratisation lui-même (`ProrationCalculator.ts`, inchangé), ni au downgrade (hors périmètre,
O-02.6).

## Décision

### 1. L'upgrade devient un flux en deux temps, séparés par un paiement

```
demande → prorata calculé → PlanUpgradeRequest (en attente) + SubscriptionUpgradeRequested
        → PlatformInvoice(purpose=UPGRADE) → Payment PENDING → paiement PSP
        → confirmation SERVEUR (webhook signé ou rapprochement périodique, O-25.5)
        → SaaSPaymentSucceeded → application effective du forfait + PlanChange historisé
```

`Subscription.changePlan()` est renommée `applyPlanUpgrade()` et n'est appelée que depuis le
consommateur Outbox `ApplyPlanUpgradeOnPaymentSucceeded`. `UpgradeSubscriptionPlanHandler` n'y a
plus accès dans aucun chemin de code : « monter en gamme sans payer » devient **impossible par
construction**, et non refusé par une règle — même discipline que `ConfirmPaymentHandler` pour
l'activation webhook-only (O-25.5).

En cas d'échec ou d'expiration du paiement, **l'ancien forfait reste actif**. Il n'existe aucun
état intermédiaire où le tenant bénéficierait de capacités non réglées.

### 2. Corrélation cross-module par référence opaque

Un `PlanChangeId` est **minté à la demande**, côté `subscription`, et sert d'identité unique à tout
le cycle de vie du fait métier :

```
subscription : PlanChangeId minté à la DEMANDE
   └─► SubscriptionUpgradeRequested.planChangeId
        └─► payment : PlatformInvoice.sourceReference (TEXT NULL UNIQUE)
             └─► payment : Payment (résolu via sa facture)
                  └─► SaaSPaymentSucceeded.sourceReference (+ .purpose)
                       └─► subscription : retrouve SA PlanUpgradeRequest par cet identifiant
```

Le module `payment` ne connaît de cette chaîne que « la référence du fait métier à l'origine de
cette facture » : aucun concept `plan` / `upgrade` ne fuit dans son domaine. Le module
`subscription` ne connaît rien de `payment` au-delà de l'événement `SaaSPaymentSucceeded` qu'il
consommait déjà. La règle dependency-cruiser `no-cross-module-domain-import` reste respectée.

**Pourquoi pas une corrélation par `subscriptionId`**, plus simple en apparence : la machine à
états de `Payment` autorise explicitement `FAILED → SUCCEEDED` et `EXPIRED → SUCCEEDED` (webhooks
tardifs, O-25.6). Une confirmation tardive concernant un upgrade **abandonné puis remplacé**
appliquerait alors le nouvel upgrade avec le prorata de l'ancien — corruption financière
silencieuse. Ce cas n'est pas théorique : il est directement produit par une transition que la
machine à états autorise.

### 3. Règles business tranchées par le product owner

| Point | Décision | Raison |
|---|---|---|
| Statut éligible | Upgrade **réservé au statut `ACTIVE`** ; `TRIALING`, `GRACE_PERIOD` et `DEGRADED` refusés avec le code unique `SUBSCRIPTION_NOT_UPGRADABLE` | `TRIALING` : la base de calcul du prorata serait un prix jamais réellement payé. `GRACE_PERIOD`/`DEGRADED` : les « jours restants » n'ont pas de sens sur une période déjà impayée, et vendre une montée en gamme à un compte en défaut est incohérent. Code unique : distinguer les trois cas exposerait l'état de recouvrement sans qu'aucun n'appelle une action différente (régulariser d'abord). |
| TTL d'une demande non payée | **24 heures** | Passé ce délai la demande est considérée abandonnée et **peut être remplacée**. Elle n'est pas supprimée d'office : un paiement confirmé après le TTL mais **avant tout remplacement reste honoré** (l'argent est reçu, l'intention est honorée). Seul un remplacement effectif rend un paiement tardif orphelin. |
| Downgrade | **Hors périmètre**, inchangé (O-02.6) | Différé à la fin de période, jamais proratisé — flux distinct non implémenté. |

Une seule demande peut être en attente par abonnement, imposée par la contrainte UNIQUE
`subscription_id` en base — barrière anti-double-clic non contournable par une course, là où une
vérification applicative préalable serait toujours perdante face à deux requêtes concurrentes.

### 4. Verrouillage optimiste sur `Subscription`

Trois writers peuvent désormais écrire le même abonnement concurremment : application d'un upgrade
payé, réactivation sur paiement, scheduler de renouvellement. Une colonne `version` est ajoutée,
réplique exacte du mécanisme déjà en place sur `Payment`. Les deux consommateurs Outbox retentent
(borné à 3 tentatives, leurs commandes de domaine étant idempotentes) ; le scheduler, lui, **saute
l'abonnement pour ce cycle** — le tick suivant le réévaluera sur un état frais, ce qui est plus sûr
que de rejouer des décisions prises sur une lecture périmée.

## Conséquences

**Acquis**

- Le montant proratisé est désormais réellement encaissé avant d'ouvrir les capacités supérieures.
- Une facture d'UPGRADE et une facture de RENOUVELLEMENT peuvent coexister sur la même période du
  même abonnement (la clé unique passe de `(subscriptionId, periodStartsAt)` à
  `(subscriptionId, purpose, periodStartsAt)` — généralisation stricte, le chemin de renouvellement
  est rigoureusement inchangé puisque `purpose` y est constant).
- Idempotence de bout en bout face à l'Outbox at-least-once : contrainte UNIQUE `source_reference`
  côté facture, identifiant pré-attribué côté `PlanChange`, garde no-op sur `applyPlanUpgrade()`.

**Dette assumée**

- **Paiement orphelin non remboursé.** Trois situations produisent un paiement reçu qu'aucune
  application ne peut honorer sans risque financier : demande remplacée entre-temps, incohérence de
  corrélation, ou base de prorata invalidée par un renouvellement intercalé. Le système
  **n'applique alors rien** et émet un log structuré
  `{ event: 'subscription.upgrade.unmatched_payment', tenantId, subscriptionId, planChangeId,
  platformInvoiceId, reason }`. La régularisation est **manuelle** : le remboursement automatique
  d'abonnement SaaS est explicitement hors V1 (O-25.1). Une alerte sur ce log doit être configurée
  à la mise en exploitation.
- **Aucun endpoint HTTP** n'expose encore la demande d'upgrade ni la facture associée. La query
  `GetPlatformInvoiceBySourceReference` existe et répond à la question « quelle facture régler pour
  ce `planChangeId` ? », mais reste non branchée — la couche présentation de ces deux modules
  appartient à une étape ultérieure.
- **Pas de relance avant expiration.** `expiresAt` circule dans le payload de
  `SubscriptionUpgradeRequested` mais aucun consommateur ne l'exploite ; la notification relève de
  l'étape 9.
- **Aucun nettoyage des demandes expirées non remplacées.** Elles restent en base jusqu'à ce qu'une
  nouvelle demande les remplace — conséquence directe et voulue de la décision « un paiement tardif
  reste honoré tant qu'aucun remplacement n'a eu lieu ». Le volume est borné par construction (une
  ligne au plus par abonnement).
