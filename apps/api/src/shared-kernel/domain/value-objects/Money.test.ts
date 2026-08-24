import { describe, expect, it } from 'vitest';
import { Money } from './Money.js';

describe('Money', () => {
  describe('fromXOF', () => {
    it('cree un montant XOF valide a partir d_un entier positif', () => {
      const result = Money.fromXOF(35_000);
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().amount).toBe(35_000);
      expect(result.getValue().currency).toBe('XOF');
    });

    it('accepte zero', () => {
      const result = Money.fromXOF(0);
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().isZero()).toBe(true);
    });

    it('rejette un montant flottant (le XOF est une devise a zero decimale)', () => {
      const result = Money.fromXOF(1_000.5);
      expect(result.isFailure()).toBe(true);
    });

    it('rejette un montant negatif', () => {
      const result = Money.fromXOF(-1);
      expect(result.isFailure()).toBe(true);
    });
  });

  describe('zero', () => {
    it('renvoie un montant XOF nul', () => {
      expect(Money.zero().isZero()).toBe(true);
      expect(Money.zero().amount).toBe(0);
    });
  });

  describe('add', () => {
    it('additionne deux montants XOF', () => {
      const a = Money.fromXOF(35_000).getValue();
      const b = Money.fromXOF(20_000).getValue();
      expect(a.add(b).amount).toBe(55_000);
    });

    it('ne mute ni l_un ni l_autre operande (immuabilite)', () => {
      const a = Money.fromXOF(35_000).getValue();
      const b = Money.fromXOF(20_000).getValue();
      a.add(b);
      expect(a.amount).toBe(35_000);
      expect(b.amount).toBe(20_000);
    });
  });

  describe('subtract', () => {
    it('soustrait deux montants XOF quand le resultat est positif ou nul', () => {
      const a = Money.fromXOF(55_000).getValue();
      const b = Money.fromXOF(35_000).getValue();
      const result = a.subtract(b);
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().amount).toBe(20_000);
    });

    it('renvoie un Result en echec (pas d_exception) quand le resultat serait negatif', () => {
      const a = Money.fromXOF(35_000).getValue();
      const b = Money.fromXOF(55_000).getValue();
      const result = a.subtract(b);
      expect(result.isFailure()).toBe(true);
    });

    it('produit un montant nul quand les deux operandes sont egaux', () => {
      const a = Money.fromXOF(35_000).getValue();
      const b = Money.fromXOF(35_000).getValue();
      const result = a.subtract(b);
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue().isZero()).toBe(true);
    });
  });

  describe('equals (ValueObject)', () => {
    it('deux montants XOF de meme valeur sont egaux par structure', () => {
      const a = Money.fromXOF(35_000).getValue();
      const b = Money.fromXOF(35_000).getValue();
      expect(a.equals(b)).toBe(true);
    });

    it('deux montants XOF de valeurs differentes ne sont pas egaux', () => {
      const a = Money.fromXOF(35_000).getValue();
      const b = Money.fromXOF(55_000).getValue();
      expect(a.equals(b)).toBe(false);
    });
  });
});
