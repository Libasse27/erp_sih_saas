import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryHealthFacilityRepository,
  InMemoryTenantConfigAuditTrail,
  InMemoryUnitOfWork,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import { HealthFacility } from '../../domain/HealthFacility.js';
import { FacilityName } from '../../domain/value-objects/FacilityName.js';
import type { TenantConfigPrincipal } from '../TenantConfigPrincipal.js';
import { RenameHealthFacilityHandler } from './RenameHealthFacility.js';

const OWNER_USER_ID = uuidAt(500);
const ACTOR_ID = uuidAt(600);

async function seedFacility(repository: InMemoryHealthFacilityRepository, name: string): Promise<TenantId> {
  const facility = HealthFacility.create({
    name: FacilityName.create(name).getValue(),
    ownerUserId: OWNER_USER_ID,
    clock: new FixedClock('2026-08-24T10:00:00Z'),
    idGenerator: new SequentialIdGenerator(),
  });
  facility.pullDomainEvents();
  await repository.save(facility, facility.id);
  return facility.id;
}

function buildHandler(
  repository: InMemoryHealthFacilityRepository,
): { handler: RenameHealthFacilityHandler; unitOfWork: InMemoryUnitOfWork; auditTrail: InMemoryTenantConfigAuditTrail } {
  const unitOfWork = new InMemoryUnitOfWork();
  // Fake DURCI (voir testKit.ts) : leve si record() est appele hors transaction — rend visible
  // toute regression du meme type que celle corrigee par ADR-0005 Amendement 3.
  const auditTrail = new InMemoryTenantConfigAuditTrail(unitOfWork);
  const handler = new RenameHealthFacilityHandler(
    repository,
    unitOfWork,
    new FixedClock('2026-09-28T09:00:00Z'),
    new SequentialIdGenerator(),
    auditTrail,
  );
  return { handler, unitOfWork, auditTrail };
}

function tenantPrincipal(tenantId: string, permissionCodes: readonly string[] = ['tenant-config:administer']): TenantConfigPrincipal {
  return {
    kind: 'TENANT',
    actorUserId: ACTOR_ID,
    tenantId,
    roleCodes: ['ADMIN_ETABLISSEMENT'],
    permissionCodes,
  };
}

