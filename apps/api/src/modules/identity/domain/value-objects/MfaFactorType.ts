/**
 * Type de second facteur. SEULE valeur emise a cette etape : `TOTP` (ADR-0005, residu 5 —
 * WebAuthn/Passkey differe par arbitrage du responsable technique). Aucune valeur non emise
 * n'est declaree ici, meme discipline que `SubscriptionPlanChangeType`/`PlatformInvoicePurpose`.
 */
export type MfaFactorType = 'TOTP';
