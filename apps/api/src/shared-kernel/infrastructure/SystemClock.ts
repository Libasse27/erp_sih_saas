import type { Clock } from '../domain/ports/Clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
