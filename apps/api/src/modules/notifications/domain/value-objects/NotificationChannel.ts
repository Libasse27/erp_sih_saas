/**
 * Canaux V1 (O-07.1, docs/architecture/01-target-architecture.md §9.4) — Push et WhatsApp sont
 * explicitement hors V1 (residus O-07), aucune valeur non emise n'est declaree par anticipation
 * ici (meme discipline que `MfaFactorType`).
 */
export type NotificationChannel = 'EMAIL' | 'SMS';
