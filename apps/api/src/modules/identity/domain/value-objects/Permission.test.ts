import { describe, expect, it } from 'vitest';
import { Permission } from './Permission.js';

describe('Permission', () => {
  it('accepte le format <ressource>:<action>', () => {
    const result = Permission.create('patient:read');
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().resource).toBe('patient');
    expect(result.getValue().action).toBe('read');
    expect(result.getValue().code).toBe('patient:read');
  });

  it('accepte des ressources/actions en kebab-case', () => {
    const result = Permission.create('lab-order:create');
    expect(result.isSuccess()).toBe(true);
  });

  it.each(['patientread', 'patient:', ':read', 'Patient:Read', 'patient:read:extra', 'patient:_read'])(
    'rejette le format invalide "%s"',
    (invalid) => {
      const result = Permission.create(invalid);
      expect(result.isFailure()).toBe(true);
    },
  );

  it('identifie les ressources de niveau plateforme', () => {
    expect(Permission.create('tenant:administer').getValue().isPlatformOnly()).toBe(true);
    expect(Permission.create('patient:read').getValue().isPlatformOnly()).toBe(false);
  });
});
