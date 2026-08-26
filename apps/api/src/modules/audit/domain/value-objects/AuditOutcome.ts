/** Issue d'une action auditee (ADR-0005 §5). `DENIED` distingue explicitement une tentative refusee AVANT toute execution (ex. contournement MFA) d'un `FAILURE` metier (ex. code TOTP invalide). */
export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';
