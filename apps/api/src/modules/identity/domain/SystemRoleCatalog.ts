/**
 * Catalogue des 18 roles systeme (01-target-architecture.md §7.2, §30 du cahier des charges).
 *
 * !!! CHOIX CONSERVATEUR A FAIRE VALIDER PAR L'ARCHITECTE !!!
 * Le §30 du cahier des charges (qui nomme et definit precisement les 18 roles et leurs
 * permissions) n'est pas present dans ce depot au moment de cette implementation. Cette liste
 * est une construction deliberement conservatrice, deduite des seuls personas et ressources
 * deja nommes ailleurs dans la documentation d'architecture acceptee (§1 vue de contexte, §6.8
 * financier, §6.9 RH, §17-19 medico-technique, §22 caisse, §23 comptabilite, §29 tableaux de
 * bord). Le NOMBRE de roles (18) et la structure (catalogue global immuable, format de
 * permission `<ressource>:<action>`) sont des decisions actees ; les CODES et les JEUX DE
 * PERMISSIONS precis de chaque role sont un point sous-specifie, traite ici au plus
 * restrictif possible (permissions minimales par role) plutot que devine largement.
 * Ne pas considerer ce catalogue comme final tant que le §30 n'a pas ete confronte a cette
 * liste.
 */

export interface SystemRoleDefinition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly permissionCodes: readonly string[];
}

