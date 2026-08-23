/** Portee d'un `Role` : `SYSTEM` (catalogue global immuable, 18 roles) ou `TENANT` (personnalise). */
export const ROLE_SCOPES = ['SYSTEM', 'TENANT'] as const;

export type RoleScope = (typeof ROLE_SCOPES)[number];
