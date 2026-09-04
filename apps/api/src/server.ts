import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from 'express';
import { buildCompositionRoot, type CompositionRoot } from './composition-root.js';

export interface ErrorHandlerLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * Discriminant d'une erreur de parsing JSON `body-parser` (utilise par `express.json()`) —
 * verifie empiriquement sur Express 4.21/body-parser (voir le test d'integration associe) :
 * `err.type === 'entity.parse.failed'` ET `err instanceof SyntaxError` avec une propriete `body`
 * (le corps brut qui a echoue a parser). Les DEUX conditions sont verifiees plutot qu'une seule
 * pour ne jamais confondre cette erreur precise avec une autre `SyntaxError` accidentelle levee
 * plus loin dans la chaine de middlewares (§3.3 : jamais de detail interne expose, donc autant
 * etre strict sur CE qui declenche la reponse 400 "payload malformee").
 */
function isJsonBodyParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    'body' in err &&
    'type' in err &&
    (err as { type: unknown }).type === 'entity.parse.failed'
  );
}

/**
 * Middleware d'erreur Express (4 arguments, reconnu comme tel par sa seule arite — Express ne le
 * distingue pas autrement) a monter APRES toutes les routes : sans lui, une erreur de parsing
 * JSON sur une route non-webhook (ou toute exception synchrone non geree dans un handler)
 * retomberait sur le handler d'erreur PAR DEFAUT d'Express, qui expose `err.message` (et la stack
 * en dev) dans le corps de reponse — contraire a la regle deja appliquee partout ailleurs dans ce
 * depot (§3.3, voir PaymentWebhookController.ts). Ne renvoie JAMAIS `err.stack`/`err.message` au
 * client, dans aucun des deux cas ci-dessous.
 *
 * Extrait en fonction exportee (plutot qu'inline dans `createApp`) pour etre testable
 * independamment d'un `CompositionRoot` complet — voir test/server/errorHandler.test.ts, qui
 * l'exerce sur une app Express minimale ad hoc (aucune route JSON reelle n'existe encore a cette
 * etape, le webhook de paiement etant volontairement monte AVANT `express.json()`).
 */
export function createErrorHandler(logger: ErrorHandlerLogger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (isJsonBodyParseError(err)) {
      // Aligne sur `SimpleError` (ADR-0010 §5/§9) : `invalid_request` est le SEUL code `400`
      // documente pour un corps malforme — `invalid_request_body` n'existe pas dans l'enumeration
      // et n'a jamais ete qu'une divergence locale de ce fichier. Correction signalee par
      // l'architecte lors de la revue d'ADR-0010 : le code s'aligne sur l'ADR deja accepte,
      // jamais l'inverse.
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    logger.error(
      { event: 'http.unhandled-error', error: err instanceof Error ? err.message : String(err) },
      'Erreur HTTP inattendue',
    );
    res.status(500).json({ error: 'internal_error' });
  };
}

/**
 * Enveloppe un handler Express `async` pour que ses rejets de promesse atteignent
 * `next(error)` — Express **4** ne le fait PAS automatiquement (contrairement a Express 5) :
 * un handler `async` monte nu qui rejette laisse la requete SANS AUCUNE reponse (le client
 * attend jusqu'a son propre timeout) et produit un `unhandledRejection` non rattrape (sous
 * Node >= 15, comportement par defaut, le PROCESSUS s'arrete). Confirme par la revue de
 * securite independante de l'etape 12/13 (BLOQUANT-1) et reproduit par execution reelle
 * (rejeu d'un code de recuperation MFA deja consomme). Point de cablage UNIQUE : jamais un
 * `try/catch` duplique dans chaque controleur.
 */
