import { Result } from '../../../../shared-kernel/domain/Result.js';
import { Money } from '../../../../shared-kernel/domain/value-objects/Money.js';
import { calendarDaysBetween } from './CalendarDays.js';

export type ProrationError = 'NOT_AN_UPGRADE';

export interface ProrationInput {
  /** Tarif actuellement applique sur l'abonnement (resolu via `subscription.currentPlanPriceId` — JAMAIS `subscription.plan.price`, contrainte actee O-02.6). */
  readonly oldPrice: Money;
  /** Tarif actuellement effectif du forfait cible (resolu via `PlanPriceRepository`, jamais lu depuis `Plan` directement). */
  readonly newPrice: Money;
  readonly periodStartsAt: Date;
  readonly periodEndsAt: Date;
  readonly now: Date;
}

/**
 * Calcul de proratisation d'un upgrade de forfait, methode figee par O-02.6
 * (03-open-decisions.md, reliquat clos le 2026-08-24) — aucune valeur ni arrondi invente ici,
 * tout provient de cette decision :
 *
 *   montant = (nouveau_prix - ancien_prix) x jours_restants / jours_dans_la_periode
 *
 * - Calcul au jour calendaire pres (`CalendarDays.ts`), jamais un mois de 30 jours suppose.
 * - Arrondi a l'entier FCFA le plus proche ; un `.5` arrondit AU SUPERIEUR.
 * - Minimum d'encaissement de 1 FCFA si le montant brut (non arrondi) est positif mais < 1.
 * - Le "downgrade" n'est jamais proratise (differe a la fin de periode, O-02.6) : cette fonction
 *   ne traite QUE le cas upgrade et echoue explicitement (`NOT_AN_UPGRADE`) si `newPrice` n'est
 *   pas strictement superieur a `oldPrice` — a l'appelant de rediriger vers le flux de downgrade
 *   differe (hors perimetre de cette etape) plutot que d'appeler cette fonction.
 * - Chaque upgrade doit etre calcule par l'appelant depuis le forfait ACTUELLEMENT actif
 *   (`oldPrice` = tarif courant de l'abonnement au moment de l'appel, pas le tarif initial de la
 *   periode) — cette fonction ne connait pas l'historique, c'est a
 *   `UpgradeSubscriptionPlan.ts` de toujours lui passer le tarif courant.
 *
 * L'arrondi "au superieur pile a .5" est fait en arithmetique entiere exacte (jamais de division
 * flottante intermediaire) pour eviter toute imprecision binaire sur un montant financier :
 * floor((2*numerateur + denominateur) / (2*denominateur)) est algebriquement equivalent a
 * floor(numerateur/denominateur + 0.5), sans jamais representer 0.5 en IEEE 754.
 */
export function calculateUpgradeProration(input: ProrationInput): Result<Money, ProrationError> {
  if (input.newPrice.amount <= input.oldPrice.amount) {
    return Result.failure('NOT_AN_UPGRADE');
  }

  const diffResult = input.newPrice.subtract(input.oldPrice);
  if (diffResult.isFailure()) {
    // Ne peut pas se produire : on vient de verifier newPrice > oldPrice ci-dessus. Une
    // exception ici signalerait un bug de Money.subtract, pas un echec metier attendu.
    throw new Error('Calcul de proratisation : soustraction de prix invalide malgre la garde amont (bug).');
  }
  const diff = diffResult.getValue();

  const periodLengthDays = calendarDaysBetween(input.periodStartsAt, input.periodEndsAt);
  if (periodLengthDays <= 0) {
    // Invariant de donnees : une periode d'abonnement mal formee (fin <= debut) est une
    // corruption, pas un cas metier a prevoir ici (voir Subscription.ts pour la construction
    // de periodStartsAt/periodEndsAt).
    throw new Error('Calcul de proratisation : periode d_abonnement invalide (periodEndsAt <= periodStartsAt).');
  }

  const daysRemainingRaw = calendarDaysBetween(input.now, input.periodEndsAt);
  const daysRemaining = Math.max(0, Math.min(daysRemainingRaw, periodLengthDays));

  const numerator = diff.amount * daysRemaining;
  const denominator = periodLengthDays;

  let amount: number;
  if (numerator <= 0) {
    amount = 0;
  } else if (numerator < denominator) {
    // Montant brut strictement compris entre 0 et 1 FCFA : plancher d'encaissement (O-02.6).
    amount = 1;
  } else {
    amount = Math.floor((2 * numerator + denominator) / (2 * denominator));
  }

  const moneyResult = Money.fromXOF(amount);
  if (moneyResult.isFailure()) {
    throw new Error('Calcul de proratisation : montant final invalide (bug).');
  }
  return Result.success(moneyResult.getValue());
}
