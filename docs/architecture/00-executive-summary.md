# 00 — Résumé exécutif : Plateforme SIH SaaS multi-établissements

- **Statut** : **🔒 GELÉ — Phase 0 (SaaS Core) autorisée à l'implémentation depuis le
  2026-08-23.** Les 8 décisions structurantes de Phase 0 (O-01 à O-07, O-25) sont closes.
  Le gel porte sur les invariants d'architecture, pas sur les résidus opérationnels listés en
  §5, qui peuvent être fermés pendant la phase.
- **Date** : 2026-08-23
- **Auteur** : Architecture
- **Portée** : document d'architecture cible.
- **Règle de gouvernance post-gel** : toute modification touchant un invariant architectural
  (multi-tenancy/RLS, modèle Plan/PlanPrice, UserTenantMembership, machine à états de paiement,
  chaîne impayé → grâce → mode dégradé, séparation clinique/financier) passe par un **nouvel
  ADR ou la réouverture explicite de l'ADR concerné** — jamais par une décision prise dans le
  code. Les résidus opérationnels (valeurs numériques, choix de fournisseur) n'ont pas besoin
  d'ADR : ce sont des paramètres, pas des invariants.

---

## 1. Vision

Construire une **plateforme SaaS de Système d'Information Hospitalier (SIH)** permettant à
N établissements de santé indépendants (hôpital, clinique, centre de santé, cabinet,
laboratoire, centre d'imagerie, maternité, pharmacie, polyclinique) d'exploiter chacun un
SIH complet sur une infrastructure mutualisée, avec une **isolation stricte des données**
entre établissements.

Marché prioritaire : **Sénégal / Afrique de l'Ouest** (`fr-SN`, `Africa/Dakar`, `XOF`,
référentiel comptable **SYSCOHADA**, paiement **Mobile Money**), architecture extensible à
d'autres pays.

Trois niveaux hiérarchiques :

```
Super Admin plateforme  (exploitant du SaaS)
        │
   SaaS Core  (Auth · RBAC · Tenants · Plans · Abonnements · Paiements · Audit · Notifications)
        │
   N Tenants = N établissements de santé  (données strictement cloisonnées)
```

## 2. État du dépôt

Le dépôt est **vide** (greenfield). Contrairement à ce que suggère l'énoncé initial,
**il n'existe aucun ERP à analyser ni à migrer**. Le vocabulaire « migration » est donc
remplacé partout par « construction ». Le SaaS Core est à **construire**, pas à réutiliser.

## 3. Ordre de priorité imposé (non négociable)

> **SÉCURITÉ > INTÉGRITÉ DES DONNÉES > CONFIDENTIALITÉ MÉDICALE > COHÉRENCE MÉTIER >
> FIABILITÉ > TESTS > PERFORMANCE > UX > NOUVELLES FONCTIONNALITÉS**

Conséquence directe et assumée : **le rythme de livraison fonctionnelle sera lent au
démarrage**. Aucun module médical ne sera ouvert avant que l'isolation tenant, le RBAC et
l'audit ne soient prouvés par des tests automatisés. Toute demande d'accélération se paie
en dette de sécurité, ce qui est explicitement refusé ici.

## 4. Décisions structurantes prises

