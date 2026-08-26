import type { PrismaClient } from '@prisma/client';
import type { OutboxEventEnvelope, OutboxEventHandler } from '../../application/OutboxEventHandler.js';

/**
 * Registre GENERIQUE d'idempotence consommateur (etape 6/13, D9 : "tout consommateur est
 * idempotent -> cle d'idempotence + registre des evenements traites"). Table
 * `platform.OutboxConsumedEvent` (voir schema.prisma), cle primaire composite
 * `(outbox_message_id, handler_name)`.
 *
 * `withOutboxIdempotency` decore N'IMPORTE QUEL `OutboxEventHandler` sans que celui-ci ait besoin
 * de connaitre l'existence de ce registre — c'est le SEUL point d'implementation, applique
 * UNIFORMEMENT a tous les handlers au moment ou ils sont enregistres dans le registre
 * `eventType -> handlers[]` du relais (voir composition-root.ts, qui est le SEUL point autorise a
 * enumerer tous les handlers de tous les modules, meme raisonnement que
 * `TenantModuleBackedAccessChecker`). Aucun module applicatif n'a a re-implementer sa propre
 * deduplication pour beneficier de cette garantie de premier niveau — les contraintes UNIQUE
 * metier deja presentes (`PlatformInvoice...`, `Payment.provider_transaction_id`, verrous
 * optimistes `version`...) restent en place en defense SUPPLEMENTAIRE, jamais retirees par cette
 * passe, et restent OBLIGATOIRES pour tout nouveau handler (voir la nuance ci-dessous) — pas
 * optionnelles au seul motif que ce registre existe.
 *
 * MECANISME (revise a la revue post-implementation — l'implementation initiale, "verifier PUIS
 * agir" en deux temps sequentiels, laissait une fenetre de concurrence reelle, voir plus bas) :
 *   1. RECLAMATION ATOMIQUE, AVANT d'invoquer le handler : `INSERT ... ON CONFLICT DO NOTHING`
 *      (via `createMany({ skipDuplicates: true })`, meme idiome que
 *      `PrismaSubscriptionRepository.save()` / `PrismaPaymentRepository.save()` /
 *      `PrismaPlatformInvoiceRepository.issue()` dans ce depot — jamais un `create()` rattrapant un
 *      `P2002`, pour les memes raisons). Si l'insertion est ignoree (`count === 0`), CE (message,
 *      handler) est deja pris en charge par un AUTRE traitement (concurrent ou passe) — retourne
 *      IMMEDIATEMENT, SANS jamais invoquer le handler.
 *   2. Le handler n'est invoque QUE par le traitement qui a reellement gagne l'insertion — la
 *      contrainte UNIQUE Postgres, pas une lecture prealable, est ce qui tranche : DEUX
 *      invocations strictement CONCURRENTES du meme (message, handler) ne peuvent jamais toutes
 *      les deux gagner l'insertion, donc jamais toutes les deux invoquer le handler (contrairement
 *      a la version precedente "verifier PUIS agir", vulnerable a une course entre les deux
 *      lectures — voir test/shared-kernel/integration/outboxIdempotency.test.ts, cas
 *      `Promise.all`).
 *   3. Si le handler ECHOUE (leve), la ligne de reclamation JUSTE INSEREE est SUPPRIMEE (best
 *      effort) avant de re-lever l'erreur d'origine — un ECHEC ne doit JAMAIS etre marque
 *      "consomme", sous peine de bloquer indefiniment une re-livraison legitime (at-least-once,
 *      D9) qui devrait pourtant reessayer.
 *
 * Fenetre residuelle ASSUMEE (bien plus etroite que l'implementation precedente, mais non nulle) :
 * un CRASH DU PROCESSUS exactement pendant l'execution du handler (ni un succes propre, ni un
 * `throw` intercepte par le `catch` ci-dessous) laisse la ligne de reclamation en place sans que
 * le handler ait necessairement termine son propre commit — un futur retraitement de CE (message,
 * handler) serait alors A TORT considere deja consomme (no-op silencieux d'une re-livraison qui
 * aurait pourtant du s'appliquer). C'est pourquoi l'idempotence PROPRE a chaque agregat/handler
 * (ex. `PlatformInvoice.markPaid()` no-op si deja `PAID`, contraintes UNIQUE metier) reste
 * OBLIGATOIRE en defense ULTIME — ce registre est une garantie de PREMIER NIVEAU (il empeche
 * l'IMMENSE majorite des doubles executions, en particulier toute concurrence reelle entre deux
 * livraisons simultanees), jamais une garantie ABSOLUE se substituant a elle. Fermer entierement
 * cette derniere fenetre exigerait de faire ecrire la ligne de reclamation DANS LA MEME
 * transaction que la mutation metier du handler (ce qui suppose de faire transiter le client
 * transactionnel a travers le port `OutboxEventHandler`, un changement de contrat plus large que
 * le perimetre de cette passe — voir docs/domain/events.md pour cette nuance documentee a
 * l'attention de tout futur consommateur).
 */
export function withOutboxIdempotency(
  prisma: PrismaClient,
  handlerName: string,
  handler: OutboxEventHandler,
): OutboxEventHandler {
  return async (envelope: OutboxEventEnvelope): Promise<void> => {
    const claim = await prisma.outboxConsumedEvent.createMany({
      data: [{ outboxMessageId: envelope.id, handlerName, processedAt: new Date() }],
      skipDuplicates: true,
    });
    if (claim.count === 0) {
      // Deja reclame (traitement concurrent en cours, ou deja traite avec succes anterieurement) :
      // JAMAIS invoque le handler dans ce cas.
      return;
    }

    try {
      await handler(envelope);
    } catch (error) {
      // Rollback best-effort de la reclamation (voir commentaire de tete, fenetre residuelle
      // assumee) : un ECHEC ne doit jamais rester marque "consomme".
      await prisma.outboxConsumedEvent
        .deleteMany({ where: { outboxMessageId: envelope.id, handlerName } })
        .catch(() => undefined);
      throw error;
    }
  };
}
