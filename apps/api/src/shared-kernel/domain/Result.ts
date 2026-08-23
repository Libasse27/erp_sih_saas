/**
 * Resultat explicite pour les operations du domaine qui peuvent echouer de maniere attendue
 * (violation d'invariant, regle metier non satisfaite). Reserve aux echecs previsibles :
 * une erreur de programmation (bug) doit continuer a lancer une exception.
 */
export class Result<T, E> {
  private constructor(
    private readonly ok: boolean,
    private readonly value: T | undefined,
    private readonly error: E | undefined,
  ) {}

  static success<T, E = never>(value: T): Result<T, E> {
    return new Result<T, E>(true, value, undefined);
  }

  static failure<T = never, E = unknown>(error: E): Result<T, E> {
    return new Result<T, E>(false, undefined, error);
  }

  isSuccess(): boolean {
    return this.ok;
  }

  isFailure(): boolean {
    return !this.ok;
  }

  getValue(): T {
    if (!this.ok) {
      throw new Error('Result.getValue() appele sur un resultat en echec.');
    }
    return this.value as T;
  }

  getError(): E {
    if (this.ok) {
      throw new Error('Result.getError() appele sur un resultat en succes.');
    }
    return this.error as E;
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    return this.ok ? Result.success(fn(this.value as T)) : Result.failure(this.error as E);
  }
}
