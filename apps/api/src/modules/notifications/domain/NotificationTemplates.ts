import type { NotificationTemplateKind } from './value-objects/NotificationTemplateKind.js';

/**
 * Gabarits FERMES, contenu minimal (O-07.2, ADR-0007 §7) : aucun montant, aucune date, aucune
 * donnee clinique ni financiere detaillee — une "notification d'existence" uniquement.
 * Fonctions PURES, aucune donnee issue d'un payload d'evenement n'est jamais injectee ici : un
 * consommateur ne peut PAS construire un contenu arbitraire, c'est structurellement ferme, pas
 * une discipline laissee a la relecture de code.
 */

export interface RenderedEmailContent {
  readonly subject: string;
  readonly body: string;
}

export interface RenderedSmsContent {
  readonly text: string;
}

const EMAIL_TEMPLATES: Readonly<Record<NotificationTemplateKind, RenderedEmailContent>> = {
  SUBSCRIPTION_WELCOME: {
    subject: 'Bienvenue sur la plateforme SIH',
    body: "Votre abonnement a bien demarre. Connectez-vous a votre espace pour plus de details.",
  },
  SUBSCRIPTION_PLAN_CHANGED: {
    subject: 'Votre forfait a ete modifie',
    body: 'Le changement de forfait de votre etablissement a ete applique. Connectez-vous a votre espace pour plus de details.',
  },
  SUPER_ADMIN_BREAK_GLASS_REQUESTED: {
    subject: 'Demande de recuperation break-glass SUPER_ADMIN',
    body: "Une demande de recuperation break-glass a ete ouverte pour un compte SUPER_ADMIN. Connectez-vous a votre espace pour plus de details.",
  },
  SUPER_ADMIN_BREAK_GLASS_APPROVED: {
    subject: 'Recuperation break-glass SUPER_ADMIN approuvee',
    body: "Une demande de recuperation break-glass SUPER_ADMIN a ete approuvee et executee. Connectez-vous a votre espace pour plus de details.",
  },
};

const SMS_TEMPLATES: Readonly<Record<NotificationTemplateKind, RenderedSmsContent>> = {
  SUBSCRIPTION_WELCOME: { text: 'SIH : votre abonnement a demarre. Connectez-vous a votre espace pour plus de details.' },
  SUBSCRIPTION_PLAN_CHANGED: { text: 'SIH : votre forfait a ete modifie. Connectez-vous a votre espace pour plus de details.' },
  SUPER_ADMIN_BREAK_GLASS_REQUESTED: { text: 'SIH : demande de recuperation break-glass SUPER_ADMIN ouverte. Connectez-vous a votre espace pour plus de details.' },
  SUPER_ADMIN_BREAK_GLASS_APPROVED: { text: 'SIH : recuperation break-glass SUPER_ADMIN approuvee et executee. Connectez-vous a votre espace pour plus de details.' },
};

export function renderEmailContent(templateKind: NotificationTemplateKind): RenderedEmailContent {
  return EMAIL_TEMPLATES[templateKind];
}

export function renderSmsContent(templateKind: NotificationTemplateKind): RenderedSmsContent {
  return SMS_TEMPLATES[templateKind];
}
