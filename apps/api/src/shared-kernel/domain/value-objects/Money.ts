import { Result } from '../Result.js';
import { ValueObject } from '../ValueObject.js';

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

interface MoneyProps {
  readonly amount: number;
  readonly currency: 'XOF';
}

/**
 * Montant en XOF. Le XOF est une devise a zero decimale (ISO 4217) : le montant est
 * toujours un entier de francs CFA, jamais un flottant — evite toute classe d'erreur
 * d'arrondi binaire sur des montants financiers (O-02, O-12, O-13).
 * Multi-devise explicitement hors V1 (00-executive-summary.md §6) : `currency` reste un
 * litteral unique tant qu'aucun ADR ne l'ouvre.
 */
export class Money extends ValueObject<MoneyProps> {
  private constructor(props: MoneyProps) {
    super(props);
  }

  static fromXOF(amount: number): Result<Money, InvalidMoneyError> {
    if (!Number.isInteger(amount)) {
      return Result.failure(
        new InvalidMoneyError(`Le montant XOF doit etre un entier, reçu : ${amount}.`),
      );
    }
    if (amount < 0) {
      return Result.failure(new InvalidMoneyError('Le montant XOF ne peut pas etre negatif.'));
    }
    return Result.success(new Money({ amount, currency: 'XOF' }));
  }

  static zero(): Money {
    return new Money({ amount: 0, currency: 'XOF' });
  }

  get amount(): number {
    return this.props.amount;
  }

  get currency(): 'XOF' {
    return this.props.currency;
  }

  add(other: Money): Money {
    return new Money({ amount: this.props.amount + other.props.amount, currency: 'XOF' });
  }

  /**
   * Soustraction — ajoutee pour le module Subscription (O-02.6, calcul de proratisation
   * d'upgrade). Delegue a `fromXOF` plutot que de dupliquer sa validation : un resultat negatif
   * (soustraction d'un montant superieur) est un echec metier attendu (`Result`, pas une
   * exception), pas une erreur de programmation — le meme invariant que la construction, donc
   * la meme voie de validation.
   */
  subtract(other: Money): Result<Money, InvalidMoneyError> {
    return Money.fromXOF(this.props.amount - other.props.amount);
  }

  isZero(): boolean {
    return this.props.amount === 0;
  }
}
