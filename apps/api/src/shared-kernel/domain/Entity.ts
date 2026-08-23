/**
 * Entite : identite stable (id), egalite par identite, pas par valeur.
 */
export abstract class Entity<Id extends { equals(other: Id): boolean }> {
  protected constructor(protected readonly _id: Id) {}

  get id(): Id {
    return this._id;
  }

  equals(other: Entity<Id> | undefined | null): boolean {
    if (other === undefined || other === null) {
      return false;
    }
    if (other.constructor !== this.constructor) {
      return false;
    }
    return this._id.equals(other._id);
  }
}
