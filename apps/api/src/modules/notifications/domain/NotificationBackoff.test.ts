import { describe, expect, it } from 'vitest';
import { computeBackoffSeconds, computeNextAttemptAt } from './NotificationBackoff.js';

describe('NotificationBackoff (ADR-0007 §6 — ajout deliberement au-dela du calque Outbox)', () => {
  it('suit les paliers 30s, 60s, 120s, 240s selon le nombre de tentatives', () => {
    expect(computeBackoffSeconds(1)).toBe(30);
    expect(computeBackoffSeconds(2)).toBe(60);
    expect(computeBackoffSeconds(3)).toBe(120);
    expect(computeBackoffSeconds(4)).toBe(240);
  });

  it('plafonne a 240s au-dela du dernier palier (jamais un delai croissant sans borne)', () => {
    expect(computeBackoffSeconds(5)).toBe(240);
    expect(computeBackoffSeconds(100)).toBe(240);
  });

  it('traite 0 ou une valeur negative comme le premier palier (defensif, jamais de delai negatif)', () => {
    expect(computeBackoffSeconds(0)).toBe(30);
    expect(computeBackoffSeconds(-5)).toBe(30);
  });

  it('computeNextAttemptAt ajoute le backoff en secondes a la date fournie', () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    const next = computeNextAttemptAt(2, now);
    expect(next.getTime() - now.getTime()).toBe(60 * 1000);
  });
});
