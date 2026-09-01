import type { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock } from '../../identity/builders/testKit.js';
import { UuidGenerator } from '../../../src/shared-kernel/infrastructure/UuidGenerator.js';
import { PgUnitOfWork } from '../../../src/shared-kernel/infrastructure/persistence/PgUnitOfWork.js';
import { buildAuditModule, type AuditModule } from '../../../src/modules/audit/infrastructure/AuditModule.js';
import type { AuditReadPrincipal } from '../../../src/modules/audit/application/AuditReadPrincipal.js';
import { createSuperuserPgClient, createTestPrismaClient, uniqueId } from './dbTestHelpers.js';

/**
 * Integrite de la chaine SHA-256 (ADR-0009 §5, §10 — dernier des quatre volets de garde-fou exiges
 * par le responsable technique pour l'etape 11/13, en plus des trois niveaux d'isolation
 * inter-tenant).
 *
 * Le principal `PLATFORM` est utilise pour invoquer `VerifyAuditChainIntegrityHandler` (autorise a
 * verifier n'importe quelle chaine, tenant arbitraire ou plateforme — decision complementaire
 * validee par le responsable technique, deja exercee par auditQueryIsolation.test.ts) : ce fichier
 * porte sur l'INTEGRITE de la chaine elle-meme, pas sur l'autorisation (deja couverte ailleurs).
 *
 * Necessite `docker compose up -d` (PostgreSQL) et les migrations appliquees.
 */
