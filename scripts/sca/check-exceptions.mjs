#!/usr/bin/env node
// Mecanisme du controle SCA (ADR-0014, D-SCA-1..5). Deux modes :
//   --mode=gate  (defaut) : n'evalue que high/critical, echoue (exit 1) si un avis n'est pas
//                couvert par une exception non expiree de security/sca-exceptions.json.
//                Utilise par .github/workflows/sca.yml (controle a l'entree, ADR-0014 S2/S7).
//   --mode=watch : evalue toutes les severites, n'echoue jamais process.exitCode reste 0 — sauf
//                que le rapport imprime affirme alors explicitement l'echec plutot que de
//                pretendre "0 avis" (revue de securite independante, finding S-2).
// Les deux modes impriment le meme rapport Markdown sur stdout (ADR-0014 S14.5, tracabilite
// avis -> exception -> expiration).
//
// Fail-closed obligatoire : toute incapacite a produire un verdict fiable (registre npm
// injoignable, format de rapport inattendu, fichier d'exceptions invalide) DOIT se traduire par
// un refus de conclure (exit 1 en gate), jamais par "0 avis trouve" (revue de securite
// independante, finding S-1 — un registre injoignable produisait auparavant un gate vert).

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const EXCEPTIONS_PATH = path.join(REPO_ROOT, 'security', 'sca-exceptions.json');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const REQUIRED_FIELDS = ['ghsa', 'package', 'reason', 'expires', 'approver'];
const EXPIRY_WARNING_DAYS = 30;

