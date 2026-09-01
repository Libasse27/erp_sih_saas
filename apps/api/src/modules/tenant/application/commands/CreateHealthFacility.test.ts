import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../../shared-kernel/domain/value-objects/TenantId.js';
import {
  FixedClock,
  InMemoryHealthFacilityRepository,
  InMemoryProvisioningAuditTrail,
  InMemoryUnitOfWork,
  InMemoryUserAccountExistenceChecker,
  SequentialIdGenerator,
  uuidAt,
} from '../../../../../test/tenant/builders/testKit.js';
import { CreateHealthFacilityHandler } from './CreateHealthFacility.js';

const OWNER_USER_ID = uuidAt(500);

function buildHandler() {
  const repository = new InMemoryHealthFacilityRepository();
  const unitOfWork = new InMemoryUnitOfWork();
  const userAccountExistenceChecker = new InMemoryUserAccountExistenceChecker();
  const provisioningAuditTrail = new InMemoryProvisioningAuditTrail();
  userAccountExistenceChecker.seed(OWNER_USER_ID);
  const handler = new CreateHealthFacilityHandler(
    repository,
    unitOfWork,
    new FixedClock('2026-08-24T10:00:00Z'),
    new SequentialIdGenerator(),
    userAccountExistenceChecker,
    provisioningAuditTrail,
  );
  return { repository, unitOfWork, userAccountExistenceChecker, provisioningAuditTrail, handler };
}

describe('CreateHealthFacilityHandler', () => {
  it('cree un HealthFacility ACTIF et le persiste sous le tenantId genere', async () => {
    const { repository, handler } = buildHandler();

    const result = await handler.execute({ name: 'Hopital Principal de Dakar', ownerUserId: OWNER_USER_ID });

    expect(result.isSuccess()).toBe(true);
    const { tenantId } = result.getValue();
    const saved = await repository.findByTenantId(TenantId.create(tenantId).getValue());
    expect(saved).not.toBeNull();
    expect(saved?.name.value).toBe('Hopital Principal de Dakar');
    expect(saved?.status).toBe('ACTIVE');
  });

  it("positionne le contexte RLS (UnitOfWorkContext.tenantId) sur l'identifiant genere pour l'agregat — amorçage RLS", async () => {
    const { unitOfWork, handler } = buildHandler();

    const result = await handler.execute({ name: 'Clinique Test', ownerUserId: OWNER_USER_ID });

    expect(result.isSuccess()).toBe(true);
    expect(unitOfWork.lastContext?.tenantId?.toString()).toBe(result.getValue().tenantId);
  });

  it('rejette un nom vide', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ name: '   ', ownerUserId: OWNER_USER_ID });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_NAME');
  });

  it('genere un tenantId different a chaque appel (deux etablissements distincts)', async () => {
    const { handler } = buildHandler();
    const first = await handler.execute({ name: 'Etablissement 1', ownerUserId: OWNER_USER_ID });
    const second = await handler.execute({ name: 'Etablissement 2', ownerUserId: OWNER_USER_ID });

    expect(first.getValue().tenantId).not.toBe(second.getValue().tenantId);
  });

  it('rejette un ownerUserId vide (ADR-0008 §9, amendement 1) — aucune HealthFacility creee', async () => {
    const { handler } = buildHandler();

    const result = await handler.execute({ name: 'Etablissement Sans Proprietaire', ownerUserId: '   ' });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_OWNER_USER_ID');
  });

  it("rejette un ownerUserId ne correspondant a aucun UserAccount existant (ADR-0008 §9, amendement 1) — aucun HealthFacility cree", async () => {
    const { handler } = buildHandler();
    const unknownOwnerId = uuidAt(999);

    const result = await handler.execute({ name: 'Etablissement Proprietaire Inconnu', ownerUserId: unknownOwnerId });

    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('OWNER_ACCOUNT_NOT_FOUND');
  });

  it("propage fidelement ownerUserId dans l'evenement HealthFacilityCreated emis (ADR-0008 §9, amendement 1)", async () => {
    const { handler, repository } = buildHandler();

    const result = await handler.execute({ name: 'Etablissement Trace', ownerUserId: OWNER_USER_ID });
    expect(result.isSuccess()).toBe(true);

    const tenantId = TenantId.create(result.getValue().tenantId).getValue();
    const saved = await repository.findByTenantId(tenantId);
    // `InMemoryHealthFacilityRepository.save()` ne "pull" jamais les evenements (contrairement au
    // vrai `PrismaHealthFacilityRepository.save()`, qui les ecrit dans l'Outbox) : l'evenement
    // accumule par `HealthFacility.create()` est donc toujours present sur l'instance persistee.
    const events = saved?.pullDomainEvents() ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('tenant.health-facility.created');
    expect((events[0] as unknown as { ownerUserId: string }).ownerUserId).toBe(OWNER_USER_ID);
  });

  it('ecrit une entree PROVISIONING_FACILITY_CREATED (ADR-0009 §2.2) dans la meme transaction', async () => {
    const { handler, provisioningAuditTrail } = buildHandler();

    const result = await handler.execute({ name: 'Etablissement Audite', ownerUserId: OWNER_USER_ID });

    expect(result.isSuccess()).toBe(true);
    expect(provisioningAuditTrail.records).toHaveLength(1);
    expect(provisioningAuditTrail.records[0]).toMatchObject({
      eventType: 'PROVISIONING_FACILITY_CREATED',
      outcome: 'SUCCESS',
      tenantId: result.getValue().tenantId,
      actorKind: 'SYSTEM',
      actorUserId: null,
      subjectUserId: OWNER_USER_ID,
      targetType: 'HEALTH_FACILITY',
      targetId: result.getValue().tenantId,
    });
  });
});
