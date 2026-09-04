/**
 * Catalogue FERME des types de notification (ADR-0007 §1/§7). Etendu par ADR-0005 Amendement 1
 * (O-04 residu 4) : alerte immediate aux autres `SUPER_ADMIN` a l'ouverture et a l'approbation
 * d'une demande de recuperation break-glass — aucune valeur non emise n'est declaree par
 * anticipation (meme discipline que `MfaFactorType`/`SubscriptionPlanChangeType`).
 */
export type NotificationTemplateKind =
  | 'SUBSCRIPTION_WELCOME'
  | 'SUBSCRIPTION_PLAN_CHANGED'
  | 'SUPER_ADMIN_BREAK_GLASS_REQUESTED'
  | 'SUPER_ADMIN_BREAK_GLASS_APPROVED';
