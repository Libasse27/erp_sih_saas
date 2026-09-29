/**
 * Principal d'AUTORISATION pour les operations d'administration des memberships (Phase 1,
 * deuxieme increment vertical — permission `membership:administer`), TYPE POSSEDE PAR LE MODULE
 * `identity` — meme discipline qu'`AuditReadPrincipal` (module `audit`) / `TenantConfigPrincipal`
 * (module `tenant`) : ce module ne construit lui-meme ce type qu'a partir d'un `ServerContext`
 * DEJA resolu (voir `composition-root.ts`, seul point du code autorise a traduire
 * `ServerContext` vers les principaux de CHAQUE module).
 *
 * `PLATFORM` : porte UNIQUEMENT `actorUserId` — la permission `membership:administer` est
 * portee EXCLUSIVEMENT par le role systeme TENANT `ADMIN_ETABLISSEMENT` (SystemRoleCatalog.ts) ;
 * une session `PLATFORM` n'a structurellement aucun tenant sur lequel exercer cette permission.
 * Cette variante existe pour que le refus d'une session `PLATFORM` soit un branchement EXPLICITE
 * (`AuthorizeMembershipAdminister.ts`), jamais un fallthrough accidentel.
 *
 * `TENANT` : porte `permissionCodes` DEJA RESOLUS par la session (union additive des roles du
 * membership, voir `PermissionResolver.ts`) — l'autorisation verifie
 * `permissionCodes.includes('membership:administer')`, jamais un nom de role.
 */
export type MembershipAdminPrincipal =
  | { readonly kind: 'PLATFORM'; readonly actorUserId: string }
  | {
      readonly kind: 'TENANT';
      readonly actorUserId: string;
      readonly tenantId: string;
      readonly roleCodes: readonly string[];
      readonly permissionCodes: readonly string[];
    };
