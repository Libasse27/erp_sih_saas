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
 * REDACTION (ADR-0012) : toute cle de `fields` dont le nom (insensible a la casse) matche
 * EXACTEMENT une entree de `REDACTED_FIELD_NAMES` voit sa valeur remplacee par `'[REDACTED]'`
 * avant serialisation — jamais une correspondance par sous-chaine (une cle `emailTemplate` n'est
 * PAS redactee), jamais un scan recursif dans une valeur imbriquee (ADR-0012 §2/§3 : aucun
 * appelant actuel n'a besoin de loguer une structure imbriquee). Le champ reste present dans le
 * JSON produit, seule sa valeur disparait (ADR-0012 §4).
 */
const REDACTED_FIELD_NAMES = new Set([
  'password',
  'plainpassword',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'mfacode',
  'totpsecret',
  'totpcode',
  'recoverycode',
  'cardnumber',
  'cvv',
  'phone',
  'phonenumber',
  'email',
  'nin',
  'secret',
]);

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = REDACTED_FIELD_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return redacted;
}

export class ConsoleStructuredLogger {
  info(fields: Record<string, unknown>, message: string): void {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        message,
        ...redactFields(fields),
        time: new Date().toISOString(),
      }),
    );
  }

  warn(fields: Record<string, unknown>, message: string): void {
    // `no-console` autorise deja `warn`/`error` (eslint.config.mjs) — seul `console.log` (methode
    // `info` ci-dessus) exige la derogation explicite.
    console.warn(
      JSON.stringify({
        level: 'warn',
        message,
        ...redactFields(fields),
        time: new Date().toISOString(),
      }),
    );
  }

  error(fields: Record<string, unknown>, message: string): void {
    console.error(
      JSON.stringify({
        level: 'error',
        message,
        ...redactFields(fields),
        time: new Date().toISOString(),
      }),
    );
  }
}
