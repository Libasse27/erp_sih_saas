/**
 * Categorie de premier niveau du journal d'audit plateforme. `MFA` emise depuis l'etape 7/13
 * (ADR-0005) ; `SESSION` ajoutee a l'etape 8/13 (ADR-0006 §8 : cycle de vie du refresh token).
 *
 * Etendue a l'etape 11/13 (ADR-0009 §2) a SIX valeurs : la categorie decrit la NATURE du fait
 * audite, jamais l'identite de qui l'a produit (cette derniere information est portee par
 * `actorKind`, voir `AuditEntry.ts`) :
 *   - `PROVISIONING` : faits de la Saga de provisioning (ADR-0008) — naissance d'un etablissement.
 *   - `MEMBERSHIP`   : agregat `UserTenantMembership`/`MembershipRole` mute.
 *   - `SUBSCRIPTION` : cycle de vie commercial de l'abonnement, mode degrade compris.
 *   - `BILLING`      : `Payment` (encaissement PSP) ET `PlatformInvoice` (emission/reglement).
 *   - `AUDIT_ACCESS` : consultation du journal lui-meme.
 * Aucune categorie `PLATFORM_ADMIN` n'est ajoutee (ADR-0009 §2 : aucune commande productrice
 * n'existe encore dans ce depot).
 *
 * `TENANT_CONFIG` ajoutee Phase 1, premier increment vertical (permission
 * `tenant-config:administer`) : premiere commande productrice de ce depot pour cette categorie
 * jusque-la seulement anticipee par ADR-0009 §2 (`RenameHealthFacility.ts`, module `tenant`).
 */
export type AuditCategory =
  | 'MFA'
  | 'SESSION'
  | 'PROVISIONING'
  | 'MEMBERSHIP'
  | 'SUBSCRIPTION'
  | 'BILLING'
  | 'AUDIT_ACCESS'
  | 'TENANT_CONFIG';
