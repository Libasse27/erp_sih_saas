import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCompositionRoot, type CompositionRoot } from '../../src/composition-root.js';
import { createApp } from '../../src/server.js';
import { getRequest, startTestServer, type TestServerHandle } from './httpTestClient.js';

/**
 * ADR-0013 — headers de securite HTTP (`helmet`) contre le VRAI `createApp(root)`, meme pattern
 * que `registrationHttp.test.ts`. `/health` suffit (aucune authentification, aucune ecriture) :
 * `helmet` est monte en tout premier middleware de l'application, avant toute route — ses headers
 * doivent donc apparaitre sur N'IMPORTE QUELLE reponse, `/health` inclus.
 *
 * Necessite `docker compose up -d` (PostgreSQL + Redis) et les migrations appliquees.
 */
describe('Headers de securite HTTP (ADR-0013)', () => {
  let root: CompositionRoot;
  let handle: TestServerHandle;

  beforeAll(async () => {
    root = buildCompositionRoot();
    handle = await startTestServer(createApp(root));
  });

  afterAll(async () => {
    await handle.close();
    await root.shutdown();
  });

  it('pose les headers de durcissement helmet par defaut sur une reponse quelconque', async () => {
    const response = await getRequest(handle.baseUrl, '/health');
    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    // max-age strictement positif : un max-age=0 neutraliserait HSTS (indistingable d'une absence
    // de protection pour le navigateur) sans faire echouer un match sur \d+ seul.
    expect(response.headers['strict-transport-security']).toMatch(/^max-age=[1-9]\d*/);
  });

  it('ne pose AUCUN header Content-Security-Policy — desactivee explicitement (ADR-0013 §3), pas simplement absente', async () => {
    const response = await getRequest(handle.baseUrl, '/health');
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('ne pose AUCUN header Access-Control-Allow-Origin, meme avec un Origin envoye par le client — aucun CORS (ADR-0013 §2)', async () => {
    const response = await getRequest(handle.baseUrl, '/health', {
      headers: { Origin: 'https://exemple-tiers.test' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('non-regression : X-Powered-By reste absent (app.disable("x-powered-by"), inchange)', async () => {
    const response = await getRequest(handle.baseUrl, '/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
