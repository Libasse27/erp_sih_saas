# 03 — Décisions ouvertes : points à valider

- **Statut** : Actif — document vivant
- **Date** : 2026-08-23

> **Règle absolue (§41 du cahier des charges)** : aucun comportement médical, aucune règle de
> tarification, de remboursement ou de workflow clinique n'est inventé. Tout point non
> explicitement défini par le cahier des charges est listé ici et **attend un arbitrage
> humain**. Aucun de ces points ne sera tranché unilatéralement.

**Légende**
- **MÉTIER** : nécessite une décision du métier (direction, médical, financier, juridique)
- **TECHNIQUE** : nécessite une décision d'ingénierie
- **Bloquant** : la phase indiquée ne peut pas démarrer sans cette décision

---

## Bloquants Phase 0 — SaaS Core

### O-01 — Base de données : PostgreSQL seul ou PostgreSQL + MongoDB
**TECHNIQUE · CLOS le 2026-08-23 · [ADR-0002](adr/0002-database-stack.md)**

**Décision** : Option B — **PostgreSQL seul avec JSONB** pour le documentaire clinique.
Confirmée par le responsable technique. ADR-0002 passe au statut Accepté ; ADR-0001 est
définitivement confirmé sur son volet clinique (RLS couvrant 100 % des données).

Point de réouverture conservé tel que prévu dans ADR-0002 : si un besoin documentaire réel et
mesuré (pas supposé) apparaît en Phase 5, MongoDB pourra être introduit en base secondaire
strictement limitée, sous un nouvel ADR.

---

