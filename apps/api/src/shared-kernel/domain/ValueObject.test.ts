import { describe, expect, it } from 'vitest';
import { ValueObject } from './ValueObject.js';

interface FakeProps {
  readonly value: string;
}

class FakeValueObject extends ValueObject<FakeProps> {
  constructor(props: FakeProps) {
    super(props);
  }

  get value(): string {
    return this.props.value;
  }
}

class OtherFakeValueObject extends ValueObject<FakeProps> {
  constructor(props: FakeProps) {
    super(props);
  }
}

describe('ValueObject', () => {
  it('gele les props recues au constructeur (immuabilite)', () => {
    const vo = new FakeValueObject({ value: 'a' });
    expect(Object.isFrozen((vo as unknown as { props: FakeProps }).props)).toBe(true);
  });

  it('deux instances de meme classe portant des props structurellement identiques sont egales', () => {
    const a = new FakeValueObject({ value: 'a' });
    const b = new FakeValueObject({ value: 'a' });
    expect(a.equals(b)).toBe(true);
  });

  it('deux instances de meme classe portant des props differentes ne sont pas egales', () => {
    const a = new FakeValueObject({ value: 'a' });
    const b = new FakeValueObject({ value: 'b' });
    expect(a.equals(b)).toBe(false);
  });

  it('deux instances de classes DIFFERENTES portant les MEMES props ne sont jamais egales (egalite structurelle + type)', () => {
    const a = new FakeValueObject({ value: 'a' });
    const b = new OtherFakeValueObject({ value: 'a' });
    expect(a.equals(b)).toBe(false);
  });

  it('n_est jamais egale a undefined', () => {
    const a = new FakeValueObject({ value: 'a' });
    expect(a.equals(undefined)).toBe(false);
  });

  it('n_est jamais egale a null', () => {
    const a = new FakeValueObject({ value: 'a' });
    expect(a.equals(null)).toBe(false);
  });
});
