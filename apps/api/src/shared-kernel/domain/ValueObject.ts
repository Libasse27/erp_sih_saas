/**
 * Value Object : egalite structurelle, immuable, sans identite propre.
 * Toute sous-classe doit valider ses invariants dans son propre constructeur/factory —
 * ce socle ne fait qu'imposer l'egalite par valeur.
 */
export abstract class ValueObject<Props extends object> {
  protected readonly props: Readonly<Props>;

  protected constructor(props: Props) {
    this.props = Object.freeze({ ...props });
  }

  equals(other: ValueObject<Props> | undefined | null): boolean {
    if (other === undefined || other === null) {
      return false;
    }
    if (other.constructor !== this.constructor) {
      return false;
    }
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }
}
