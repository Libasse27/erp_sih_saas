/**
 * Contexte de session serveur, revocable, stocke en Redis (infrastructure/). Structure
 * volontairement generique pour rester extensible sans reecriture vers l'etape ulterieure
 * "Sessions avancees" (expiration differenciee par categorie O-06, refresh-token rotation) —
 * cette etape n'implemente que la creation/validation/fermeture (2.4/2.5).
 *
 * `mfaSatisfiedAt` ajoute a l'etape 7/13 (ADR-0005 §4) : horodatage ISO de la DERNIERE
 * verification reussie du second facteur pour CETTE session precise (jamais heritee d'une
 * session precedente, voir ADR-0005 §4 dernier paragraphe : un changement de contexte
 * "redemande systematiquement le second facteur"). `null` quand le MFA n'a jamais ete requis
 * pour ouvrir cette session (branche "false, non" de la table de decision) ou quand une session
 * `PLATFORM` vient d'etre emise sans challenge (ne devrait pas arriver, `requiresMfa` y est
 * toujours `true`, mais le type reste honnete : l'emission initiale precede toujours le
 * challenge).
 */
/**
 * `sensitivityCategory`/`absoluteExpiresAt` ajoutes a l'etape 8/13 (ADR-0006 §2/§5,
 * O-06.1/O-06.2) : `sensitivityCategory` est calcule UNE FOIS par
 * `SessionContextIssuer.buildSession` (seule fabrique de `SessionContext`) et transporte tel
 * quel — `RedisSessionStore` le lit pour calculer sa TTL differenciee sans jamais avoir a
 * re-resoudre de roles ni importer `MfaPolicy`. `absoluteExpiresAt` (ISO) porte le plafond
 * absolu REEL de la CHAINE (pas de la session individuelle) : fixe a la creation de la chaine et
 * COPIE TEL QUEL a chaque renouvellement (`SessionContextIssuer.issueForRefresh`) — jamais
 * recalcule depuis "maintenant", sinon la fenetre glissante repousserait indefiniment le plafond
 * qu'elle est censee respecter (meme invariant que `RefreshToken.absoluteExpiresAt`, ADR-0006
 * §5). `RedisSessionStore` s'en sert pour plafonner sa TTL — sans cela, la DERNIERE session
 * emise avant l'atteinte du plafond resterait exploitable en Redis jusqu'a une fenetre COMPLETE
 * supplementaire, en violation directe d'O-06.1 ("jamais depasser, quelle que soit l'activite").
 */
export interface PlatformSessionContext {
  readonly sessionId: string;
  readonly kind: 'PLATFORM';
  readonly userId: string;
  readonly requiresMfa: true;
  readonly mfaSatisfiedAt: string | null;
  readonly issuedAt: string;
  readonly sensitivityCategory: 'PLATFORM_SUPER_ADMIN';
  readonly absoluteExpiresAt: string;
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
  readonly mfaSatisfiedAt: string | null;
  readonly issuedAt: string;
  readonly sensitivityCategory: 'TENANT_MFA_REQUIRED' | 'TENANT_STANDARD';
  readonly absoluteExpiresAt: string;
}

/**
 * Troisieme variante de l'union (ADR-0005 §4) : porte l'utilisateur et l'INTENTION deja validee
 * serveur, mais NI `permissionCodes`, NI `roleCodes` exploitables, NI `membershipId`. Le blocage
 * n'est donc pas une verification qu'un developpeur pourrait oublier : il est STRUCTUREL — il
 * n'existe aucune permission a fuir dans cet objet. `auditRoleCodes` n'est PAS un moyen
 * d'autorisation (jamais lu par `ServerContextResolver`) : il sert uniquement a enrichir les
 * entrees `AuditEntry` d'un contournement tente (ADR-0005 §4/§6), sans reintroduire de
 * `permissionCodes` exploitable.
 */
export interface MfaPendingSessionContext {
  readonly sessionId: string;
  readonly kind: 'MFA_PENDING';
  readonly userId: string;
  readonly intent: { readonly kind: 'PLATFORM' } | { readonly kind: 'TENANT'; readonly tenantId: string };
  readonly reason: 'CHALLENGE_REQUIRED' | 'ENROLLMENT_REQUIRED';
  readonly auditRoleCodes: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type SessionContext = PlatformSessionContext | TenantSessionContext | MfaPendingSessionContext;

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
  /**
   * Invalide TOUS les contextes de session ouverts pour un utilisateur donne, tous tenants et
   * contextes confondus (ADR-0005, `ForceMfaReEnrollment` : un ré-enrolement force doit couper
   * immediatement tout acces deja ouvert avec l'ancien facteur, symetrique de
   * `deleteAllForMembership` mais a l'echelle de l'utilisateur entier plutot que d'un seul
   * membership).
   */
  deleteAllForUser(userId: string): Promise<void>;
}
