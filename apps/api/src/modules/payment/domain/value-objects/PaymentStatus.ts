/**
 * Six valeurs EXACTES imposees par O-25.5 : "Etats reutilises tels quels de la Saga (§5/§6.3),
 * aucune nouvelle machine a etats : PENDING/SUCCEEDED/FAILED/EXPIRED/ANNULE/RENOUVELE" —
 * identifiants traduits en anglais (convention du depot : "code et identifiants en anglais"),
 * aucune valeur ajoutee ni retranchee.
 *
 * POINT SIGNALE A L'ARCHITECTE (interpretation non totalement contrainte par l'ADR) : le texte
 * source ne detaille pas la nuance exacte entre `SUCCEEDED` et `RENEWED` au niveau d'UNE
 * tentative de paiement individuelle (il decrit un catalogue d'etats de Saga/abonnement, pas
 * une machine a etats de `Payment` a proprement parler). Choix retenu ici, le plus litteral
 * possible : `SUCCEEDED` marque la confirmation d'un paiement de PURPOSE `INITIAL`/`UPGRADE`,
 * `RENEWED` marque la confirmation d'un paiement de PURPOSE `RENEWAL` — les deux sont des succes
 * TERMINAUX equivalents du point de vue de la machine a etats (voir `isTerminalSuccess`
 * ci-dessous, et `Payment.confirmSucceeded()`), seul le libelle differe selon le contexte
 * metier. Une autre lecture defendable aurait ete de n'utiliser JAMAIS `RENEWED` sur `Payment`
 * et de le reserver a un evenement/statut cote `Subscription` (c'est d'ailleurs EGALEMENT fait —
 * voir `subscription/domain/events/SubscriptionRenewed.ts` — la nuance est donc portee deux
 * fois, une fois par agregat concerne). A valider par l'architecte si une simplification
 * (fusionner `RENEWED` dans `SUCCEEDED` sur `Payment`) est preferable.
 */
export const PAYMENT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'RENEWED'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** `SUCCEEDED` et `RENEWED` sont deux succes TERMINAUX equivalents (voir commentaire de tete de fichier) : jamais retrogradables par un webhook ulterieur (argent deja recu). */
export function isTerminalSuccessStatus(status: PaymentStatus): boolean {
  return status === 'SUCCEEDED' || status === 'RENEWED';
}
