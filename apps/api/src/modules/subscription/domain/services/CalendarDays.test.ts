import { describe, expect, it } from 'vitest';
import { addCalendarDays, calendarDaysBetween } from './CalendarDays.js';

describe('calendarDaysBetween', () => {
  it('compte les jours calendaires entre deux dates UTC', () => {
    expect(calendarDaysBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'))).toBe(30);
  });

  it('ignore l_heure de la journee (troncature calendaire)', () => {
    expect(
      calendarDaysBetween(new Date('2026-08-01T23:59:00Z'), new Date('2026-08-02T00:01:00Z')),
    ).toBe(1);
  });

  it('renvoie 0 pour la meme date', () => {
    expect(calendarDaysBetween(new Date('2026-08-16T10:00:00Z'), new Date('2026-08-16T18:00:00Z'))).toBe(0);
  });

  it('peut renvoyer une valeur negative si `to` precede `from`', () => {
    expect(calendarDaysBetween(new Date('2026-08-31T00:00:00Z'), new Date('2026-08-01T00:00:00Z'))).toBe(-30);
  });

  it('traverse un changement de mois et une annee bissextile (2028)', () => {
    expect(calendarDaysBetween(new Date('2028-02-01T00:00:00Z'), new Date('2028-03-01T00:00:00Z'))).toBe(29);
  });
});

describe('addCalendarDays', () => {
  it('ajoute 30 jours calendaires (essai gratuit O-02.5)', () => {
    const start = new Date('2026-08-24T10:00:00Z');
    const end = addCalendarDays(start, 30);
    expect(end.toISOString()).toBe('2026-09-23T10:00:00.000Z');
  });

  it('conserve l_heure d_origine', () => {
    const start = new Date('2026-08-24T10:15:42Z');
    const end = addCalendarDays(start, 1);
    expect(end.getUTCHours()).toBe(10);
    expect(end.getUTCMinutes()).toBe(15);
    expect(end.getUTCSeconds()).toBe(42);
  });
});
