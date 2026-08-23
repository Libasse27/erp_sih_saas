import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../domain/ports/IdGenerator.js';

export class UuidGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
