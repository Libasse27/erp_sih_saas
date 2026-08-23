/**
 * Port d'horloge. Regle CI (01-target-architecture.md §5) : domain/ n'appelle jamais
 * Date.now() directement — le temps est toujours injecte, pour rester testable et
 * deterministe (horodatage serveur des journaux d'audit, notamment).
 */
export interface Clock {
  now(): Date;
}
