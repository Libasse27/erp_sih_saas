/**
 * Port sortant d'Identity vers Notifications (ADR-0007 §4) — resout les destinataires d'une
 * notification de niveau tenant. Implemente en ACL cross-module dans `composition-root.ts`
 * (meme regime que `TenantModuleBackedAccessChecker`) : Notifications ne connait que ce port,
 * jamais le domain/ d'Identity.
 *
 * Resout les emails des membres ACTIFS portant le role `ADMIN_ETABLISSEMENT` du tenant — audience
 * structurellement designee par O-04.1 (ADMIN_ETABLISSEMENT = administrateur d'etablissement),
 * jamais une politique de ciblage de notification inventee (ADR-0007 §4).
 */
export interface RecipientDirectory {
  findTenantAdminEmails(tenantId: string): Promise<readonly string[]>;

  /**
   * Resout les emails des `SUPER_ADMIN` ACTIFS de la plateforme, a l'exclusion de `excludeUserId`
   * (ADR-0005 Amendement 1, O-04 residu 4 — alerte break-glass) : l'auteur d'une action
   * (demandeur B, approbateur C) ne se notifie jamais lui-meme sa propre action. Audience
   * structurellement designee (le role plateforme `SUPER_ADMIN` lui-meme), jamais une politique de
   * ciblage inventee — meme discipline que `findTenantAdminEmails` (ADR-0007 §4).
   */
  findActiveSuperAdminEmails(excludeUserId: string): Promise<readonly string[]>;
}
