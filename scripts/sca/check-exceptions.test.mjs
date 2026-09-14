// Tests de non-regression du mecanisme SCA (ADR-0014). Node --test natif, volontairement hors
// d'apps/api : ce script ne fait pas partie du produit et ne doit pas peser sur les seuils geles
// de couverture de l'item 10 (garde-fou ADR-0014 S14.2). Execution : `node --test scripts/sca/`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAdvisories,
  evaluate,
  parseExceptions,
  validateAuditReport,
  parseArgs,
} from './check-exceptions.mjs';

function makeExceptions(entries) {
  return parseExceptions({ exceptions: entries });
}

test('parseArgs: mode par defaut = gate', () => {
  assert.equal(parseArgs([]).mode, 'gate');
});

test('parseArgs: rejette un mode inconnu', () => {
  assert.throws(() => parseArgs(['--mode=bogus']));
});

test('validateAuditReport: refuse de conclure si pnpm audit a echoue (finding S-1)', () => {
  assert.throws(
    () => validateAuditReport({ error: { code: 'ECONNREFUSED', message: 'registre injoignable' } }),
    /ECONNREFUSED/,
  );
});

test('validateAuditReport: refuse un rapport sans champ advisories', () => {
  assert.throws(() => validateAuditReport({ metadata: { vulnerabilities: {} } }), /advisories/);
});

test('validateAuditReport: refuse un rapport sans metadata.vulnerabilities', () => {
  assert.throws(() => validateAuditReport({ advisories: {} }), /metadata/);
});

test('validateAuditReport: accepte un rapport propre, meme sans avis', () => {
  const report = { advisories: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } };
  assert.deepEqual(validateAuditReport(report), report);
});

test('collectAdvisories: rejette un avis sans identifiant GHSA', () => {
  const report = { advisories: { 1: { module_name: 'foo', severity: 'high' } } };
  assert.throws(() => collectAdvisories(report), /GHSA/);
});

test('collectAdvisories: extrait les champs pertinents', () => {
  const report = {
    advisories: {
      1: {
        github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
        module_name: 'foo',
        severity: 'critical',
        title: 'titre',
        url: 'https://example.invalid',
      },
    },
  };
  assert.deepEqual(collectAdvisories(report), [
    {
      ghsa: 'GHSA-aaaa-bbbb-cccc',
      package: 'foo',
      severity: 'critical',
      title: 'titre',
      url: 'https://example.invalid',
    },
  ]);
});

test('evaluate (gate): avis high non couvert -> uncovered, gate bloquerait', () => {
  const advisories = [{ ghsa: 'GHSA-x', package: 'foo', severity: 'high', title: 't' }];
  const exceptions = makeExceptions([]);
  const result = evaluate(advisories, exceptions, 'gate');
  assert.equal(result.uncovered.length, 1);
  assert.equal(result.covered.length, 0);
});

test('evaluate (gate): avis couvert par une exception valide -> covered, gate passerait', () => {
  const advisories = [{ ghsa: 'GHSA-x', package: 'foo', severity: 'high', title: 't' }];
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString().slice(0, 10);
  const exceptions = makeExceptions([
    { ghsa: 'GHSA-x', package: 'foo', reason: 'r', expires: future, approver: 'a' },
  ]);
  const result = evaluate(advisories, exceptions, 'gate');
  assert.equal(result.uncovered.length, 0);
  assert.equal(result.covered.length, 1);
});

test('evaluate (gate): exception expiree ne couvre plus -> uncovered, le blocage reprend seul (ADR-0014 S6)', () => {
  const advisories = [{ ghsa: 'GHSA-x', package: 'foo', severity: 'critical', title: 't' }];
  const exceptions = makeExceptions([
    { ghsa: 'GHSA-x', package: 'foo', reason: 'r', expires: '2000-01-01', approver: 'a' },
  ]);
  const result = evaluate(advisories, exceptions, 'gate');
  assert.equal(result.uncovered.length, 1);
  assert.equal(result.covered.length, 0);
});

test('evaluate (gate): severite moderate jamais bloquante meme non couverte', () => {
  const advisories = [{ ghsa: 'GHSA-x', package: 'foo', severity: 'moderate', title: 't' }];
  const exceptions = makeExceptions([]);
  const result = evaluate(advisories, exceptions, 'gate');
  assert.equal(result.relevant.length, 0);
});

test('evaluate (watch): toutes severites evaluees', () => {
  const advisories = [
    { ghsa: 'GHSA-x', package: 'foo', severity: 'moderate', title: 't' },
    { ghsa: 'GHSA-y', package: 'bar', severity: 'critical', title: 't2' },
  ];
  const exceptions = makeExceptions([]);
  const result = evaluate(advisories, exceptions, 'watch');
  assert.equal(result.relevant.length, 2);
});

test('evaluate: une exception couvre le meme GHSA sur plusieurs paquets (finding S-7)', () => {
  const advisories = [
    { ghsa: 'GHSA-shared', package: 'vitest', severity: 'moderate', title: 't' },
    { ghsa: 'GHSA-shared', package: '@vitest/mocker', severity: 'moderate', title: 't' },
  ];
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString().slice(0, 10);
  const exceptions = makeExceptions([
    { ghsa: 'GHSA-shared', package: 'vitest', reason: 'r', expires: future, approver: 'a' },
  ]);
  const result = evaluate(advisories, exceptions, 'watch');
  assert.equal(result.covered.length, 2);
});

test('evaluate: exception sans avis correspondant -> staleException', () => {
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString().slice(0, 10);
  const exceptions = makeExceptions([
    { ghsa: 'GHSA-disparu', package: 'foo', reason: 'r', expires: future, approver: 'a' },
  ]);
  const result = evaluate([], exceptions, 'watch');
  assert.equal(result.staleExceptions.length, 1);
});

test('evaluate: exception expirant sous 30 jours -> expiringSoon', () => {
  const advisories = [{ ghsa: 'GHSA-x', package: 'foo', severity: 'high', title: 't' }];
  const soon = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5).toISOString().slice(0, 10);
  const exceptions = makeExceptions([
    { ghsa: 'GHSA-x', package: 'foo', reason: 'r', expires: soon, approver: 'a' },
  ]);
  const result = evaluate(advisories, exceptions, 'gate');
  assert.equal(result.expiringSoon.length, 1);
});

test('parseExceptions: rejette un champ requis manquant', () => {
  assert.throws(() =>
    makeExceptions([{ ghsa: 'GHSA-x', package: 'foo', reason: 'r', expires: '2099-01-01' }]),
  );
});

test('parseExceptions: rejette une date malformee', () => {
  assert.throws(() =>
    makeExceptions([
      { ghsa: 'GHSA-x', package: 'foo', reason: 'r', expires: '01/01/2099', approver: 'a' },
    ]),
  );
});

test('parseExceptions: rejette un GHSA en double', () => {
  assert.throws(() =>
    makeExceptions([
      { ghsa: 'GHSA-x', package: 'foo', reason: 'r', expires: '2099-01-01', approver: 'a' },
      { ghsa: 'GHSA-x', package: 'bar', reason: 'r2', expires: '2099-01-01', approver: 'a' },
    ]),
  );
});
