import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asyncRoute, createErrorHandler } from '../../src/server.js';

/**
 * `createErrorHandler` (src/server.ts) exerce SANS `CompositionRoot` complet : c'est tout son
 * interet (voir le commentaire au-dessus de sa definition). Une route de test minimale ad hoc est
 * utilisee ici plutot qu'un `CompositionRoot` complet pour rester isolee des dependances
 * applicatives — les vraies routes JSON de `createApp()` (ADR-0010) montent desormais
 * `express.json()` PAR ROUTE, apres le limiteur de debit, jamais globalement (voir server.ts).
 *
 * `supertest` n'est PAS une dependance de ce depot (verifie dans package.json) : utilise
 * `node:http` directement plutot que d'ajouter une nouvelle dependance sans decision explicite.
 */
describe('createErrorHandler (server.ts) — pas de fuite de detail interne', () => {
  const fakeLogger = { error: (): void => {} };
  const app = express();
  app.post('/test/echo', express.json({ limit: '1mb' }), (req, res) => {
    res.status(200).json({ received: req.body });
  });
  app.get('/test/boom', () => {
    throw new Error('secret-internal-detail-jamais-expose');
  });
  // Exerce SPECIFIQUEMENT `asyncRoute` (BLOQUANT-1, revue de securite independante de l'etape
  // 12/13) : sans elle, ce handler `async` qui rejette laisserait la requete SANS AUCUNE reponse
  // (Express 4 ne rattrape pas les rejets de promesse) — le test ci-dessous echouerait par
  // timeout plutot que par une assertion de statut, exactement comme reproduit en execution reelle
  // sur le rejeu d'un code de recuperation MFA deja consomme.
  app.get(
    '/test/boom-async',
    asyncRoute(async () => {
      await Promise.resolve();
      throw new Error('secret-async-jamais-expose');
    }),
  );
  app.use(createErrorHandler(fakeLogger));

  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Adresse de serveur de test inattendue.');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  function post(path: string, rawBody: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) } },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });
  }

  function get(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${baseUrl}${path}`, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        })
        .on('error', reject);
    });
  }

  it('cas nominal : JSON valide traverse express.json() normalement, le middleware d_erreur ne s_active pas', async () => {
    const response = await post('/test/echo', JSON.stringify({ hello: 'dakar' }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ received: { hello: 'dakar' } });
  });

  it('POST JSON malforme -> 400, corps { error: "invalid_request" } (SimpleError, ADR-0010 §5/§9 — non-regression du correctif "invalid_request_body" n_existait pas dans l_enumeration), aucune stack trace ni message d_erreur brut', async () => {
    const response = await post('/test/echo', '{ceci n est pas du json valide');

    expect(response.status).toBe(400);
    const parsed: unknown = JSON.parse(response.body);
    expect(parsed).toEqual({ error: 'invalid_request' });
    expect(response.body).not.toContain('SyntaxError');
    expect(response.body).not.toContain('at ');
  });

  it('erreur inattendue non liee au parsing JSON -> 500, corps { error: "internal_error" }, jamais err.message expose', async () => {
    const response = await get('/test/boom');

    expect(response.status).toBe(500);
    const parsed: unknown = JSON.parse(response.body);
    expect(parsed).toEqual({ error: 'internal_error' });
    expect(response.body).not.toContain('secret-internal-detail-jamais-expose');
  });

  it('handler async qui REJETTE (via asyncRoute) -> 500, corps { error: "internal_error" }, jamais un timeout ni un message brut (non-regression BLOQUANT-1)', async () => {
    const response = await get('/test/boom-async');

    expect(response.status).toBe(500);
    const parsed: unknown = JSON.parse(response.body);
    expect(parsed).toEqual({ error: 'internal_error' });
    expect(response.body).not.toContain('secret-async-jamais-expose');
  });
});
