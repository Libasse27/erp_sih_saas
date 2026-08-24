/**
 * Statut de cycle de vie minimal de l'abonnement (Phase 0, etape 4/13). Volontairement reduit a
 * ce qui est necessaire pour representer un abonnement actif et son historique de changements de
 * forfait — meme choix de minimalisme que `FacilityStatus` (module tenant/, etape 3) : aucun etat
 * pilote par la politique d'impaye (O-03 : grace, mode degrade...) n'est invente ici, ce sera la
 * responsabilite d'une etape ulterieure (Saga provisioning + impaye, etape 10), qui composera
 * avec ce statut sans le remplacer.
 *
 * - `TRIALING` : essai gratuit (O-02.5), forfait STANDARD, `trialEndsAt` renseigne, aucun moyen
 *   de paiement requis a l'activation.
 * - `ACTIVE` : abonnement payant en cours (paiement reel hors perimetre, etape 5 — le passage de
 *   `TRIALING` a `ACTIVE` n'est donc pas implemente par ce module, seul l'etat existe).
 */
export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE'] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