export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * Bootstrap HTTP minimal. Health check + le SEUL endpoint metier existant a ce stade (Phase 0,
 * etape 5/13) : le webhook de confirmation de paiement (O-25.5).
 *
 * Le webhook est monte AVANT tout corps JSON, avec son propre `express.raw()` scope a
 * cette seule route : la verification de signature HMAC (voir
 * `PaymentWebhookController.ts`/`SandboxPaymentProviderAdapter.ts`) exige le corps HTTP BRUT
 * exact, jamais une re-serialisation JSON qui pourrait differer (ordre des cles, espaces...).
 *
 * AUCUN `express.json()` GLOBAL (correctif BLOQUANT-3 de la revue de securite independante,
 * etape 12/13) : mis en place initialement AVANT les cinq routes ADR-0010, il permettait a un
 * corps JSON illisible de faire echouer le parsing (`400`, via `createErrorHandler`) SANS JAMAIS
 * passer par le limiteur de debit de la route — contournement total par corps volontairement
 * invalide, et jusqu'a 1 Mo lu/desserialise avant toute decision de limitation. `express.json()`
 * est desormais monte PAR ROUTE, **apres** le limiteur de debit partage, avec une limite de
 * taille adaptee (les cinq corps possibles font quelques centaines d'octets au plus).
 */
export function createApp(root: CompositionRoot): Express {
  const app = express();
  app.disable('x-powered-by');

  app.post(
    '/api/v1/payments/webhook',
    express.raw({ type: '*/*', limit: '256kb' }),
    root.payment.presentation.webhookController.handle,
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', now: root.clock.now().toISOString() });
  });

  // ADR-0010 §1/§9 — CINQ routes pre-authentification (inscription, connexion, second facteur).
  // Invariants d'ordre NON NEGOCIABLES : SANS `requireAuthenticatedContext` (il refuserait
  // structurellement toute session `MFA_PENDING` en 403 `mfa_required` — voir son commentaire de
  // tete plus bas), et avec le limiteur de debit PARTAGE comme PREMIER middleware de chaque
  // route — AVANT `express.json()`, avant toute desserialisation applicative, avant tout acces
  // Redis/PostgreSQL du controleur.
  const parseJsonBody = express.json({ limit: '16kb' });
  app.post(
    '/api/v1/registrations',
    root.presentation.rateLimitRegistrations,
    parseJsonBody,
    asyncRoute(root.presentation.registrationController.handle),
  );
  app.post(
    '/api/v1/auth/sessions',
    root.presentation.rateLimitLogin,
    parseJsonBody,
    asyncRoute(root.presentation.sessionController.create),
  );

  // Les TROIS routes MFA — AUCUNE n'est montee derriere `requireAuthenticatedContext` (ADR-0010
  // §7 bis : "Ne pas monter requireAuthenticatedContext sur les trois routes MFA" — il repondrait
  // 403 `mfa_required` a TOUTE session `MFA_PENDING`, les rendant inaccessibles par construction).
  app.post(
    '/api/v1/auth/mfa/enrollment',
    root.presentation.rateLimitMfa,
    parseJsonBody,
    asyncRoute(root.presentation.mfaEnrollmentController.start),
  );
  app.post(
    '/api/v1/auth/mfa/enrollment/confirmation',
    root.presentation.rateLimitMfa,
    parseJsonBody,
    asyncRoute(root.presentation.mfaEnrollmentController.confirm),
  );
  app.post(
    '/api/v1/auth/sessions/mfa-challenge',
    root.presentation.rateLimitMfa,
    parseJsonBody,
    asyncRoute(root.presentation.sessionController.verifyMfaChallenge),
  );

  // PREMIER endpoint HTTP authentifie du depot (ADR-0009 §8) — `requireAuthenticatedContext`
  // est le SEUL middleware d'authentification existant, construit une fois dans
  // composition-root.ts (seul point du code autorise a connaitre `identity` ET `audit`).
  app.get(
    '/api/v1/audit-entries',
    root.presentation.requireAuthenticatedContext,
    asyncRoute(root.presentation.auditEntryController.list),
  );

  // Recuperation break-glass SUPER_ADMIN (ADR-0005 Amendement 1, O-04 residu 4, etape 12/13) —
  // DEUX routes authentifiees (jamais publiques), l'autorisation fine (session PLATFORM +
  // step-up MFA, quorum de deux SUPER_ADMIN distincts) restant entierement du ressort des
  // handlers applicatifs (voir SuperAdminBreakGlassController.ts).
  app.post(
    '/api/v1/platform/super-admin/break-glass-requests',
    root.presentation.requireAuthenticatedContext,
    parseJsonBody,
    asyncRoute(root.presentation.superAdminBreakGlassController.request),
  );
  app.post(
    '/api/v1/platform/super-admin/break-glass-requests/:requestId/approval',
    root.presentation.requireAuthenticatedContext,
    parseJsonBody,
    asyncRoute(root.presentation.superAdminBreakGlassController.approve),
  );

  // Monte APRES toutes les routes (contrat Express des middlewares d'erreur) — voir
  // `createErrorHandler` ci-dessus pour le detail de ce qu'il couvre et pourquoi.
  app.use(createErrorHandler(root.logger));

  return app;
}

function main(): void {
  const root = buildCompositionRoot();
  const app = createApp(root);
  root.startBackgroundJobs();
  const server = app.listen(root.env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`apps/api ecoute sur le port ${root.env.PORT} (${root.env.NODE_ENV})`);
  });

  // Arret propre (§8 exploitation) : fin des requetes en cours, drain des jobs de fond, puis
  // fermeture des connexions — dans cet ordre.
  process.on('SIGTERM', () => {
    server.close(() => {
      void root.stopBackgroundJobs().then(() => root.shutdown());
    });
  });
}

const isEntryPoint = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isEntryPoint) {
  main();
}
