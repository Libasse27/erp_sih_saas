import type { Request, Response } from 'express';
import type { ConfirmPaymentHandler } from '../../application/commands/ConfirmPayment.js';

export interface PaymentWebhookControllerLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * SEUL endpoint HTTP de ce module (et du depot a ce stade) : confirmation de paiement
 * serveur-a-serveur (O-25.5). Monte SANS `express.json()` en amont (voir server.ts :
 * `express.raw()` scope a cette seule route, AVANT le middleware JSON global) — la verification
 * de signature HMAC porte sur le CORPS BRUT exact recu, jamais sur une re-serialisation JSON qui
 * pourrait differer octet pres (ordre des cles, espaces...).
 *
 * Repond TOUJOURS 200, quelle que soit l'issue (signature invalide, payload illisible,
 * transaction inconnue, ou traitement reussi) — c'est la traduction HTTP de "rejet silencieux,
 * pas d'erreur qui fuite d'info" (O-25.5) : un appelant ne peut jamais distinguer, par le code de
 * statut ou le corps de reponse, POURQUOI une notification a ete ignoree. Seuls les logs internes
 * (jamais exposes a l'appelant) portent le detail, pour l'observabilite operationnelle.
 *
 * Aucun document de domaine expose dans la reponse (regle §6) : le corps de reponse est toujours
 * vide.
 */
export class PaymentWebhookController {
  constructor(
    private readonly confirmPayment: ConfirmPaymentHandler,
    private readonly logger?: PaymentWebhookControllerLogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      const signatureHeaderRaw = req.header('x-payment-signature');
      const signatureHeader = signatureHeaderRaw === undefined || signatureHeaderRaw === null ? undefined : signatureHeaderRaw;

      await this.confirmPayment.execute({ rawBody, signatureHeader });
    } catch (error) {
      // Erreur technique inattendue (bug, incoherence de donnees) : jamais de detail expose au
      // corps de reponse (regle §3.3 sur les codes 500), le webhook recoit quand meme 200 pour
      // ne pas fuiter d'information ni provoquer une boucle de re-livraison agressive du PSP —
      // le rapprochement periodique (O-25.5) rattrape ce cas independamment.
      this.logger?.error(
        { event: 'payment.webhook.unhandled-error', error: error instanceof Error ? error.message : String(error) },
        'Erreur inattendue lors du traitement du webhook paiement',
      );
    } finally {
      res.status(200).end();
    }
  };
}
