/**
 * Principal de LECTURE du journal (ADR-0009 §7), TYPE POSSEDE PAR LE MODULE `audit` — ce module
 * n'importe JAMAIS `ServerContext` (module `identity`) : c'est `composition-root.ts`, seul point
 * du code autorise a connaitre les deux modules a la fois, qui traduit l'un vers l'autre (meme
 * regle qu'`AuditModuleBackedAuditTrail`/`TenantModuleBackedAccessChecker`).
 *
 * `PLATFORM` : autorisation derivee de `principal.kind === 'PLATFORM'` LUI-MEME (preuve du statut
 * SUPER_ADMIN, voir `SessionContextIssuer.resolveMaterials()` / `SystemRoleCatalog.ts`) — jamais
 * d'une permission testee dans une session (`platform-audit:read` n'est matérialisée dans AUCUNE
 * session, §9).
 *
 * `TENANT` : porte `roleCodes`/`permissionCodes` DEJA RESOLUS par la session — le handler de
 * lecture verifie `permissionCodes.includes('audit:read')`, jamais `platform-audit:read`.
 */
export type AuditReadPrincipal =
  | { readonly kind: 'PLATFORM'; readonly actorUserId: string }
  | {
      readonly kind: 'TENANT';
      readonly actorUserId: string;
      readonly tenantId: string;
      readonly roleCodes: readonly string[];
      readonly permissionCodes: readonly string[];
    };