describe('Audit — integrite de la chaine SHA-256 par perimetre (ADR-0009 §5/§10)', () => {
  let prisma: PrismaClient;
  let superuserClient: Client;
  let audit: AuditModule;
  let unitOfWork: PgUnitOfWork;

  const platformPrincipal: AuditReadPrincipal = { kind: 'PLATFORM', actorUserId: uniqueId() };

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    superuserClient = await createSuperuserPgClient();
    audit = buildAuditModule({ prisma, clock: new FixedClock('2026-08-29T08:00:00Z'), idGenerator: new UuidGenerator() });
    unitOfWork = new PgUnitOfWork(prisma);
  });

  afterAll(async () => {
    await superuserClient.end();
    await prisma.$disconnect();
  });

  async function recordFor(tenantId: string, subjectUserId: string = uniqueId()): Promise<void> {
    await unitOfWork.withTransaction(async () => {
      await audit.services.recordEntry({
        category: 'MFA',
        eventType: 'MFA_CHALLENGE_SUCCEEDED',
        outcome: 'SUCCESS',
        tenantId,
        actorKind: 'USER_TENANT',
        actorUserId: subjectUserId,
        actorRoleCodes: [],
        subjectUserId,
        targetType: 'USER_ACCOUNT',
        targetId: subjectUserId,
        reason: null,
        sessionId: null,
        correlationId: null,
      });
    });
  }

  it('genese correcte : la premiere entree d_une chaine FRAICHE porte chain_sequence = 0 et previous_entry_hash = NULL', async () => {
    const tenantId = uniqueId();
    const subjectUserId = uniqueId();
    await recordFor(tenantId, subjectUserId);

    const row = await prisma.auditEntry.findFirst({ where: { subjectUserId } });
    expect(row).not.toBeNull();
    expect(row?.chainSequence?.toString()).toBe('0');
    expect(row?.previousEntryHash).toBeNull();
    expect(row?.entryHash).not.toBeNull();
  });

  it('chaine complete (4 entrees sequentielles) verifiee VERTE : verifiedCount=4, preChainCount=0, firstBrokenSequence=null', async () => {
    const tenantId = uniqueId();
    // SEQUENTIEL par construction (verrou consultatif par chain_key) : ce test prouve la chaine
    // SEQUENTIELLE, le test dedie plus bas ("ecritures CONCURRENTES") prouve la CONCURRENCE.
    for (let i = 0; i < 4; i += 1) {
      await recordFor(tenantId);
    }

    const result = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.verifiedCount).toBe(4);
    expect(value.preChainCount).toBe(0);
    expect(value.firstBrokenSequence).toBeNull();
  });

  it(
    'ligne alteree VIA LE ROLE SUPERUSER sih (jamais sih_app, bloque par les deux defenses independantes) -> ' +
      'firstBrokenSequence pointe EXACTEMENT l_entree attendue — demontre a la fois la valeur ET la limite du §5.4',
    async () => {
      const tenantId = uniqueId();
      const subjectA = uniqueId();
      const subjectB = uniqueId();
      const subjectC = uniqueId();
      // Sequentiel, memes raisons que le test precedent.
      for (const subjectUserId of [subjectA, subjectB, subjectC]) {
        await recordFor(tenantId, subjectUserId);
      }

      // Chaine verte AVANT alteration (etat de reference).
      const before = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
      expect(before.isSuccess()).toBe(true);
      expect(before.getValue().firstBrokenSequence).toBeNull();

      const targetRow = await prisma.auditEntry.findFirst({ where: { subjectUserId: subjectB } });
      if (targetRow === null || targetRow.chainSequence === null) {
        throw new Error('Ligne cible introuvable ou hors chaine (bug de test).');
      }
      expect(targetRow.chainSequence.toString()).toBe('1');

      // Alteration APPLICATIVE (le contenu hache change, l_empreinte stockee ne correspond plus)
      // via le role SUPERUSER `sih` — SEUL role capable de contourner les DEUX defenses
      // independantes de l'append-only (REVOKE UPDATE + trigger `audit_entry_is_append_only`,
      // ADR-0005 §5). `session_replication_role = 'replica'` desactive les triggers ORIGINE
      // UNIQUEMENT POUR CETTE SESSION (GUC de connexion, jamais un changement de catalogue
      // partage) : aucune autre connexion (y compris `sih_app` d'un test concurrent) n'est
      // affectee — contrairement a `ALTER TABLE ... DISABLE TRIGGER`, qui modifierait un etat
      // GLOBAL partage par toute la suite d'integration.
      await superuserClient.query("SET session_replication_role = 'replica'");
      try {
        await superuserClient.query('UPDATE "platform"."AuditEntry" SET outcome = $1 WHERE id = $2', ['FAILURE', targetRow.id]);
      } finally {
        await superuserClient.query("SET session_replication_role = 'origin'");
      }

      const after = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
      expect(after.isSuccess()).toBe(true);
      const value = after.getValue();
      expect(value.firstBrokenSequence).toBe(1);
      // Verifie AU MOINS l'entree de genese (sequence 0, non alteree) avant la rupture.
      expect(value.verifiedCount).toBeGreaterThanOrEqual(1);
    },
  );

  it('deux (N) ecritures CONCURRENTES sur la MEME chaine -> AUCUNE fourche, sequence contigue 0..N-1', async () => {
    const tenantId = uniqueId();
    const CONCURRENT_WRITES = 6;

    await Promise.all(Array.from({ length: CONCURRENT_WRITES }, () => recordFor(tenantId)));

    const rows = await prisma.auditEntry.findMany({ where: { tenantId }, orderBy: { chainSequence: 'asc' } });
    expect(rows).toHaveLength(CONCURRENT_WRITES);
    const sequences = rows.map((row) => row.chainSequence?.toString());
    expect(sequences).toEqual(Array.from({ length: CONCURRENT_WRITES }, (_unused, i) => i.toString()));

    // Aucune fourche : chaque `previous_entry_hash` (sauf la genese) correspond EXACTEMENT a
    // l'`entry_hash` de la ligne precedente — une chaine, jamais un arbre.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.previousEntryHash).toBe(rows[i - 1]?.entryHash);
    }
    expect(rows[0]?.previousEntryHash).toBeNull();

    const result = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
    expect(result.isSuccess()).toBe(true);
    const value = result.getValue();
    expect(value.verifiedCount).toBe(CONCURRENT_WRITES);
    expect(value.firstBrokenSequence).toBeNull();
  });

  it(
    'chaine de plus de 200 entrees (>= 205) : alteration AU-DELA de la 200e -> firstBrokenSequence pointe ' +
      'EXACTEMENT l_entree alteree, jamais null (correctif securite 2026-09-01 — ELEVE : ' +
      '`readChainSegment` etait plafonne silencieusement a `AUDIT_PAGE_MAX_LIMIT` (200, une constante de ' +
      'PAGINATION HTTP sans rapport), faisant sortir `VerifyAuditChainIntegrityHandler` de sa boucle des ' +
      'le premier lot et declarant a tort la chaine integre au-dela de la 200e entree)',
    async () => {
      const tenantId = uniqueId();
      const TOTAL_ENTRIES = 205;
      const TARGET_INDEX = 202; // > 200 : structurellement invisible a l'ancien bug (plafond silencieux a 200).

      // Sequentiel (memes raisons que les tests "genese"/"chaine complete" ci-dessus) : le verrou
      // consultatif par `chain_key` serialise de toute facon les ecritures sur CETTE chaine.
      for (let i = 0; i < TOTAL_ENTRIES; i += 1) {
        await recordFor(tenantId);
      }

      const rows = await prisma.auditEntry.findMany({ where: { tenantId }, orderBy: { chainSequence: 'asc' } });
      expect(rows).toHaveLength(TOTAL_ENTRIES);

      const targetRow = rows[TARGET_INDEX];
      if (targetRow === undefined || targetRow.chainSequence === null) {
        throw new Error('Ligne cible introuvable ou hors chaine (bug de test).');
      }
      const targetSequence = Number(targetRow.chainSequence);
      expect(targetSequence).toBeGreaterThanOrEqual(200);

      // Chaine verte AVANT alteration (etat de reference) — preuve que le verificateur PARCOURT
      // reellement au-dela du premier lot de 200 quand tout est intact.
      const before = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
      expect(before.isSuccess()).toBe(true);
      const beforeValue = before.getValue();
      expect(beforeValue.firstBrokenSequence).toBeNull();
      expect(beforeValue.verifiedCount).toBe(TOTAL_ENTRIES);

      // Alteration APPLICATIVE via le role SUPERUSER `sih` (meme mecanisme que le test ci-dessus)
      // d'une ligne situee AU-DELA de la 200e.
      await superuserClient.query("SET session_replication_role = 'replica'");
      try {
        await superuserClient.query('UPDATE "platform"."AuditEntry" SET outcome = $1 WHERE id = $2', ['FAILURE', targetRow.id]);
      } finally {
        await superuserClient.query("SET session_replication_role = 'origin'");
      }

      const after = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
      expect(after.isSuccess()).toBe(true);
      const afterValue = after.getValue();
      // C'est L'ASSERTION du correctif : AVANT correction, le verificateur sortait de boucle des
      // le premier lot (plafonne a 200) et renvoyait TOUJOURS `firstBrokenSequence: null` pour
      // une alteration situee au-dela — quelle que soit l'alteration reelle plus loin dans la
      // chaine.
      expect(afterValue.firstBrokenSequence).not.toBeNull();
      expect(afterValue.firstBrokenSequence).toBe(targetSequence);
      expect(afterValue.verifiedCount).toBeGreaterThanOrEqual(200);
    },
    60_000,
  );

  it(
    'entrees "pre-chaine" (entry_hash IS NULL, jamais retro-chainees, §5.3) : COMPTEES et SIGNALEES par le verificateur, ' +
      'jamais ignorees en silence — la chaine REELLE recommence a une genese normale APRES elles',
    async () => {
      const tenantId = uniqueId();
      const preChainSubjectId = uniqueId();

      // Simule une ligne ecrite AVANT la migration de chainage (entry_hash NULL) — structurellement
      // impossible via `recordEntry()` (le trigger `audit_entry_requires_hash` la rejetterait, voir
      // auditEntryImmutability.test.ts) : seul le role SUPERUSER, session en mode `replica`, peut
      // la produire ici pour les besoins de CE test.
      await superuserClient.query("SET session_replication_role = 'replica'");
      try {
        await superuserClient.query(
          `INSERT INTO "platform"."AuditEntry"
             (id, category, event_type, outcome, tenant_id, actor_kind, actor_user_id, actor_role_codes,
              subject_user_id, target_type, target_id, reason, session_id, correlation_id, occurred_at, entry_hash)
           VALUES
             ($1::uuid, 'MFA', 'MFA_CHALLENGE_SUCCEEDED', 'SUCCESS', $2::uuid, 'USER_TENANT', $3::uuid, '{}',
              $3::uuid, 'USER_ACCOUNT', $3::text, NULL, NULL, NULL, now(), NULL)`,
          [uniqueId(), tenantId, preChainSubjectId],
        );
      } finally {
        await superuserClient.query("SET session_replication_role = 'origin'");
      }

      // Deux entrees REELLES, ecrites APRES la ligne pre-chaine.
      await recordFor(tenantId);
      await recordFor(tenantId);

      const result = await audit.queries.verifyAuditChainIntegrity.execute(platformPrincipal, { kind: 'TENANT', tenantId });
      expect(result.isSuccess()).toBe(true);
      const value = result.getValue();
      expect(value.preChainCount).toBe(1);
      expect(value.verifiedCount).toBe(2);
      expect(value.firstBrokenSequence).toBeNull();

      // La ligne pre-chaine reste bien en base (jamais supprimee/ignoree) mais hors chaine.
      const preChainRow = await prisma.auditEntry.findFirst({ where: { subjectUserId: preChainSubjectId } });
      expect(preChainRow).not.toBeNull();
      expect(preChainRow?.entryHash).toBeNull();
      expect(preChainRow?.chainSequence).toBeNull();
    },
  );
});
