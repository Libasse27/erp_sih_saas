import { describe, expect, it } from 'vitest';
import { Entity } from './Entity.js';

class FakeId {
  constructor(private readonly value: string) {}

  equals(other: FakeId): boolean {
    return this.value === other.value;
  }
}

class FakeEntity extends Entity<FakeId> {
  constructor(id: FakeId) {
    super(id);
  }
}

class OtherFakeEntity extends Entity<FakeId> {
  constructor(id: FakeId) {
    super(id);
  }
}

describe('Entity', () => {
  it('expose l_identite fournie au constructeur via le getter id', () => {
    const id = new FakeId('1');
    const entity = new FakeEntity(id);
    expect(entity.id).toBe(id);
  });

  it('deux entites de meme classe portant le meme id sont egales', () => {
    const a = new FakeEntity(new FakeId('1'));
    const b = new FakeEntity(new FakeId('1'));
    expect(a.equals(b)).toBe(true);
  });

  it('deux entites de meme classe portant des ids differents ne sont pas egales', () => {
    const a = new FakeEntity(new FakeId('1'));
    const b = new FakeEntity(new FakeId('2'));
    expect(a.equals(b)).toBe(false);
  });

  it('deux entites de classes DIFFERENTES portant le meme id ne sont jamais egales (identite = id + type)', () => {
    const a = new FakeEntity(new FakeId('1'));
    const b = new OtherFakeEntity(new FakeId('1'));
    expect(a.equals(b)).toBe(false);
  });

  it('n_est jamais egale a undefined', () => {
    const a = new FakeEntity(new FakeId('1'));
    expect(a.equals(undefined)).toBe(false);
  });

  it('n_est jamais egale a null', () => {
    const a = new FakeEntity(new FakeId('1'));
    expect(a.equals(null)).toBe(false);
  });
});
