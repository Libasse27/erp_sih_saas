import http from 'node:http';
import { randomInt } from 'node:crypto';
import type { Express } from 'express';

/**
 * Client HTTP minimal partage par les tests d'integration ADR-0010 (inscription/connexion/second
 * facteur) — meme pattern que `test/audit/integration/auditHttpIsolation.test.ts` (requetes
 * `node:http` reelles contre `createApp(root)`, jamais `supertest`, absent de ce depot).
 *
 * AJOUT PROPRE A CETTE ETAPE (12/13) : `nextLoopbackIp()`. Le limiteur de debit partage
 * (ADR-0010 §8) cle EXCLUSIVEMENT sur `req.ip` — pour que les tests FONCTIONNELS (nominal, 400,
 * 401, 403, 404 tenant, 422/409...) restent independants du limiteur SANS jamais modifier les
 * valeurs de `RateLimitTuning.ts` pour les besoins des tests (ce serait tester une politique
 * differente de celle reellement montee), chaque scenario logiquement independant utilise sa
 * PROPRE adresse IP source. Windows (comme Linux/macOS) traite tout `127.0.0.0/8` comme loopback
 * depuis longtemps — verifie empiriquement dans ce depot avant d'ecrire ce fichier : un
 * `http.request` avec `localAddress: '127.x.y.z'` aboutit, et le serveur voit bien cette adresse
 * en `req.socket.remoteAddress`/`req.ip` (aucune configuration `trust proxy` requise, aucun
 * en-tete implique — donc rien de spoofable par un attaquant reel, la propriete testee ici est
 * bien celle du mecanisme reel).
 */
export interface TestHttpResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface TestServerHandle {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startTestServer(app: Express): Promise<TestServerHandle> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Adresse de serveur de test inattendue.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/**
 * Genere une adresse loopback (`127.x.y.z`, x/y/z dans 1..254, jamais `0.0.1` qui coinciderait
 * avec `127.0.0.1` par defaut) — utilisee comme `localAddress` d'une requete sortante pour
 * simuler une IP source DISTINCTE par scenario, sans dependre de la moindre configuration reseau.
 */
export function nextLoopbackIp(): string {
  const b = randomInt(1, 255);
  const c = randomInt(1, 255);
  const d = randomInt(1, 255);
  return `127.${b}.${c}.${d}`;
}

export interface TestRequestOptions {
  readonly headers?: Record<string, string>;
  /** Adresse source loopback (voir `nextLoopbackIp()`) — omise = `127.0.0.1` par defaut (comportement `http` standard). */
  readonly localAddress?: string;
}

export function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  options: TestRequestOptions = {},
): Promise<TestHttpResponse> {
  return rawRequest(baseUrl, 'POST', path, body === undefined ? undefined : JSON.stringify(body), {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}

/** Corps BRUT (jamais serialise) — utilise pour les scenarios "JSON illisible". */
export function postRaw(baseUrl: string, path: string, rawBody: string, options: TestRequestOptions = {}): Promise<TestHttpResponse> {
  return rawRequest(baseUrl, 'POST', path, rawBody, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}

export function postEmpty(baseUrl: string, path: string, options: TestRequestOptions = {}): Promise<TestHttpResponse> {
  return rawRequest(baseUrl, 'POST', path, undefined, options);
}

export function getRequest(baseUrl: string, path: string, options: TestRequestOptions = {}): Promise<TestHttpResponse> {
  return rawRequest(baseUrl, 'GET', path, undefined, options);
}

function rawRequest(
  baseUrl: string,
  method: string,
  path: string,
  rawBody: string | undefined,
  options: TestRequestOptions,
): Promise<TestHttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...options.headers,
          ...(rawBody !== undefined ? { 'Content-Length': Buffer.byteLength(rawBody) } : {}),
        },
        ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (rawBody !== undefined) {
      req.write(rawBody);
    }
    req.end();
  });
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function correlationId(id: string): Record<string, string> {
  return { 'X-Correlation-Id': id };
}
