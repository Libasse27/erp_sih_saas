/**
 * Categorie de premier niveau du journal d'audit plateforme. `MFA` emise depuis l'etape 7/13
 * (ADR-0005) ; `SESSION` ajoutee a l'etape 8/13 (ADR-0006 §8 : cycle de vie du refresh token).
 * Le module `audit` est concu pour recevoir d'autres categories a l'etape 11/13 (§7.3 : audit
 * medical, ecritures comptables validees...) — aucune valeur non emise n'est declaree par
 * anticipation ici, meme discipline que `MfaFactorType`/`PlatformInvoicePurpose`.
 */
export type AuditCategory = 'MFA' | 'SESSION';
