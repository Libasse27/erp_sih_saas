import { describe, expect, it } from 'vitest';
import { TenantId } from '../../../shared-kernel/domain/value-objects/TenantId.js';
import { Notification } from './Notification.js';
import { NotificationId } from './value-objects/NotificationId.js';

const NOW = new Date('2026-08-28T00:00:00.000Z');
const ID = () => NotificationId.create('00000000-0000-4000-8000-000000000001').getValue();
const TENANT = () => TenantId.create('00000000-0000-4000-8000-00000000f001').getValue();

describe('Notification (ADR-0007 §5)', () => {
  it('cree une notification EMAIL valide, statut PENDING, 0 tentative', () => {
    const result = Notification.create({
      id: ID(),
      tenantId: TENANT(),
      channel: 'EMAIL',
      recipient: 'admin@hopital.sn',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: '00000000-0000-4000-8000-0000000000e1',
      now: NOW,
    });
    expect(result.isSuccess()).toBe(true);
    const notification = result.getValue();
    expect(notification.status).toBe('PENDING');
    expect(notification.attempts).toBe(0);
    expect(notification.channel).toBe('EMAIL');
    expect(notification.recipient).toBe('admin@hopital.sn');
    expect(notification.sentAt).toBeNull();
    expect(notification.providerMessageId).toBeNull();
  });

  it('cree une notification SMS valide (mecanique testee independamment de tout declencheur reel, ADR-0007 §2)', () => {
    const result = Notification.create({
      id: ID(),
      tenantId: null,
      channel: 'SMS',
      recipient: '+221771234567',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: '00000000-0000-4000-8000-0000000000e1',
      now: NOW,
    });
    expect(result.isSuccess()).toBe(true);
  });

  it('refuse un destinataire vide', () => {
    const result = Notification.create({
      id: ID(),
      tenantId: null,
      channel: 'EMAIL',
      recipient: '   ',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: '00000000-0000-4000-8000-0000000000e1',
      now: NOW,
    });
    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('EmptyNotificationRecipientError');
  });

  it("refuse un destinataire EMAIL implausible (garde-fou defense en profondeur, pas la validation complete — deja faite en amont)", () => {
    const result = Notification.create({
      id: ID(),
      tenantId: null,
      channel: 'EMAIL',
      recipient: 'pas-un-email',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: '00000000-0000-4000-8000-0000000000e1',
      now: NOW,
    });
    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('InvalidNotificationRecipientForChannelError');
  });

  it('refuse un destinataire SMS implausible (pas au format E.164)', () => {
    const result = Notification.create({
      id: ID(),
      tenantId: null,
      channel: 'SMS',
      recipient: '0771234567',
      templateKind: 'SUBSCRIPTION_WELCOME',
      sourceEventId: '00000000-0000-4000-8000-0000000000e1',
      now: NOW,
    });
    expect(result.isFailure()).toBe(true);
    expect(result.getError().name).toBe('InvalidNotificationRecipientForChannelError');
  });

  it('accepte tenantId=null (notification de niveau plateforme, ADR-0007 §6)', () => {
    const result = Notification.create({
      id: ID(),
      tenantId: null,
      channel: 'EMAIL',
      recipient: 'admin@hopital.sn',
      templateKind: 'SUBSCRIPTION_PLAN_CHANGED',
      sourceEventId: '00000000-0000-4000-8000-0000000000e1',
      now: NOW,
    });
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().tenantId).toBeNull();
  });
});
