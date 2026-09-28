/**
 * Principal d'AUTORISATION pour les operations de configuration du tenant (Phase 1, premier
 * increment vertical — permission `tenant-config:administer`), TYPE POSSEDE PAR LE MODULE
 * `tenant` — meme discipline qu'`AuditReadPrincipal` (module `audit`) : ce module n'importe
 * JAMAIS `ServerContext` (module `identity`), c'est `composition-root.ts`, seul point du code
 * autorise a connaitre les deux modules a la fois, qui traduit l'un vers l'autre.
 *
 * `PLATFORM` : porte UNIQUEMENT `actorUserId` — la permission `tenant-config:administer` est
 * portee EXCLUSIVEMENT par le role systeme TENANT `ADMIN_ETABLISSEMENT` (SystemRoleCatalog.ts) ;
 * une session `PLATFORM` n'a structurellement aucun tenant sur lequel exercer cette permission.
 * Cette variante existe pour que le refus d'une session `PLATFORM` soit un branchement EXPLICITE
 * (`AuthorizeTenantConfigAdminister.ts`), jamais un fallthrough accidentel.
 *
 * `TENANT` : porte `permissionCodes` DEJA RESOLUS par la session (union additive des roles du
 * membership, voir `PermissionResolver.ts`) — l'autorisation verifie
 * `permissionCodes.includes('tenant-config:administer')`, jamais un nom de role.
 */
export type TenantConfigPrincipal =
  | { readonly kind: 'PLATFORM'; readonly actorUserId: string }
  | {
      readonly kind: 'TENANT';
      readonly actorUserId: string;
      readonly tenantId: string;
      readonly roleCodes: readonly string[];
      readonly permissionCodes: readonly string[];
    };
