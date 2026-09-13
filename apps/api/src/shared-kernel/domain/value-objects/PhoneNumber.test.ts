import { describe, expect, it } from 'vitest';
import { PhoneNumber } from './PhoneNumber.js';

describe('PhoneNumber', () => {
  describe('create', () => {
    it('cree un numero senegalais valide au format E.164', () => {
      const result = PhoneNumber.create('+221771234567');
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().toE164()).toBe('+221771234567');
    });

    it('normalise les espaces, points et tirets avant validation', () => {
      const result = PhoneNumber.create('+221 77-123.45 67');
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().toE164()).toBe('+221771234567');
    });

    it('rejette un numero sans indicatif +221', () => {
      const result = PhoneNumber.create('0771234567');
      expect(result.isFailure()).toBe(true);
    });

    it('rejette un numero avec un nombre de chiffres incorrect', () => {
      const result = PhoneNumber.create('+22177123456');
      expect(result.isFailure()).toBe(true);
    });

    it('rejette un indicatif etranger', () => {
      const result = PhoneNumber.create('+33612345678');
      expect(result.isFailure()).toBe(true);
    });
  });

  describe('equals (ValueObject)', () => {
    it('deux numeros identiques sont egaux par structure', () => {
      const a = PhoneNumber.create('+221771234567').getValue();
      const b = PhoneNumber.create('+221771234567').getValue();
      expect(a.equals(b)).toBe(true);
    });

    it('deux numeros differents ne sont pas egaux', () => {
      const a = PhoneNumber.create('+221771234567').getValue();
      const b = PhoneNumber.create('+221781234567').getValue();
      expect(a.equals(b)).toBe(false);
    });
  });
});
