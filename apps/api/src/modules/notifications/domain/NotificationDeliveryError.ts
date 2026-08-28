/**
 * Erreur portee par le contrat des ports `EmailProvider`/`SmsProvider` (ADR-0007 §5) — distingue
 * EXPLICITEMENT une erreur DEFINITIVE (`retryable: false`, ex. destinataire structurellement
 * invalide, rejet permanent du fournisseur) d'une erreur TRANSITOIRE (`retryable: true`, ex.
 * timeout, indisponibilite temporaire, erreur 5xx). Cette distinction n'est JAMAIS devinee cote
 * worker a partir du message d'erreur (fragile, jamais fiable) — c'est l'adaptateur, seul a
 * connaitre la semantique reelle du fournisseur, qui la porte.
 */
export class NotificationDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'NotificationDeliveryError';
    this.retryable = retryable;
  }
}