describe('RenameHealthFacilityHandler', () => {
  it('renomme effectivement et audite un SUCCESS DANS la transaction', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const { handler, auditTrail } = buildHandler(repository);

    const result = await handler.execute({
      principal: tenantPrincipal(tenantId.toString()),
      newName: 'Clinique Renommee',
      sessionId: 'session-1',
      correlationId: 'corr-1',
    });

    expect(result.isSuccess()).toBe(true);
    expect(result.getValue()).toEqual({
      tenantId: tenantId.toString(),
      name: 'Clinique Renommee',
      status: 'ACTIVE',
      createdAt: new Date('2026-08-24T10:00:00Z'),
    });

    const persisted = await repository.findByTenantId(tenantId);
    expect(persisted?.name.value).toBe('Clinique Renommee');

    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({
      eventType: 'TENANT_CONFIG_FACILITY_RENAMED',
      outcome: 'SUCCESS',
      tenantId: tenantId.toString(),
      actorKind: 'USER_TENANT',
      actorUserId: ACTOR_ID,
      targetId: tenantId.toString(),
      sessionId: 'session-1',
      correlationId: 'corr-1',
    });
  });

  it('refuse (FORBIDDEN) une session TENANT sans tenant-config:administer — refus AUDITE (DENIED) et COMMIT dans la transaction', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const { handler, auditTrail } = buildHandler(repository);

    const result = await handler.execute({
      principal: tenantPrincipal(tenantId.toString(), []),
      newName: 'Tentative Non Autorisee',
      sessionId: 'session-2',
      correlationId: null,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FORBIDDEN');

    const persisted = await repository.findByTenantId(tenantId);
    expect(persisted?.name.value).toBe('Hopital Principal de Dakar');

    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]).toMatchObject({
      outcome: 'DENIED',
      tenantId: tenantId.toString(),
      actorKind: 'USER_TENANT',
    });
  });

  it(
    'refuse EXPLICITEMENT (FORBIDDEN) une session PLATFORM — branche nommee, jamais un fallthrough ; refus AUDITE (DENIED, tenantId null) ' +
      'et COMMIT dans une transaction SANS contexte tenant',
    async () => {
      const repository = new InMemoryHealthFacilityRepository();
      const { handler, unitOfWork, auditTrail } = buildHandler(repository);

      const result = await handler.execute({
        principal: { kind: 'PLATFORM', actorUserId: ACTOR_ID },
        newName: 'Tentative Plateforme',
        sessionId: 'session-3',
        correlationId: null,
      });

      expect(result.isFailure()).toBe(true);
      expect(result.getError()).toBe('FORBIDDEN');
      // Aucun contexte tenant — une session PLATFORM n'a structurellement aucun tenant a administrer.
      expect(unitOfWork.lastContext?.tenantId).toBeUndefined();

      expect(auditTrail.records).toHaveLength(1);
      expect(auditTrail.records[0]).toMatchObject({
        outcome: 'DENIED',
        tenantId: null,
        actorKind: 'USER_PLATFORM',
        actorUserId: ACTOR_ID,
        targetId: null,
      });
    },
  );

  it('refuse (INVALID_NAME) un nom vide apres normalisation — audite en FAILURE', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const { handler, auditTrail } = buildHandler(repository);

    const result = await handler.execute({
      principal: tenantPrincipal(tenantId.toString()),
      newName: '   ',
      sessionId: null,
      correlationId: null,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_NAME');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]?.outcome).toBe('FAILURE');
  });

  it('refuse (INVALID_NAME) un nom au-dela de 200 caracteres — audite en FAILURE', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const { handler, auditTrail } = buildHandler(repository);

    const result = await handler.execute({
      principal: tenantPrincipal(tenantId.toString()),
      newName: 'A'.repeat(201),
      sessionId: null,
      correlationId: null,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_NAME');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]?.outcome).toBe('FAILURE');
  });

  it('refuse (NAME_UNCHANGED) un renommage vers un nom strictement identique — aucune ecriture, audite en FAILURE', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantId = await seedFacility(repository, 'Hopital Principal de Dakar');
    const { handler, auditTrail } = buildHandler(repository);

    const result = await handler.execute({
      principal: tenantPrincipal(tenantId.toString()),
      newName: 'Hopital Principal de Dakar',
      sessionId: null,
      correlationId: null,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('NAME_UNCHANGED');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]?.outcome).toBe('FAILURE');
  });

  it('retourne FACILITY_NOT_FOUND (defensif) quand aucun HealthFacility n_existe pour ce tenant — audite en FAILURE', async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const { handler, auditTrail } = buildHandler(repository);
    const orphanTenantId = TenantId.create(uuidAt(999)).getValue();

    const result = await handler.execute({
      principal: tenantPrincipal(orphanTenantId.toString()),
      newName: 'Nouveau Nom',
      sessionId: null,
      correlationId: null,
    });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('FACILITY_NOT_FOUND');
    expect(auditTrail.records).toHaveLength(1);
    expect(auditTrail.records[0]?.outcome).toBe('FAILURE');
  });

  it("tenantId/role forges n'ont aucun effet : le principal (derive du ServerContext serveur) est la SEULE source de tenantId, jamais un champ de commande", async () => {
    const repository = new InMemoryHealthFacilityRepository();
    const tenantIdA = await seedFacility(repository, 'Etablissement A');
    const tenantIdB = TenantId.create(uuidAt(777)).getValue();
    await repository.save(
      HealthFacility.reconstitute(tenantIdB, {
        name: FacilityName.create('Etablissement B').getValue(),
        status: 'ACTIVE',
        createdAt: new Date('2026-08-24T10:00:00Z'),
      }),
      tenantIdB,
    );
    const { handler } = buildHandler(repository);

    // Le type `RenameHealthFacilityCommand` n'expose structurellement AUCUN champ `tenantId` : il
    // n'existe donc aucune valeur a "forger" ici — la preuve HTTP (corps JSON avec un tenantId
    // ignore) est apportee par le test d'integration HTTP dedie.
    const result = await handler.execute({
      principal: tenantPrincipal(tenantIdA.toString()),
      newName: 'Etablissement A Renomme',
      sessionId: null,
      correlationId: null,
    });

    expect(result.isSuccess()).toBe(true);
    const untouchedB = await repository.findByTenantId(tenantIdB);
    expect(untouchedB?.name.value).toBe('Etablissement B');
  });
});
