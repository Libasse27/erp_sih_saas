import { describe, expect, it } from 'vitest';
import { Email } from './Email.js';

describe('Email', () => {
  it('normalise en minuscules', () => {
    const result = Email.create('  Docteur.Diop@Hopital.SN ');
    expect(result.isSuccess()).toBe(true);
    expect(result.getValue().value).toBe('docteur.diop@hopital.sn');
  });

  it("rejette une valeur sans '@'", () => {
    const result = Email.create('pas-un-email');
    expect(result.isFailure()).toBe(true);
  });

  it('rejette une chaine vide', () => {
    const result = Email.create('   ');
    expect(result.isFailure()).toBe(true);
  });

  it('deux emails egaux (meme valeur normalisee) sont egaux par valeur', () => {
    const a = Email.create('a@b.sn').getValue();
    const b = Email.create('A@B.SN').getValue();
    expect(a.equals(b)).toBe(true);
  });
});
