/**
 * "Depuis quel contexte" une action a ete accomplie (ADR-0009 §3, B1). Discriminant EXPLICITE,
 * jamais un identifiant sentinelle (alternative ecartee #7 de l'ADR) : une action `SYSTEM`
 * (planificateur, consommateur Outbox qui execute lui-meme une commande) n'a structurellement
 * aucun `actorUserId` — voir la contrainte `CHECK` correspondante en base et l'invariant
 * equivalent dans `AuditEntry.record()`.
 *
 * `USER_PLATFORM` rend filtrables, de maniere transversale a toutes les categories, les actions
 * accomplies depuis un `ServerContext` de kind `PLATFORM` (ADR-0009 §2, "pourquoi pas de
 * categorie PLATFORM_ADMIN").
 */
export type ActorKind = 'USER_TENANT' | 'USER_PLATFORM' | 'SYSTEM';
