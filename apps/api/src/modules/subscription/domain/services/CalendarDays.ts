/**
 * Arithmetique de jours calendaires (UTC), reutilisee par `Subscription.startTrial` (calcul de
 * `trialEndsAt`, O-02.5) et `ProrationCalculator` (calcul "au jour calendaire pres", O-02.6).
 * Fonctions pures, sans I/O — toutes les `Date` manipulees sont fournies par l'appelant (jamais
 * `Date.now()` ici, regle CI §5 : le temps est toujours injecte via `Clock`).
 *
 * Tronque a la date calendaire UTC (minuit) avant de calculer un ecart en jours : evite qu'une
 * difference d'heure dans la journee (ex. abonnement souscrit a 14h32, calcul lance a 09h00 le
 * lendemain) ne fausse le compte de jours — cohérent avec "au jour calendaire pres" (O-02.6), pas
 * une duree exacte en millisecondes.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Nombre de jours calendaires (UTC) entre deux dates. Peut etre negatif si `to` precede `from`. */
export function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / MS_PER_DAY);
}

/** Ajoute un nombre de jours calendaires (UTC) a une date, en conservant l'heure d'origine. */
export function addCalendarDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
