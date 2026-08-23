/**
 * Contexte de session serveur, revocable, stocke en Redis (infrastructure/). Structure
 * volontairement generique pour rester extensible sans reecriture vers l'etape ulterieure
 * "Sessions avancees" (expiration differenciee par categorie O-06, refresh-token rotation) —
 * cette etape n'implemente que la creation/validation/fermeture (2.4/2.5).
 */
export interface PlatformSessionContext {
  readonly sessionId: string;
  readonly kind: 'PLATFORM';
  readonly userId: string;
  readonly requiresMfa: true;
  readonly issuedAt: string;
}

export interface TenantSessionContext {
  readonly sessionId: string;
  readonly kind: 'TENANT';
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly roleCodes: readonly string[];
  readonly permissionCodes: readonly string[];
  readonly requiresMfa: boolean;
  readonly issuedAt: string;
}

export type SessionContext = PlatformSessionContext | TenantSessionContext;

/**
 * Port de stockage de session. Le changement d'etablissement (O-05) doit fermer le contexte
 * courant et en emettre un nouveau — jamais une mutation en place — ce qui se traduit ici par
 * `delete` de l'ancien `sessionId` puis `create` d'un objet entierement nouveau, ne partageant
 * aucun etat mutable avec le precedent.
 */
export interface SessionStore {
  create(session: SessionContext): Promise<void>;
  get(sessionId: string): Promise<SessionContext | null>;
  delete(sessionId: string): Promise<void>;
  /**
   * Invalide tous les contextes de session ouverts pour un membership donne (regle de
   * revocation, O-05 : "invalide les contextes de session deja ouverts pour ce membership").
   */
  deleteAllForMembership(membershipId: string): Promise<void>;
}