| # | Décision | Statut | Référence |
|---|----------|--------|-----------|
| D1 | **Multi-tenancy : schéma partagé + colonne `tenant_id` + Row-Level Security PostgreSQL**, avec porte de sortie « schéma dédié » pour un établissement à exigence réglementaire particulière | **Accepté** | [ADR-0001](adr/0001-multi-tenancy-strategy.md) |
| D2 | **Stack données : PostgreSQL seul (Option B)**, y compris pour le documentaire clinique via JSONB — MongoDB écarté en V1 | **Accepté (2026-08-23)** | [ADR-0002](adr/0002-database-stack.md) |
| D3 | **Clean Architecture + DDD + CQRS** ; un Bounded Context = un module ; le domaine ne dépend d'aucun framework | Accepté | [01](01-target-architecture.md#5-organisation-du-code) |
| D4 | **Monorepo** `apps/` + `packages/` (web, mobile, desktop, api, ui, types, auth, validation, config) | Accepté | [01](01-target-architecture.md#4-monorepo) |
| D5 | **Détection du contexte de connexion côté serveur uniquement.** Le client ne choisit jamais son tenant ni son rôle | Accepté | [01](01-target-architecture.md#7-securite) |
| D6 | **Forfaits et limites pilotés par la donnée**, administrés par le Super Admin ; aucun forfait codé en dur côté frontend | Accepté | [01](01-target-architecture.md#63-saas-core) |
| D7 | **Audit d'accès au dossier patient en journal append-only**, séparé des logs applicatifs | Accepté | [01](01-target-architecture.md#73-audit-medical-32) |
| D8 | **Interopérabilité FHIR R4 / HL7 v2 / DICOM : couche préparée, non implémentée en V1.** Aucune conformité ne sera annoncée sans test de conformité passé | Accepté | [01](01-target-architecture.md#10-interoperabilite) |
| D9 | **Outbox Pattern** pour tout événement métier ; consommateurs idempotents | Accepté | [01](01-target-architecture.md#93-evenementiel) |
| D10 | Toute intégration externe (Mobile Money, assureur, PACS, laboratoire externe) passe par un **Anti-Corruption Layer** | Accepté | [01](01-target-architecture.md#10-interoperabilite) |
| D11 | **Tarification (O-02)** : `Plan` ≠ `PlanPrice` historisé ; STANDARD/PROFESSIONNEL/COMPLET à 35k/55k/75k FCFA mois (350k/550k/750k FCFA an) ; facturation par établissement, limites hybrides ; essai 30j sans CB ; upgrade immédiat/downgrade différé ; remises par coupons Super Admin ; TVA configurable non présumée | Accepté | [01 §6.3](01-target-architecture.md#63-saas-core) |
| D12 | **Impayés (O-03)** : 7 jours de grâce, puis mode dégradé pendant 30 jours ; au-delà, maintien indéfini du mode dégradé. Aucune suppression de données ni interruption de la continuité des soins pour motif d'impayé. Trois rappels prévus, en SMS + email systématiquement parallèles (O-07) ; calendrier exact des rappels dans la fenêtre encore en résidu | **Accepté sous réserve juridique** | [01 §6.3](01-target-architecture.md#63-saas-core) |
| D13 | **MFA (O-04)** : déclenché par catégorie de permission (SUPER_ADMIN, admin tenant, finance à fort impact), pas par nom de rôle ; socle plateforme non désactivable, renforçable par établissement ; TOTP primaire + WebAuthn alternatif, SMS exclu du facteur primaire ; aucune désactivation silencieuse, ré-enrôlement audité uniquement ; rôles cliniques génériques hors périmètre V1 | **Accepté — 3 résidus opérationnels ouverts** | [01 §7.1](01-target-architecture.md#71-authentification-et-contexte) |
| D14 | **Multi-établissement (O-05)** : identité unique (`UserAccount`) + `UserTenantMembership` par établissement, rôles portés par le membership, plusieurs rôles simultanés autorisés (union additive) ; changement d'établissement = nouveau contexte de session, jamais mutation en place ; quota `maxUsers` compte les memberships, MFA du membership = le plus restrictif des rôles | Accepté | [01 §6.3](01-target-architecture.md#63-saas-core) |
| D15 | **Sessions (O-06)** : plafond absolu + expiration d'inactivité différenciés par catégorie de sensibilité, alignés sur les catégories MFA d'O-04.1 ; step-up pour opérations sensibles ; verrouillage manuel + expiration courte sur poste partagé ; fenêtre glissante avec refresh token à rotation | **Accepté — valeurs numériques en résidu** | [01 §7.1](01-target-architecture.md#71-authentification-et-contexte) |
| D16 | **Notifications (O-07)** : Email + SMS en V1 (rôles distincts), Push hors V1 (Phase 7), WhatsApp différé ; règle uniforme sans exception — aucune donnée médicale en clair, aucune pièce jointe email ; rappels d'impayé en SMS+email systématiquement parallèles ; port `NotificationChannel` sans dépendance fournisseur dans le domaine | **Accepté — 3 résidus (fournisseur SMS, calendrier rappels, WhatsApp)** | [01 §9.4](01-target-architecture.md#94-notifications-28-o-07-clos-le-2026-08-23) |
| D17 | **Paiement SaaS (O-25)** : périmètre V1 = abonnement + renouvellements + upgrade proratisé, remboursement SaaS hors V1 ; Mobile Money + carte, virement en manuel ; frais absorbés par la plateforme (prix catalogue inchangé) ; confirmation serveur-à-serveur uniquement, port `PaymentProvider` sous ACL sans fournisseur codé en dur ; grâce O-03 déclenchée par échéance (scheduler), pas seulement par webhook `FAILED` ; réactivation immédiate dès paiement confirmé | **Accepté — 3 résidus opérationnels (fournisseur, compte de règlement, fréquence de reversement)** | [01 §6.3](01-target-architecture.md#63-saas-core) |

## 5. Ce qui reste ouvert (bloquant à divers degrés)

**État au 2026-08-23** : **les 8 décisions structurantes de Phase 0 (O-01 à O-07, O-25) sont
closes** — voir §4 ci-dessus (D2, D11-D17). Une revue de cohérence a fait remonter un point
resté sans numéro depuis le début (O-25, prestataire de paiement SaaS), formalisé et clos dans
la foulée. Voir [03-open-decisions.md](03-open-decisions.md) pour la liste complète (25 points).
**Aucune décision d'architecture P0 ne reste non traitée.**

- **Résidus de Phase 0 déjà close, à fermer avant la fin de la phase (pas avant son
  démarrage) — paramètres opérationnels, pas des décisions d'architecture manquantes** :
  validation juridique de la politique d'impayé (O-03) ; procédures de récupération MFA pour
  `ADMIN_ETABLISSEMENT` et *break-glass* `SUPER_ADMIN` (O-04) ; valeurs numériques des plafonds
  de session et paliers d'inactivité (O-06) ; fournisseur SMS, calendrier des rappels d'impayé,
  décision WhatsApp (O-07) ; seuils numériques des forfaits et méthode de proratisation (O-02) ;
  fournisseur de paiement SaaS, compte de règlement, fréquence de reversement (O-25).
- **Bloquant Phase 3+** : règles de correction d'une consultation validée ; définition du
  « contexte clinique » autorisant l'accès à un dossier ; politique de bris de glace en
  urgence vitale.
- **Bloquant Phase 6** : mécanique tiers payant, ticket modérateur, plafonds assureur ;
  mapping des recettes hospitalières vers le plan comptable SYSCOHADA.

Aucun workflow clinique, aucune règle de remboursement et aucun barème ne figurent dans ce
document au-delà de ce que le cahier des charges énonce explicitement. **Rien n'est inventé.**

## 6. Hors scope à ce stade

| Hors scope | Motif |
|---|---|
| Implémentation DICOM / PACS, viewer d'images | Coût et exigence matérielle disproportionnés en V1 ; seuls les **métadonnées et le compte rendu** sont modélisés |
| Serveur FHIR complet, échange HL7 v2 en production | Couche préparée uniquement (D8) |
| Portail patient public | Mentionné comme optionnel au §11 du cahier des charges ; non retenu en V1 |
| Aide à la décision clinique, alertes d'interaction médicamenteuse | Non demandé ; relèverait du dispositif médical, avec exigences réglementaires propres |
| Paie complète Sénégal (IPRES, CSS, CFCE, IR, TRIMF) | Le cahier des charges §26 ne demande que **personnel, contrats, horaires, planning, congés, absences, gardes, astreintes**. La paie est un module ultérieur |
| Canaux WhatsApp / Push | Ne seront exposés que s'ils sont réellement intégrés et testés (§28) ; V1 = **email + SMS** (O-07, D16), WhatsApp différé et Push dépendant de l'app mobile (Phase 7) |
| Facturation multi-devise | `XOF` uniquement en V1 |

## 7. Recommandation

1. **Valider les 4 points bloquants Phase 0** listés en §5 avant toute ligne de code.
2. Geler ensuite les **contrats** (ports, DTO, événements, OpenAPI) du SaaS Core.
3. N'ouvrir la Phase 1 qu'après un **test automatisé de non-fuite inter-tenant** au vert en
   intégration continue, exécuté sur chaque agrégat exposé.

---

**Documents liés**
- [01-target-architecture.md](01-target-architecture.md) — architecture cible détaillée
- [02-roadmap-migration.md](02-roadmap-migration.md) — feuille de route en 8 phases
- [03-open-decisions.md](03-open-decisions.md) — points à valider
- [adr/0001-multi-tenancy-strategy.md](adr/0001-multi-tenancy-strategy.md)
- [adr/0002-database-stack.md](adr/0002-database-stack.md)
