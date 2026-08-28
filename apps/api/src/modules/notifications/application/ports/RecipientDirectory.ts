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
}
