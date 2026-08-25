import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createErrorHandler } from '../../src/server.js';

/**
 * `createErrorHandler` (src/server.ts) exerce SANS `CompositionRoot` complet : c'est tout son
 * interet (voir le commentaire au-dessus de sa definition). Aucune route JSON reelle n'existe
 * encore dans `createApp()` a cette etape (le webhook de paiement est volontairement monte AVANT
 * `express.json()`, voir server.ts) — une route de test minimale ad hoc est donc necessaire ici
 * pour declencher une erreur de parsing `body-parser` dans les memes conditions qu'une future
 * route JSON reelle.
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

  it('POST JSON malforme -> 400, corps { error: "invalid_request_body" }, aucune stack trace ni message d_erreur brut', async () => {
    const response = await post('/test/echo', '{ceci n est pas du json valide');

    expect(response.status).toBe(400);
    const parsed: unknown = JSON.parse(response.body);
    expect(parsed).toEqual({ error: 'invalid_request_body' });
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
});