export function parseArgs(argv) {
  const modeArg = argv.find((a) => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'gate';
  if (mode !== 'gate' && mode !== 'watch') {
    throw new Error(`mode inconnu: "${mode}" (attendu: gate | watch)`);
  }
  return { mode };
}

// Valide la FORME du rapport avant tout traitement. "pnpm audit --json" ecrit un JSON
// parfaitement desserialisable meme en cas d'echec (ex. registre injoignable : {"error": {...}}),
// avec un code de sortie non nul — le distinguer explicitement d'un rapport reel est ce qui
// empeche le gate de conclure "0 avis" a tort (finding S-1).
export function validateAuditReport(report) {
  if (report && typeof report === 'object' && report.error) {
    const { code, message } = report.error;
    throw new Error(
      `"pnpm audit --json" a echoue: ${code ?? '?'} — ${message ?? 'pas de message'}`,
    );
  }
  if (!report || typeof report.advisories !== 'object' || report.advisories === null) {
    throw new Error(
      'rapport "pnpm audit --json" inexploitable : champ "advisories" absent ou invalide',
    );
  }
  if (!report.metadata || typeof report.metadata.vulnerabilities !== 'object') {
    throw new Error(
      'rapport "pnpm audit --json" inexploitable : champ "metadata.vulnerabilities" absent',
    );
  }
  return report;
}

function runAudit() {
  // Commande fixe, sans interpolation d'entree externe : execSync est sans risque d'injection
  // ici (revue de securite independante, finding S-10). cwd epingle a la racine du depot pour
  // que le resultat ne depende jamais du repertoire d'invocation.
  let out;
  try {
    out = execSync('pnpm audit --json', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm audit sort en code non-zero des qu'au moins une vulnerabilite est trouvee (cas
    // normal) OU en cas d'echec reel (registre injoignable, cas anormal) : les deux ecrivent du
    // JSON sur stdout, seule validateAuditReport() peut les distinguer — ne jamais traiter
    // silencieusement l'un comme l'autre ici.
    out = err.stdout?.toString();
    if (!out) {
      throw new Error(`"pnpm audit --json" n'a produit aucune sortie exploitable: ${err.message}`);
    }
  }
  return validateAuditReport(JSON.parse(out));
}

export function parseExceptions(raw) {
  if (!raw || !Array.isArray(raw.exceptions)) {
    throw new Error(`${EXCEPTIONS_PATH}: champ "exceptions" absent ou invalide`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const warningCutoff = new Date();
  warningCutoff.setDate(warningCutoff.getDate() + EXPIRY_WARNING_DAYS);
  const warningCutoffStr = warningCutoff.toISOString().slice(0, 10);

  const byGhsa = new Map();
  for (const entry of raw.exceptions) {
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new Error(
          `${EXCEPTIONS_PATH}: entree invalide, champ "${field}" manquant ou vide — ${JSON.stringify(entry)}`,
        );
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      throw new Error(
        `${EXCEPTIONS_PATH}: "expires" doit etre au format AAAA-MM-JJ — ${JSON.stringify(entry)}`,
      );
    }
    if (byGhsa.has(entry.ghsa)) {
      throw new Error(`${EXCEPTIONS_PATH}: entree en double pour ${entry.ghsa}`);
    }
    byGhsa.set(entry.ghsa, {
      ...entry,
      expired: entry.expires < today,
      expiringSoon: entry.expires >= today && entry.expires < warningCutoffStr,
    });
  }
  return byGhsa;
}

function loadExceptions() {
  const raw = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
  return parseExceptions(raw);
}

export function collectAdvisories(auditReport) {
  const advisories = auditReport.advisories ?? {};
  return Object.values(advisories).map((adv) => {
    if (!adv.github_advisory_id) {
      throw new Error(
        `avis sans identifiant GHSA (paquet ${adv.module_name ?? '?'}) — a traiter manuellement, ` +
          "le mecanisme d'exception s'appuie sur cet identifiant",
      );
    }
    return {
      ghsa: adv.github_advisory_id,
      package: adv.module_name,
      severity: adv.severity,
      title: adv.title,
      url: adv.url,
    };
  });
}

// Une exception porte sur un GHSA, quel que soit le paquet qui l'expose : deux occurrences du
// meme GHSA (ex. un avis vitest qui affecte aussi @vitest/mocker) partagent une seule entree.
// Documente ici pour que ce comportement ne soit pas decouvert a l'usage (revue de securite
// independante, finding S-7) — voir aussi security/README.md et le "_comment" du fichier JSON.
export function evaluate(advisories, exceptions, mode) {
  const relevant =
    mode === 'gate' ? advisories.filter((a) => BLOCKING_SEVERITIES.has(a.severity)) : advisories;

  const covered = [];
  const uncovered = [];
  for (const adv of relevant) {
    const exception = exceptions.get(adv.ghsa);
    if (!exception || exception.expired) {
      uncovered.push({ ...adv, exception: exception ?? null });
    } else {
      covered.push({ ...adv, exception });
    }
  }

  const advisoryGhsaSet = new Set(advisories.map((a) => a.ghsa));
  const staleExceptions = [...exceptions.values()].filter((e) => !advisoryGhsaSet.has(e.ghsa));
  const expiringSoon = [...exceptions.values()].filter(
    (e) => e.expiringSoon && advisoryGhsaSet.has(e.ghsa),
  );

  return { relevant, covered, uncovered, staleExceptions, expiringSoon };
}

function table(headers, rows) {
  if (rows.length === 0) return '_aucune_\n';
  const head = `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n`;
  return head + rows.map((r) => `| ${r.join(' | ')} |`).join('\n') + '\n';
}

export function buildReport({ mode, relevant, covered, uncovered, staleExceptions, expiringSoon }) {
  const scope = mode === 'gate' ? 'high/critical uniquement' : 'toutes severites';
  const lines = [];
  lines.push(`## Rapport SCA — mode \`${mode}\` (${scope})`);
  lines.push('');
  lines.push(`- Avis evalues : ${relevant.length}`);
  lines.push(`- Couverts par une exception valide : ${covered.length}`);
  lines.push(`- Non couverts${mode === 'gate' ? ' (bloquant)' : ''} : ${uncovered.length}`);
  lines.push(`- Entrees d'exceptions obsoletes (avis disparu) : ${staleExceptions.length}`);
  lines.push(`- Exceptions expirant sous ${EXPIRY_WARNING_DAYS} jours : ${expiringSoon.length}`);
  lines.push('');
  lines.push('### Non couverts');
  lines.push(
    table(
      ['GHSA', 'Paquet', 'Severite', 'Titre', 'Exception expiree ?'],
      uncovered.map((a) => [
        a.ghsa,
        a.package,
        a.severity,
        a.title,
        a.exception ? `oui, le ${a.exception.expires}` : 'non — aucune entree',
      ]),
    ),
  );
  lines.push('### Exceptions expirant bientot (a traiter en revue mensuelle, ADR-0014 S13)');
  lines.push(
    table(
      ['GHSA', 'Paquet', 'Expire le', 'Approuve par'],
      expiringSoon.map((e) => [e.ghsa, e.package, e.expires, e.approver]),
    ),
  );
  lines.push('### Couverts (exceptions actives)');
  lines.push(
    table(
      ['GHSA', 'Paquet', 'Expire le', 'Approuve par', 'Motif'],
      covered.map((a) => [
        a.ghsa,
        a.package,
        a.exception.expires,
        a.exception.approver,
        a.exception.reason,
      ]),
    ),
  );
  lines.push("### Entrees d'exceptions obsoletes (avis disparu de l'audit, a nettoyer)");
  lines.push(
    table(
      ['GHSA', 'Paquet', 'Expire le', 'Approuve par'],
      staleExceptions.map((e) => [e.ghsa, e.package, e.expires, e.approver]),
    ),
  );
  return lines.join('\n');
}

function failureReport(mode, err) {
  return [
    `## Rapport SCA — mode \`${mode}\` — ECHEC`,
    '',
    "Le controle n'a pas pu produire de verdict fiable et refuse de conclure (fail-closed,",
    'ADR-0014 S14). Ce n\'est PAS un rapport "0 avis" : aucune analyse n\'a eu lieu.',
    '',
    `**Cause** : ${err.message}`,
  ].join('\n');
}

function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  try {
    const auditReport = runAudit();
    const advisories = collectAdvisories(auditReport);
    const exceptions = loadExceptions();
    const result = evaluate(advisories, exceptions, mode);

    console.log(buildReport({ mode, ...result }));

    if (mode === 'gate' && result.uncovered.length > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    if (mode === 'gate') {
      console.error(failureReport(mode, err));
      process.exitCode = 1;
    } else {
      // La veille planifiee ne doit jamais echouer le workflow (E2, ADR-0014 S5), mais elle ne
      // doit pas non plus taire une panne : le rapport d'echec est imprime sur stdout comme le
      // rapport normal, pour finir dans l'issue de veille au lieu d'un silence (finding S-2).
      console.log(failureReport(mode, err));
      process.exitCode = 0;
    }
  }
}

const isMainModule = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
