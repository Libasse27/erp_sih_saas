/**
 * Logger JSON minimal — le depot n'a PAS ENCORE de dependance de logging structure (Pino,
 * §8.1 du system prompt) : l'ajouter est une decision transverse hors mandat de cette etape
 * (Payment/PlatformInvoice/PaymentProvider). Cette classe couvre le besoin immediat (logs
 * structures JSON, jamais `console.log` brut d'une chaine libre) SANS introduire de nouvelle
 * dependance, en respectant deja le contrat `{info,warn,error}` attendu par
 * `OutboxRelay.ts`/`PeriodicJobRunner.ts`/`ConfirmPayment.ts`/`PaymentWebhookController.ts` — un
 * remplacement par un vrai logger Pino, le jour ou cette dependance est ajoutee au projet, n'aura
 * besoin de changer que ce seul fichier (point d'implementation unique, cable dans
 * composition-root.ts).
 *
 * REDACTION (regle §8.1/§10) : aucun champ `password`/`token`/`authorization`/`cardNumber`/
 * `phone`/`email`/`nin` ne doit jamais etre passe en `fields` par les appelants — cette classe ne
 * fait PAS de redaction automatique (limite assumee d'un logger minimal), c'est aux appelants de
 * ce depot de ne jamais y placer de donnee personnelle (aucun des appelants actuels de ce module
 * ne loggue plus qu'un `tenantId`/`eventType`/`paymentId`, jamais un numero de telephone/carte).
 */
export class ConsoleStructuredLogger {
  info(fields: Record<string, unknown>, message: string): void {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: 'info', message, ...fields, time: new Date().toISOString() }));
  }

  warn(fields: Record<string, unknown>, message: string): void {
    // `no-console` autorise deja `warn`/`error` (eslint.config.mjs) — seul `console.log` (methode
    // `info` ci-dessus) exige la derogation explicite.
    console.warn(JSON.stringify({ level: 'warn', message, ...fields, time: new Date().toISOString() }));
  }

  error(fields: Record<string, unknown>, message: string): void {
    console.error(JSON.stringify({ level: 'error', message, ...fields, time: new Date().toISOString() }));
  }
}
