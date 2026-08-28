/**
 * Vocabulaire de statut (ADR-0007 §5) — etend `queued/sent/delivered/failed`
 * (01-target-architecture.md §9.4) de facon justifiee, jamais un simple remap terminologique :
 *
 * - `PENDING` : en file, prochaine tentative pas encore due (respect du backoff).
 * - `PROCESSING` : reclamee par un worker, envoi en cours.
 * - `SENT` : le fournisseur a accepte l'envoi. Pas de `DELIVERED` : aucun adaptateur reel n'expose
 *   de confirmation de livraison en V1 (les deux canaux sont Sandbox, ADR-0007 §3) — annoncer un
 *   etat qu'aucun fournisseur ne confirme reellement serait la meme faute que d'annoncer une
 *   conformite non testee (meme discipline que FHIR/DICOM, O-19/O-20).
 * - `FAILED` : erreur DEFINITIVE, jamais retentee (ex. destinataire structurellement invalide) —
 *   distinct de `DEAD_LETTER`.
 * - `DEAD_LETTER` : echecs TRANSITOIRES repetes jusqu'a epuisement de `NOTIFICATION_MAX_ATTEMPTS`.
 */
export type NotificationStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'DEAD_LETTER';
