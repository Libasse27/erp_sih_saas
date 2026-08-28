/**
 * Catalogue FERME des types de notification (ADR-0007 §1/§7) — seuls deux declencheurs sont
 * cables a cette etape (`SubscriptionStarted`/`SubscriptionPlanChanged`, deja designes comme
 * hooks etape 9 dans docs/domain/events.md). Aucune valeur non emise n'est declaree par
 * anticipation (meme discipline que `MfaFactorType`/`SubscriptionPlanChangeType`).
 */
export type NotificationTemplateKind = 'SUBSCRIPTION_WELCOME' | 'SUBSCRIPTION_PLAN_CHANGED';
