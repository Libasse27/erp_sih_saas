/**
 * Port de generation d'identifiants. Regle CI (01-target-architecture.md §5) : domain/
 * n'appelle jamais Math.random() ni un generateur concret directement.
 */
export interface IdGenerator {
  generate(): string;
}