### O-02 — Modèle de tarification des forfaits
**MÉTIER · CLOS le 2026-08-23 (reliquat technique clos le 2026-08-24) · Détail dans [01-target-architecture.md §6.3](01-target-architecture.md#63-saas-core)**

Sept sous-décisions fermées :

| # | Sujet | Décision |
|---|---|---|
| O-02.1 | Prix | STANDARD 35 000 · PROFESSIONNEL 55 000 · COMPLET 75 000 FCFA/mois |
| O-02.2 | Périodicité | Mensuel + annuel, remise annuelle ~16,7 % (2 mois offerts) |
| O-02.3 | Unité de facturation | Par établissement, capacités/limites hybrides portées par le `Plan` |
| O-02.4 | Dépassement | Comportement différencié par type de ressource ; jamais de rupture de continuité des soins |
| O-02.5 | Essai gratuit | Forfait STANDARD, 30 jours, sans moyen de paiement requis |
| O-02.6 | Changement de forfait | Upgrade immédiat proratisé ; downgrade différé à la fin de période |
| O-02.7 | Remises / TVA | Remises via coupons Super Admin traçables ; TVA configurable, non présumée (lié à O-13) |

**Reliquat technique — CLOS le 2026-08-24, avant le démarrage de l'étape 4 (Plan/PlanPrice/Subscription)** :

Limites V1 par forfait (O-02.3) — seules `maxUsers` et `maxBeds` sont plafonnées en V1 ; aucune
autre ressource (pas de `maxPatients`, `maxConsultations`, `maxStorage`, `maxServices`... pour
l'instant) :

| Forfait | maxUsers | maxBeds |
|---|---:|---:|
| STANDARD | 10 | 20 |
| PROFESSIONNEL | 30 | 50 |
| COMPLET | 100 | 200 |

- `maxUsers` compte les `UserTenantMembership` **actifs** (O-05, déjà acté — jamais les rôles).
- `maxBeds` compte les lits configurés pour l'établissement. La vérification effective de cette
  limite attend le module qui gère `Building`/`Room`/`Bed` (hors périmètre avant Phase 4, voir
  [01 §6.4](01-target-architecture.md#64-tenant--établissement)) ; la limite elle-même existe
  dès le `Plan`, à l'étape 4.
- Les limites appartiennent exclusivement au `Plan`, jamais au `Subscription`.
- Dépassement (O-02.4) : **alerte, jamais blocage** — cohérent avec l'option D hybride déjà
  retenue et la règle de non-régression clinique (aucune donnée ni acte de prise en charge
  bloqué par un dépassement de quota).

Méthode de proratisation (O-02.6, **upgrade uniquement** — le downgrade reste différé à la fin
de période, jamais proratisé) :

- Calcul **au jour calendaire près** :
  `montant = (nouveau_prix − ancien_prix) × jours_restants / jours_dans_la_période`.
- Arrondi à l'entier FCFA le plus proche ; un `.5` arrondit **au supérieur**.
- Minimum d'encaissement : **1 FCFA** si le calcul produit un montant positif inférieur à 1 FCFA.
- Plusieurs upgrades dans la même période : chaque upgrade se calcule depuis le **forfait
  actuellement actif**, jamais depuis le `PlanPrice` initial de la période
  (`STANDARD → PROFESSIONNEL → COMPLET` facture `COMPLET − PROFESSIONNEL`, pas
  `COMPLET − STANDARD`). Chaque changement est historisé, indépendant et idempotent.
- Contrainte d'implémentation actée : le prix appliqué à un `Subscription` ne se lit **jamais**
  via `subscription.plan.price` (le `Plan` courant peut avoir changé de tarif depuis la
  souscription) — le `PlanPrice` réellement applicable est résolu, puis sa référence est
  conservée sur la transaction historisée, jamais recalculée après coup depuis le `Plan`
  courant.

**Décideur** : Direction (2026-08-24).

---

### O-03 — Comportement en cas d'abonnement impayé ou suspendu
**MÉTIER · CLOS SOUS RÉSERVE JURIDIQUE le 2026-08-23 · Sensibilité élevée**

Structure décidée (direction) ; validation juridique formelle encore requise avant mise en
production — voir reliquats ci-dessous.

| # | Sujet | Décision |
|---|---|---|
| O-03.1 | Modèle | **D** — grâce temporaire puis mode dégradé. Aucune suppression de données. Continuité des soins jamais compromise pour motif d'impayé. |
| O-03.2 | Durées | **7 jours** de grâce · **3 rappels** · **30 jours** de mode dégradé. Canaux et calendrier précis des rappels dépendent d'**O-07**. |
| O-03.3 | Au-delà de J+37 | **A** — maintien indéfini du mode dégradé. Pas de restriction clinique supplémentaire, pas de suspension complète. Le recouvrement au-delà relève du commercial/contractuel/juridique, jamais d'une dégradation technique du soin. |

**Pourquoi B et C ont été écartées en O-03.3** : C contredirait le principe de continuité des
soins déjà acté (O-02.4, O-02.6, O-03.1). B exigerait un mécanisme de « bris de glace » —
c'est exactement le périmètre d'**O-08**, bloquant Phase 3, pas Phase 0 ; l'imposer dès la
Phase 0 créerait un couplage prématuré entre les deux phases.

**Reliquats explicitement conservés (à ne pas transformer en décisions implicites)** :
1. Validation juridique formelle avant mise en production.
2. Durée et modalités de conservation après résiliation — voir **O-15**.
3. Modalités d'export des données.
4. Cadre réglementaire applicable aux données de santé au Sénégal.
5. Calendrier et canaux exacts des 3 rappels — voir **O-07**.
6. Les règles de contexte clinique / bris de glace restent exclusivement dans **O-08** ; ne
   pas les anticiper en Phase 0.

**Décideur** : direction (structure actée) + conseil juridique (validation finale requise).

---

### O-04 — Périmètre du MFA obligatoire
**MÉTIER + TECHNIQUE · CLOS STRUCTURELLEMENT le 2026-08-23 · Détail dans [01 §7.1](01-target-architecture.md#71-authentification-et-contexte)**

Sept sous-décisions :

| # | Sujet | Décision |
|---|---|---|
| O-04.1 | Rôles soumis | Déclenchement par **catégorie de permission** (pas par nom de rôle) : SUPER_ADMIN (plancher technique) + admin tenant + finance à fort impact. Rôles cliniques génériques exclus en V1 (catégorie D réservée, dépend d'O-08/O-11) |
| O-04.2 | Qui impose | Modèle hybride : socle plateforme non désactivable, établissement peut renforcer, jamais abaisser |
| O-04.3 | Facteur | TOTP primaire, WebAuthn/Passkey en alternative plus forte, SMS exclu comme facteur primaire |
| O-04.4 | Postes partagés / urgences | Résolu par construction : les rôles cliniques génériques ne sont pas dans le plancher MFA V1 |
| O-04.5 | Enrôlement / récupération | Codes de récupération à usage unique + procédure administrée avec vérification d'identité. Aucune désactivation silencieuse — seul un ré-enrôlement audité est possible |
| O-04.6 | Sessions / réauthentification | **Résolu via O-06** (clos le 2026-08-23) : catégories alignées sur O-04.1, step-up hérite du socle O-04.1, réauthentification MFA au changement de contexte cohérente avec O-05.1 |
| O-04.7 | Audit et preuves | Tout événement MFA auditable dans `AuditEntry` (distinct du journal d'audit médical) ; append-only, immuable y compris pour SUPER_ADMIN ; jamais de secret en clair ; rétention rattachée à O-15 |

**Résidus, statut au 2026-09-03** :
1. ~~Procédure opérationnelle de récupération pour `ADMIN_ETABLISSEMENT`~~ — **CLOS le
   2026-09-03**, [ADR-0005 Amendement 1](adr/0005-mfa-totp-et-audit-plateforme-minimal.md#amendement-1-2026-09-03--clôture-résidus-34--récupération-adminetablissement-break-glass-superadmin) :
   autorité de récupération restreinte au `SUPER_ADMIN` quand le sujet est lui-même
   `ADMIN_ETABLISSEMENT` ; un `ADMIN_ETABLISSEMENT` garde `mfa:reset` pour le personnel non-admin
   de son tenant.
2. ~~Procédure *break-glass* de récupération pour `SUPER_ADMIN`~~ — **CLOS le 2026-09-03**, même
   amendement : quorum de deux `SUPER_ADMIN` indépendants (demandeur ≠ approbateur ≠ sujet), aucun
   approbateur unique codé, cas « deux `SUPER_ADMIN` seulement » traité en runbook opérationnel hors
   bande. Nouveau résidu ouvert par cette clôture : durée de validité d'une requête `PENDING` non
   approuvée — aucune valeur inventée, à trancher séparément.

---

### O-05 — Utilisateur exerçant dans plusieurs établissements
**MÉTIER · CLOS le 2026-08-23 · Détail dans [01 §6.3](01-target-architecture.md#63-saas-core) et [§7.1](01-target-architecture.md#71-authentification-et-contexte)**

| # | Sujet | Décision |
|---|---|---|
| O-05.1 | Modèle d'identité | **B** — identité unique (`UserAccount`, sans `tenantId`) + `UserTenantMembership` (0..N) par établissement, sélection de contexte côté serveur. Changement d'établissement = fermeture du contexte courant + émission d'un nouveau (jamais une mutation en place). |
| O-05.2 | Rôles par membership | **B** — plusieurs rôles simultanés autorisés par membership (`Membership → Roles[]`), permissions = union additive (catalogue RBAC purement additif, §7.2). Évite les rôles composites artificiels. |

**Règles dérivées, actées comme décisions et non comme détails d'implémentation** :
- Quota `maxUsers` (O-02.3) : compte des **memberships actifs**, jamais des rôles.
- MFA (O-04.1/O-04.2) : s'applique au membership dès qu'**un seul** rôle du membership l'exige
  — le plus restrictif l'emporte. Changer vers un établissement dont le rôle exige le MFA
  déclenche une réauthentification si le contexte précédent ne l'exigeait pas.
- Révocation d'un membership : interdit l'ouverture d'un nouveau contexte pour ce tenant et
  invalide les contextes de session déjà ouverts pour ce membership.
- Le client ne fournit jamais `tenantId`, `role` ni `permissions` comme preuve — uniquement une
  sélection d'intention, vérifiée contre les memberships réels.

Aucun résidu bloquant identifié pour Phase 0.

---

### O-06 — Durée de session et expiration d'inactivité
**MÉTIER + TECHNIQUE · CLOS STRUCTURELLEMENT le 2026-08-23 · Détail dans [01 §7.1](01-target-architecture.md#71-authentification-et-contexte)**

| # | Sujet | Décision |
|---|---|---|
| O-06.1 | Plafond absolu | Existe, différencié par catégorie de sensibilité, **catégories alignées sur O-04.1** (pas de troisième taxonomie de risque). **Valeurs : CLOSES le 2026-09-03** — voir résidu ci-dessous |
| O-06.2 | Expiration d'inactivité | Différenciée par les mêmes catégories qu'O-04.1. **Valeurs : CLOSES le 2026-09-03** — voir résidu ci-dessous |
| O-06.3 | Step-up | Validé — obligatoire pour les opérations sensibles (socle hérité d'O-04.1 : administration tenant, financier à fort impact), indépendamment de la fraîcheur de session |
| O-06.4 | Poste partagé | Validé — expiration automatique courte + verrouillage manuel (« Verrouiller / Changer d'utilisateur »), sans détruire le contexte de travail non validé. **Précision du 2026-09-03** (ADR-0006 Amendement 1) : ce n'est **pas** une catégorie de durée de session serveur — aucun signal serveur ne permet de détecter un poste partagé ; ces postes utilisent la catégorie standard côté serveur, le verrouillage reste un mécanisme purement client |
| O-06.5 | Renouvellement | Validé — fenêtre glissante + plafond absolu + refresh token à rotation + détection de réutilisation + révocation de chaîne ; compatible avec le changement de contexte d'O-05 |

**Résidu — CLOS le 2026-09-03**, [ADR-0006 Amendement 1](adr/0006-refresh-token-rotation.md#amendement-1-2026-09-03--clôture-o-061o-062-valeurs-numériques-décision-ac-2-contrôle-applicatif-dexpiration) :

| Catégorie (O-04.1) | Plafond absolu (O-06.1) | Inactivité (O-06.2) |
|---|---:|---:|
| SUPER_ADMIN (plancher technique) | 4 h | 15 min |
| Admin tenant + finance à fort impact | 4 h | 15 min |
| Standard | 12 h | 30 min |

AC-2 (contrôle applicatif d'expiration) tranché dans le même amendement : enforcement synchrone à
chaque requête authentifiée + purge périodique pour le nettoyage — la purge n'est jamais l'autorité
de sécurité.

---

### O-07 — Canaux de notification réellement intégrés en V1
**MÉTIER + TECHNIQUE · CLOS le 2026-08-23 · Détail dans [01 §9.4](01-target-architecture.md#94-notifications-28-o-07-clos-le-2026-08-23)**

| # | Sujet | Décision |
|---|---|---|
| O-07.1 | Canaux V1 | **Email + SMS**, rôles distincts (email = administratif/facturation/non urgent ; SMS = RDV et rappels d'impayé, forte probabilité de lecture). Push hors V1 (dépend de l'app mobile, Phase 7). WhatsApp différé (BSP Meta + tarification non décidée) |
| O-07.2 | Contenu | Règle uniforme, sans exception : aucune donnée médicale en clair sur aucun canal ; **aucune pièce jointe par email**, clinique ou financière ; canal externe = notification d'existence uniquement |
| O-07.3 | Fournisseur SMS | Reporté — port `NotificationChannel` avec adaptateur interchangeable, aucune dépendance fournisseur dans le domaine |
| O-07.4 | WhatsApp | Hors V1, ajout ultérieur possible via adaptateur sans changement du domaine |
| O-07.5 | Rappels d'impayé (O-03.2) | SMS + email envoyés **systématiquement en parallèle**, sans logique de repli conditionnel entre canaux |

**Résidus explicites, à fermer avant la fin de Phase 0** :
1. Fournisseur SMS (comparaison agrégateur international / régional / API opérateur direct sur
   couverture Sénégal, délivrabilité, coût, SLA, conformité).
2. Calendrier exact des 3 rappels d'impayé dans la fenêtre de grâce de 7 jours (O-03.2).
3. Décision WhatsApp (BSP, tarification) — différée, pas seulement non choisie.

---

### O-25 — Prestataire de paiement SaaS (encaissement des abonnements d'établissement)
**TECHNIQUE + MÉTIER · CLOS STRUCTURELLEMENT le 2026-08-23 · Détail dans [01 §6.3](01-target-architecture.md#63-saas-core)**

Point présent depuis le début dans le diagramme de contexte (`01-target-architecture.md §1`,
nœud `PSP`) et dans la Saga de provisioning (§6.3, étape `InitiatePayment (externe, ACL)`),
mais jamais formellement numéroté ni fermé avant la revue de cohérence du 2026-08-23.
**Distinct d'O-18** : O-18 couvre les moyens de paiement du **patient** à l'établissement
(Phase 6, facturation) ; O-25 couvre l'encaissement de **l'abonnement de l'établissement à la
plateforme** (Phase 0, `PlatformInvoice`/`Payment`, §6.3) — deux flux, deux agrégats déjà
séparés, aucun credential ni compte de règlement partagé.

| # | Sujet | Décision |
|---|---|---|
| O-25.1 | Périmètre V1 | Abonnement initial + renouvellements + upgrade proratisé (aligné O-02.6). Remboursement d'abonnement SaaS explicitement **hors V1** (distinct d'O-22) |
| O-25.2 | Moyens de paiement | Mobile Money + carte bancaire. Virement exclu du flux automatisé `InitiatePayment`, réservé à un règlement manuel/commercial |
| O-25.3 | Prestataire | Différé — port `PaymentProvider` avec adaptateur interchangeable ; contraintes fixées (Mobile Money + carte, paiement récurrent/tokenisé, webhooks signés, idempotence, sandbox, règlement XOF si possible) |
| O-25.4 | Frais de transaction | Absorbés par la plateforme — l'établissement paie exactement le `PlanPrice` catalogue, aucun supplément selon le moyen de paiement |
| O-25.5 | Webhooks / échecs | Confirmation exclusivement serveur-à-serveur ; états réutilisés de la Saga (§5) ; idempotence ; signature obligatoire ; rapprochement périodique — le webhook n'est jamais l'unique source de vérité |
| O-25.6 | Jonction avec O-03 | Catalogue d'événements formalisé : `SubscriptionRenewalDue` (scheduler) → grâce si aucun `SUCCEEDED` confirmé → J+7 mode dégradé → J+37 maintien indéfini. `SubscriptionReactivated` immédiat dès paiement confirmé, à tout moment |
| O-25.7 | Architecture d'intégration | Résolue par construction : port `PaymentProvider` + Anti-Corruption Layer (D10), déjà acceptés — aucun fournisseur codé en dur dans le domaine |

**Résidus explicites, dépendants du prestataire retenu (paramètres opérationnels, pas des
décisions d'architecture non prises)** :
1. Fournisseur de paiement SaaS.
2. Compte de règlement légal (dépend aussi de la structure juridique de l'exploitant).
3. Fréquence des reversements.

**Décideur** : direction + responsable technique pour le choix final du prestataire (résidu 1).

---

## Bloquants Phase 2

### O-10 — Règle de détection de doublon patient
**MÉTIER · Bloquant Phase 2**

Créer deux dossiers pour un même patient est un risque de sécurité du soin (antécédents et
allergies invisibles). Le cahier des charges n'en parle pas.

**Non défini** : quels critères de rapprochement (nom + date de naissance + téléphone ?) ;
blocage strict ou avertissement à l'agent d'accueil ? ; existe-t-il une procédure de fusion de
dossiers, et qui l'autorise ? ; quel identifiant national de référence, s'il en existe un
exploitable au Sénégal ?

---

## Bloquants Phase 3 — DME et consultation

### O-08 — Définition du « contexte clinique » autorisant l'accès à un dossier
**MÉTIER · Bloquant Phase 3 · Le point le plus critique du projet**

Le §10 exige un accès contrôlé par « tenant + rôle + permission + **contexte clinique** ». Les
trois premiers sont mécaniques ; le quatrième est une **règle métier non spécifiée**.

**Non défini** : un médecin peut-il ouvrir n'importe quel dossier de son établissement, ou
seulement ceux de ses patients / de son service / d'un séjour en cours ? Un infirmier est-il
limité à son unité ? Que voit un pharmacien — la prescription seule ou le dossier ?

**Cas du bris de glace** : en urgence vitale, un praticien non rattaché doit pouvoir accéder au
dossier. Autorise-t-on un accès dérogatoire avec justification obligatoire et audit renforcé ?
Qui le contrôle a posteriori ?

**Aucune règle par défaut ne sera codée.** L'architecture prévoit le point d'extension
(`ClinicalAccessPolicy`), il restera vide jusqu'à arbitrage.

---

### O-11 — Rectification d'une consultation validée
**MÉTIER · Bloquant Phase 3**

Le §12 exige protection contre modification non autorisée et corrections auditables. Non
défini : **qui** peut rectifier (l'auteur seul ? un médecin-chef ?) ; dans **quel délai** ; un
motif est-il obligatoire ; la version antérieure reste-t-elle visible et par qui ; le patient
en est-il informé.

---

### O-16 — Référentiels de codification (diagnostics, actes, examens)
**MÉTIER · Bloquant Phase 3 (structure) / Phase 6 (facturation)**

Non défini : CIM-10 pour les diagnostics ? LOINC pour les examens de laboratoire ? Quelle
nomenclature d'actes médicaux fait référence au Sénégal, et est-elle celle qui sert de base à
la facturation ? Ce choix conditionne l'interopérabilité future **et** le lien acte ↔ tarif.

---

## Bloquants Phase 4

### O-09 — Échelle de triage aux urgences
**MÉTIER · Bloquant Phase 4**

Le §13 impose « triage, niveau de priorité » sans définir l'échelle. Il existe plusieurs
référentiels internationaux et des adaptations locales. **Le choix relève d'une décision
médicale**, pas technique : nombre de niveaux, libellés, délais cibles de prise en charge,
qui réalise le triage. Aucune échelle ne sera inventée.

### O-14 — Règles de maternité et de dossier mère-enfant
**MÉTIER · Bloquant Phase 4**

Non défini : à quel instant le nouveau-né obtient un `PatientNumber` et un dossier propre ;
traitement des naissances multiples ; traitement de la mortinaissance et du décès néonatal ;
durée de rattachement du dossier enfant au dossier mère ; qui peut accéder au dossier de
l'enfant.

### O-21 — Périmètre du dossier de soins infirmiers
**MÉTIER · Bloquant Phase 4**

Le §14 mentionne « soins » et « suivi » sans les détailler. Contenu exact, fréquence de
relevé des constantes, transmissions ciblées, contre-signature : non défini.

---

## Bloquants Phase 6 — Financier

### O-12 — Règles d'assurance, tiers payant et ticket modérateur
**MÉTIER · Bloquant Phase 6 · Impact financier direct**

Le §21 énumère les concepts (taux de prise en charge, plafonds, actes couverts, tiers payant,
part patient/assureur, rejets, créances) mais **aucune règle de calcul**.

**Non défini, donc non inventé** : ordre d'application taux/plafond ; comportement au
dépassement de plafond ; règle d'arrondi en XOF (montant entier obligatoire — l'arrondi crée
mécaniquement un écart à imputer) ; traitement des actes non couverts ; procédure et
comptabilisation des rejets ; couverture multiple (assurance + mutuelle) ; interaction avec
les dispositifs publics de couverture santé.

**Toute erreur ici a un impact financier réel sur le patient et sur l'établissement.**

### O-13 — Mapping recettes hospitalières → plan comptable SYSCOHADA
**MÉTIER · Bloquant Phase 6**

Non défini : quels comptes SYSCOHADA pour les recettes de consultation, d'hospitalisation, de
laboratoire, d'imagerie, de pharmacie ; comptes de créances patients et assureurs ; TVA
applicable ou non aux prestations de santé au Sénégal ; niveau de détail des journaux ;
génération automatique ou validation manuelle des écritures depuis la facturation.

**Décideur attendu** : expert-comptable OHADA. **Aucun mapping ne sera présumé.**

### O-18 — Moyens de paiement patient réellement intégrés
**MÉTIER + TECHNIQUE · Bloquant Phase 6**

Le §22 cite espèces, carte, mobile money, virement. Espèces et virement sont de simples
enregistrements ; **carte et mobile money exigent une intégration réelle**.

**À valider** : quels opérateurs Mobile Money en V1 (Orange Money, Wave, Free Money) ? Quels
contrats commerciaux existent ? Chaque intégration = un ACL, une réconciliation, des webhooks
signés, un rejeu. **Aucun moyen de paiement ne sera affiché dans l'interface s'il n'est pas
effectivement intégré et testé.**

### O-22 — Politique d'annulation et de remboursement de facture
**MÉTIER · Bloquant Phase 6**

Le §20 cite « annulations, remboursements » sans règle. Non défini : une facture encaissée
peut-elle être annulée ou seulement avoir un avoir ? Qui autorise ? Quel impact comptable
(extourne obligatoire) ? Quel délai ?

---

## Bloquants Phase 7

### O-17 — Résolution des conflits de synchronisation mobile
**MÉTIER · Bloquant Phase 7**

Principe posé : le serveur fait autorité, et un conflit sur donnée clinique n'est **jamais**
résolu automatiquement. Non défini : qui arbitre, dans quelle interface, sous quel délai ; que
voit l'utilisateur mobile pendant l'attente ; quelles données sont trop sensibles pour être
créées hors-ligne.

### O-19 — Stratégie DICOM / PACS
**TECHNIQUE + MÉTIER · Bloquant Phase 7**

Non défini : les établissements cibles disposent-ils déjà d'un PACS ? La plateforme doit-elle
en héberger un, s'y connecter, ou seulement référencer des études externes ? Le stockage
d'images DICOM a un coût de stockage et de bande passante **considérable**, difficilement
compatible avec la connectivité régionale. **Recommandation : se limiter au référencement et
au compte rendu**, sans gestion de pixels — à confirmer.

### O-20 — Profondeur de la conformité FHIR / HL7
**TECHNIQUE + MÉTIER · Bloquant Phase 7**

Non défini : quel besoin d'échange concret existe (échange inter-établissements, remontée vers
un système national de santé, laboratoire externe) ? Sans cas d'usage identifié, implémenter
FHIR serait de l'abstraction prématurée. **Quel besoin réel justifie l'investissement ?**

---

## Non bloquants, à trancher avant la mise en production

### O-15 — Rétention et purge du journal d'audit
**MÉTIER + juridique**

Durée de conservation, volumétrie attendue, stratégie d'archivage, et surtout **cadre
réglementaire applicable au Sénégal en matière de données de santé** — que ce document ne
présume pas.

### O-23 — Portail patient
**MÉTIER**

Le §11 le mentionne comme optionnel (« si retenu »). Hors scope V1. Sa réintroduction ouvrirait
une surface d'exposition externe sur des données de santé et exigerait sa propre revue de
sécurité.

### O-24 — Établissement multi-sites et groupes hospitaliers
**MÉTIER**

Le modèle actuel : un établissement = un tenant, les sites étant internes. Non défini : un
groupe possédant plusieurs établissements attend-il une vue consolidée inter-tenants ? Cette
fonctionnalité entrerait en conflit direct avec le principe d'isolation stricte et exigerait
une conception dédiée.

---

## Résidus techniques CI (hors décisions O-*)

> Cette section ne fait pas partie des décisions métier/technique O-01…O-25 ci-dessus : ce sont
> des résidus de fiabilité d'infrastructure de test, sans impact sur le comportement applicatif
> ni sur les preuves de sécurité déjà établies. Ils ne bloquent aucune phase et ne doivent
> **jamais** être corrigés en passant, hors mandat explicite.

### CI-01 — Race de seeding global `Permission.code` entre workers de test
**TECHNIQUE · Ouvert · Non bloquant**

- **Découvert** : étape 12 (2026-09-04), lors de la revue du run CI du commit `95c4b02`
  (référence break-glass SUPER_ADMIN), qui avait en réalité échoué.
- **Symptôme** : `refreshTokenRotation.test.ts` échoue avec `P2002` sur `Permission.code`.
- **Cause suspectée** : `seedPermissionCatalog()` exécuté concurremment par plusieurs workers de
  test sur une base PostgreSQL partagée en CI (concurrence plus élevée qu'en local).
- **Impact** : échec CI intermittent, sans défaut applicatif démontré — confirmé comme flake
  d'infrastructure (le commit suivant, même code de seed, est passé sans problème).
- **Action future** : isoler le seed par worker/fichier, ou rendre son exécution concurrente
  sûre (upsert idempotent, verrou, ou fixture partagée en lecture seule).
- **Ne pas traiter en passant** pendant une autre étape sans mandat explicite. Ne rouvre pas
  l'étape 12 (`649a7b6`, CLOSE, 784/784 tests, CI verte, revue sécurité indépendante GO).

### CI-02 — Timeout intermittent `outboxRelay.test.ts` (verrou périmé) sous charge de test parallèle
**TECHNIQUE · Ouvert · Non bloquant**

- **Découvert** : étape 12, item 9 (2026-09-05), en fermant le rate limiting audit-entries/webhook
  (commit `fa015d1`, ADR-0011).
- **Symptôme** : `test/shared-kernel/integration/outboxRelay.test.ts` (scénario « verrou périmé »)
  échoue par `Error: Test timed out in 20000ms` uniquement en suite complète (`pnpm -r run test`),
  jamais en isolation (vert, ~2,9 s).
- **Cause suspectée** : le mécanisme *stalled* BullMQ du test (configuré à ~300 ms) et la
  réclamation de verrou sont sensibles à la charge CPU/IO globale de la suite ; le volume de test
  ajouté par l'item 9 (un seul fichier, `auditEntriesRateLimiting.test.ts`, dure ~93 s à lui seul)
  a rendu ce timeout plus probable, sans lien de code : `outboxRelay.test.ts` n'importe ni
  `composition-root.ts`, ni `server.ts`, ni aucun fichier de rate-limiting — sa propre connexion
  Redis/Postgres est indépendante.
- **Impact** : échec CI/local intermittent sous charge parallèle réelle, sans défaut applicatif
  démontré — même famille que `CI-01` (temporisation fragile sous concurrence de test, pas une
  régression du code testé).
- **Action future** : desserrer la marge du scénario « verrou périmé » (délai de test très proche
  du seuil de détection *stalled*), ou isoler ce fichier du parallélisme Vitest.
- **Ne pas traiter en passant** pendant une autre étape sans mandat explicite. Ne rouvre pas
  l'étape 12/item 9 (`fa015d1`, CLOSE, 817/817 tests verts sur l'exécution de clôture, gates vertes,
  deux revues de sécurité indépendantes, GO final).

---

## Suivi

| ID | Sujet | Type | Bloque | Statut | Décideur |
|---|---|---|---|---|---|
| O-01 | Base de données | TECHNIQUE | P0 | **Clos (2026-08-23) — Option B** | Resp. technique |
| O-02 | Tarification forfaits (7 sous-points) | MÉTIER | P0 | **Clos (2026-08-23), reliquat technique clos (2026-08-24)** | Direction |
| O-03 | Impayé / suspension | MÉTIER | P0 | **Clos sous réserve juridique (2026-08-23)** | Direction + juridique |
| O-04 | Périmètre MFA (7 sous-points) | MIXTE | P0 | **Clos (2026-09-03)** — récupération ADMIN_ETABLISSEMENT + break-glass SUPER_ADMIN fermés (amendement ADR-0005) ; WebAuthn/Passkey (O-04.3) toujours différé, hors périmètre de cette clôture | Direction + technique |
| O-05 | Multi-établissement / utilisateur | MÉTIER | P0 | **Clos (2026-08-23)** | Direction |
| O-06 | Durée de session (5 sous-points) | MIXTE | P0 | **Clos (2026-09-03)** — valeurs numériques et AC-2 tranchés (amendement ADR-0006) | Direction |
| O-07 | Canaux de notification (5 sous-points) | MIXTE | P0 | **Clos (2026-08-23)** — 3 résidus (fournisseur SMS, calendrier rappels, WhatsApp) | Direction |
| O-08 | Contexte clinique d'accès | MÉTIER | P3 | Ouvert | Direction médicale |
| O-09 | Échelle de triage | MÉTIER | P4 | Ouvert | Direction médicale |
| O-10 | Doublon patient | MÉTIER | P2 | Ouvert | Direction médicale |
| O-11 | Rectification consultation | MÉTIER | P3 | Ouvert | Direction médicale |
| O-12 | Assurance / tiers payant | MÉTIER | P6 | Ouvert | Direction financière |
| O-13 | Mapping SYSCOHADA | MÉTIER | P6 | Ouvert | Expert-comptable OHADA |
| O-14 | Règles maternité | MÉTIER | P4 | Ouvert | Direction médicale |
| O-15 | Rétention audit | MIXTE | Prod | Ouvert | Juridique |
| O-16 | Référentiels de codification | MÉTIER | P3 | Ouvert | Direction médicale |
| O-17 | Conflits sync mobile | MÉTIER | P7 | Ouvert | Direction médicale |
| O-18 | Moyens de paiement patient | MIXTE | P6 | Ouvert | Direction |
| O-19 | DICOM / PACS | MIXTE | P7 | Ouvert | Direction + technique |
| O-20 | Profondeur FHIR / HL7 | MIXTE | P7 | Ouvert | Direction |
| O-21 | Dossier de soins infirmiers | MÉTIER | P4 | Ouvert | Direction des soins |
| O-22 | Annulation / remboursement | MÉTIER | P6 | Ouvert | Direction financière |
| O-23 | Portail patient | MÉTIER | — | Hors scope V1 | Direction |
| O-24 | Multi-sites / groupes | MÉTIER | — | Ouvert | Direction |
| O-25 | Prestataire de paiement SaaS (7 sous-points) | MIXTE | P0 | **Clos structurellement (2026-08-23)** — 3 résidus opérationnels (fournisseur, compte de règlement, fréquence) | Direction + technique |
