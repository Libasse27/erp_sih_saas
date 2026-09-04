import { describe, expect, it } from 'vitest';
import { FixedClock, mustFail, mustSucceed, SequentialIdGenerator, uuidAt } from '../../../../test/identity/builders/testKit.js';
import {
  ApproverCannotBeRequesterError,
  ApproverCannotTargetSelfError,
  BreakGlassReasonRequiredError,
  RequestNotPendingError,
  RequesterCannotTargetSelfError,
  SuperAdminBreakGlassRequest,
} from './SuperAdminBreakGlassRequest.js';
import { SuperAdminBreakGlassRequestId } from './value-objects/SuperAdminBreakGlassRequestId.js';
import { UserAccountId } from './value-objects/UserAccountId.js';

const REQUEST_ID = mustSucceed(SuperAdminBreakGlassRequestId.create(uuidAt(1)));
const A_SUBJECT = mustSucceed(UserAccountId.create(uuidAt(2)));
const B_REQUESTER = mustSucceed(UserAccountId.create(uuidAt(3)));
const C_APPROVER = mustSucceed(UserAccountId.create(uuidAt(4)));

describe('SuperAdminBreakGlassRequest (ADR-0005 Amendement 1, O-04 residu 4)', () => {
  const clock = new FixedClock('2026-09-03T10:00:00Z');
  const idGenerator = new SequentialIdGenerator();

  describe('request() — ouverture', () => {
    it('succes : cree une demande PENDING et emet SuperAdminBreakGlassRequested', () => {
      const result = SuperAdminBreakGlassRequest.request({
        id: REQUEST_ID,
        requestedByUserId: B_REQUESTER,
        subjectUserAccountId: A_SUBJECT,
        reason: 'perte du telephone du SUPER_ADMIN, identite verifiee hors bande',
        clock,
        idGenerator,
      });

      const request = mustSucceed(result);
      expect(request.status).toBe('PENDING');
      expect(request.requestedByUserId.equals(B_REQUESTER)).toBe(true);
      expect(request.subjectUserAccountId.equals(A_SUBJECT)).toBe(true);
      expect(request.approvedByUserId).toBeNull();
      expect(request.approvedAt).toBeNull();
      expect(request.requestedAt).toEqual(clock.now());

      const events = request.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe('identity.super-admin-break-glass.requested');
      expect((events[0] as unknown as { requestedByUserId: string }).requestedByUserId).toBe(B_REQUESTER.toString());
      expect((events[0] as unknown as { subjectUserAccountId: string }).subjectUserAccountId).toBe(A_SUBJECT.toString());
      // Minimisation (ADR-0005 §6) : le motif ne fait JAMAIS partie de l'evenement Outbox.
      expect((events[0] as unknown as { reason?: unknown }).reason).toBeUndefined();
    });

    it('RequesterCannotTargetSelfError : A ne peut jamais demander sa propre recuperation (A ne peut jamais etre B)', () => {
      const result = SuperAdminBreakGlassRequest.request({
        id: REQUEST_ID,
        requestedByUserId: A_SUBJECT,
        subjectUserAccountId: A_SUBJECT,
        reason: 'motif',
        clock,
        idGenerator,
      });

      expect(mustFail(result)).toBeInstanceOf(RequesterCannotTargetSelfError);
    });

    it('BreakGlassReasonRequiredError : motif vide', () => {
      const result = SuperAdminBreakGlassRequest.request({
        id: REQUEST_ID,
        requestedByUserId: B_REQUESTER,
        subjectUserAccountId: A_SUBJECT,
        reason: '   ',
        clock,
        idGenerator,
      });

      expect(mustFail(result)).toBeInstanceOf(BreakGlassReasonRequiredError);
    });
  });

  describe('approve() — quorum', () => {
    function openRequest(): SuperAdminBreakGlassRequest {
      return mustSucceed(
        SuperAdminBreakGlassRequest.request({
          id: REQUEST_ID,
          requestedByUserId: B_REQUESTER,
          subjectUserAccountId: A_SUBJECT,
          reason: 'motif valide',
          clock,
          idGenerator,
        }),
      );
    }

    it('succes : un DEUXIEME SUPER_ADMIN (C), distinct de A et B, approuve — transition APPROVED + evenement', () => {
      const request = openRequest();
      request.pullDomainEvents();

      const result = request.approve({ approverUserId: C_APPROVER, clock, idGenerator });

      expect(result.isSuccess()).toBe(true);
      expect(request.status).toBe('APPROVED');
      expect(request.approvedByUserId?.equals(C_APPROVER)).toBe(true);
      expect(request.approvedAt).toEqual(clock.now());

      const events = request.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe('identity.super-admin-break-glass.approved');
      expect((events[0] as unknown as { approvedByUserId: string }).approvedByUserId).toBe(C_APPROVER.toString());
    });

    it('RequestNotPendingError : une demande deja APPROVED ne peut pas etre approuvee une seconde fois (anti double-approbation)', () => {
      const request = openRequest();
      mustSucceed(request.approve({ approverUserId: C_APPROVER, clock, idGenerator }));

      const secondApprover = mustSucceed(UserAccountId.create(uuidAt(5)));
      const result = request.approve({ approverUserId: secondApprover, clock, idGenerator });

      expect(mustFail(result)).toBeInstanceOf(RequestNotPendingError);
      expect(request.approvedByUserId?.equals(C_APPROVER)).toBe(true);
    });

    it('ApproverCannotTargetSelfError : le SUJET (A) ne peut jamais approuver sa propre demande (A ne peut jamais etre C)', () => {
      const request = openRequest();
      const result = request.approve({ approverUserId: A_SUBJECT, clock, idGenerator });

      expect(mustFail(result)).toBeInstanceOf(ApproverCannotTargetSelfError);
      expect(request.status).toBe('PENDING');
    });

    it('ApproverCannotBeRequesterError : le DEMANDEUR (B) ne peut jamais approuver sa propre demande (B ne peut jamais etre C)', () => {
      const request = openRequest();
      const result = request.approve({ approverUserId: B_REQUESTER, clock, idGenerator });

      expect(mustFail(result)).toBeInstanceOf(ApproverCannotBeRequesterError);
      expect(request.status).toBe('PENDING');
    });
  });

  it('reconstitute() : aller-retour fidele depuis un etat persiste, sans emettre d_evenement', () => {
    const request = SuperAdminBreakGlassRequest.reconstitute(REQUEST_ID, {
      requestedByUserId: B_REQUESTER,
      subjectUserAccountId: A_SUBJECT,
      reason: 'motif persiste',
      status: 'APPROVED',
      approvedByUserId: C_APPROVER,
      requestedAt: clock.now(),
      approvedAt: clock.now(),
    });

    expect(request.status).toBe('APPROVED');
    expect(request.approvedByUserId?.equals(C_APPROVER)).toBe(true);
    expect(request.pullDomainEvents()).toHaveLength(0);
  });
});