export const SYSTEM_ROLE_CATALOG: readonly SystemRoleDefinition[] = [
  {
    id: '90a7c461-180c-4d95-8ffc-dd5152fab68b',
    code: 'SUPER_ADMIN',
    name: 'Super administrateur plateforme',
    // Documente a titre de catalogue uniquement : un SUPER_ADMIN n'est jamais rattache via un
    // UserTenantMembership/MembershipRole (voir UserAccount.ts, PlatformRole.ts) — son MFA est
    // structurel (MfaPolicy.requiresMfaForPlatformContext), independant de ce jeu de permissions.
    permissionCodes: [
      'tenant:administer',
      'subscription:administer',
      'plan:administer',
      'plan-price:administer',
      'platform-invoice:read',
      'saas-payment:administer',
      'discount-coupon:administer',
      'platform-audit:read',
      'user-account:administer',
    ],
  },
  {
    id: 'cec566a2-c514-4a4a-bf32-b248848b419c',
    code: 'ADMIN_ETABLISSEMENT',
    name: "Administrateur d'etablissement",
    // 'mfa:reset' ajoute a l'etape 7/13 (ADR-0005) : execution technique de la procedure de
    // recuperation MFA pour un membre de l'etablissement (O-04, residu 3 — la verification
    // d'identite elle-meme reste un processus humain, hors code). Inclus dans
    // TENANT_ADMIN_RESOURCES (voir MfaPolicy.ts) : le detenteur est lui-meme soumis au MFA.
    permissionCodes: ['membership:administer', 'role:administer', 'tenant-config:administer', 'mfa:reset'],
  },
  {
    id: '82d35b51-5aff-4a89-9455-fc1dfb4228c0',
    code: 'MEDECIN',
    name: 'Medecin',
    permissionCodes: [
      'patient:read',
      'patient:write',
      'encounter:read',
      'encounter:write',
      'prescription:write',
      'prescription:sign',
      'medical-record:read',
      'medical-record:write',
      'lab-order:create',
      'imaging-order:create',
    ],
  },
  {
    id: '153ed9b8-d2e6-403a-8000-deb757e0662e',
    code: 'INFIRMIER',
    name: 'Infirmier',
    permissionCodes: [
      'patient:read',
      'encounter:read',
      'vital-signs:write',
      'medication-administration:write',
      'inpatient-stay:read',
    ],
  },
  {
    id: 'c963e77c-14c6-4f9a-905d-65b05bc2c351',
    code: 'SAGE_FEMME',
    name: 'Sage-femme',
    permissionCodes: ['patient:read', 'encounter:write', 'pregnancy:write', 'delivery:write', 'newborn:write'],
  },
  {
    id: 'a3425804-cc3c-49e6-8e6f-43398e8264f1',
    code: 'PHARMACIEN',
    name: 'Pharmacien',
    permissionCodes: ['medication:read', 'stock-item:read', 'dispensation:read', 'dispensation:write'],
  },
  {
    id: '5e1e3709-31fa-4211-8c91-760bcae877eb',
    code: 'BIOLOGISTE',
    name: 'Biologiste',
    permissionCodes: ['lab-order:read', 'specimen:write', 'analysis:write', 'lab-result:validate'],
  },
  {
    id: '6508ad22-caf5-4498-b0b8-9092feac7084',
    code: 'RADIOLOGUE',
    name: 'Radiologue',
    permissionCodes: ['imaging-order:read', 'imaging-study:write', 'imaging-study:validate'],
  },
  {
    id: '38b98eec-6712-4545-a85d-cfa5978e6ca6',
    code: 'TECHNICIEN_LABORATOIRE',
    name: 'Technicien de laboratoire',
    permissionCodes: ['lab-order:read', 'specimen:write', 'analysis:write'],
  },
  {
    id: 'e9adf342-45b0-40be-8324-1c0cf8fc84da',
    code: 'TECHNICIEN_IMAGERIE',
    name: "Technicien d'imagerie",
    permissionCodes: ['imaging-order:read', 'imaging-study:write'],
  },
  {
    id: '1d312e5f-972f-4ccd-84db-bc7d8b6cc744',
    code: 'ACCUEIL',
    name: 'Agent d’accueil',
    permissionCodes: ['patient:read', 'patient:write', 'appointment:read', 'appointment:write'],
  },
  {
    id: '1a45e68f-be74-4ed9-813c-02cad2da588e',
    code: 'CAISSIER',
    name: 'Caissier',
    permissionCodes: ['cash-register:open', 'payment:record', 'cash-register:close'],
  },
  {
    id: 'a5bcc865-4466-4cd8-bfc0-7fa8ff618e0d',
    code: 'COMPTABLE',
    name: 'Comptable',
    permissionCodes: ['journal-entry:write', 'journal-entry:validate', 'account:read', 'financial-statement:read'],
  },
  {
    id: 'ab937be7-6276-4de6-9fbf-ae7250f22668',
    code: 'RESPONSABLE_FACTURATION',
    name: 'Responsable facturation',
    permissionCodes: ['invoice:read', 'invoice:write', 'invoice:cancel'],
  },
  {
    id: '92ff10b1-5479-4680-831a-7d012e581426',
    code: 'RESPONSABLE_ASSURANCE',
    name: 'Responsable assurance',
    permissionCodes: ['insurance-coverage:read', 'insurance-coverage:write', 'claim:submit'],
  },
  {
    id: 'b6c7341c-0609-4e5f-ae3b-3408335dc848',
    code: 'RESPONSABLE_RH',
    name: 'Responsable ressources humaines',
    permissionCodes: ['staff-member:write', 'contract:write', 'leave:approve', 'work-schedule:write'],
  },
  {
    id: 'f57bd366-5338-447a-9dfe-4e8b9dc5a225',
    code: 'RESPONSABLE_STOCK',
    name: 'Responsable des stocks',
    permissionCodes: ['stock-item:read', 'stock-item:write', 'purchase-order:write', 'supplier:write'],
  },
  {
    id: '7a7da265-aafe-4b24-acf6-458b43e59a9f',
    code: 'DIRECTION_ETABLISSEMENT',
    name: "Direction d'etablissement",
    permissionCodes: ['dashboard:read', 'patient:read', 'invoice:read', 'financial-statement:read', 'stock-item:read'],
  },
];

/** Catalogue global de permissions (niveau plateforme) derive des roles systeme ci-dessus. */
export const PERMISSION_CATALOG_CODES: readonly string[] = [
  ...new Set(SYSTEM_ROLE_CATALOG.flatMap((role) => role.permissionCodes)),
].sort();
