import { describe, expect, it } from 'vitest';
import { Result } from './Result.js';

describe('Result', () => {
  describe('success', () => {
    it('isSuccess() est vrai, isFailure() est faux', () => {
      const result = Result.success<number, string>(42);
      expect(result.isSuccess()).toBe(true);
      expect(result.isFailure()).toBe(false);
    });

    it('getValue() renvoie la valeur portee', () => {
      const result = Result.success<number, string>(42);
      expect(result.getValue()).toBe(42);
    });

    it('getError() leve une exception (bug appelant, jamais un echec metier)', () => {
      const result = Result.success<number, string>(42);
      expect(() => result.getError()).toThrow('Result.getError() appele sur un resultat en succes.');
    });
  });

  describe('failure', () => {
    it('isFailure() est vrai, isSuccess() est faux', () => {
      const result = Result.failure<number, string>('ERR');
      expect(result.isFailure()).toBe(true);
      expect(result.isSuccess()).toBe(false);
    });

    it('getError() renvoie l_erreur portee', () => {
      const result = Result.failure<number, string>('ERR');
      expect(result.getError()).toBe('ERR');
    });

    it('getValue() leve une exception (bug appelant, jamais une valeur par defaut silencieuse)', () => {
      const result = Result.failure<number, string>('ERR');
      expect(() => result.getValue()).toThrow('Result.getValue() appele sur un resultat en echec.');
    });
  });

  describe('map', () => {
    it('transforme la valeur d_un resultat en succes, sans toucher au type d_erreur', () => {
      const result = Result.success<number, string>(21).map((value) => value * 2);
      expect(result.isSuccess()).toBe(true);
      expect(result.getValue()).toBe(42);
    });

    it('propage l_erreur telle quelle sur un resultat en echec, sans jamais invoquer la fonction', () => {
      let called = false;
      const result = Result.failure<number, string>('ERR').map((value) => {
        called = true;
        return value * 2;
      });
      expect(called).toBe(false);
      expect(result.isFailure()).toBe(true);
      expect(result.getError()).toBe('ERR');
    });
  });
});
