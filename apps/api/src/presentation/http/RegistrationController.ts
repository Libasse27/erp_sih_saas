import type { Request, Response } from 'express';
import type { CreateUserAccountHandler } from '../../modules/identity/application/commands/CreateUserAccount.js';
import type { CreateHealthFacilityHandler } from '../../modules/tenant/application/commands/CreateHealthFacility.js';
import { RegistrationBodySchema } from './RegistrationSchema.js';

export interface RegistrationControllerLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * `POST /api/v1/registrations` (ADR-0010 §2/§3). Vit HORS de `modules/` (§1 de l'ADR, derive de
 * 01-target-architecture.md §5 : "composition-root.ts est le SEUL point du code autorise a
 * connaitre deux modules a la fois") — reçoit les DEUX handlers en dependances de constructeur,
 * jamais les modules entiers (moindre privilege). Instancie UNIQUEMENT dans
 * `composition-root.ts`, exposee via `CompositionRoot.presentation`.
 *
 * Non authentifiee : aucun `Authorization` n'est lu, aucun `ServerContext` n'est resolu. Premier
 * endpoint HTTP non authentifie CREATEUR D'ETAT DURABLE du depot (ADR-0010 §Contexte 5) : le
 * tenant cree n'est supprimable par AUCUN mecanisme du depot (O-03.1).
 *
 * Sequence EXACTEMENT celle sanctionnee par ADR-0008 §9 : `CreateUserAccount` PUIS
 * `CreateHealthFacility(ownerUserId)`, `ownerUserId` etant l'identifiant retourne par la PREMIERE
 * commande dans la MEME requete serveur — jamais lu depuis le corps HTTP. Aucune autre
 * orchestration : ni attente de la Saga, ni appel de `StartTrialSubscription`, ni
 * `GrantMembership`.
 */
export class RegistrationController {
  constructor(
    private readonly createUserAccount: CreateUserAccountHandler,
    private readonly createHealthFacility: CreateHealthFacilityHandler,
    private readonly logger: RegistrationControllerLogger,
  ) {}

  handle = async (req: Request, res: Response): Promise<void> => {
    const parsed = RegistrationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    // `facilityName` deja valide ICI, AVANT tout appel a CreateUserAccount (garde
    // d'ordonnancement, ADR-0010 §3) : c'est la SEULE protection possible contre le compte
    // orphelin (deux commandes, deux transactions, aucune transaction englobante possible).
    const { email, password, facilityName } = parsed.data;

    const accountResult = await this.createUserAccount.execute({
      email,
      plainPassword: password,
      // `platformRole` FIXE A 'NONE' EN DUR — jamais accepte du client (sans quoi un anonyme
      // s'auto-declarerait SUPER_ADMIN). Le schema `.strict()` rejette de toute facon tout champ
      // `platformRole` soumis dans le corps (mass-assignment, 400).
      platformRole: 'NONE',
    });
    if (accountResult.isFailure()) {
      const error = accountResult.getError();
      if (error === 'EMAIL_ALREADY_REGISTERED') {
        res.status(409).json({ error: 'email_already_registered' });
        return;
      }
      // INVALID_EMAIL / PASSWORD_TOO_SHORT sont structurellement inatteignables : le schema zod
      // ci-dessus valide deja des bornes AU MOINS AUSSI STRICTES que celles du handler (ADR-0010
      // §2/§3, duplication deliberee). Une occurrence trahirait une divergence entre ce schema et
      // le handler, jamais une entree client legitime — traitee en pathologique, jamais exposee
      // comme une erreur metier normale (meme discipline que INVALID_OWNER_USER_ID/
      // OWNER_ACCOUNT_NOT_FOUND plus bas).
      this.logger.error(
        { event: 'registration.create-user-account.pathological-error', error },
        'CreateUserAccount : erreur pathologique malgre la validation zod amont',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const { userAccountId } = accountResult.getValue();

    const facilityResult = await this.createHealthFacility.execute({
      name: facilityName,
      // `ownerUserId` EXCLUSIVEMENT issu du `CreateUserAccount` de CETTE MEME requete serveur —
      // jamais lu depuis `req.body` (ADR-0008 §9, ADR-0010 §2 : "jamais d'un champ de formulaire
      // transmis en promettant c'est moi").
      ownerUserId: userAccountId,
    });
    if (facilityResult.isFailure()) {
      // INVALID_NAME structurellement inatteignable (meme raison que ci-dessus) ;
      // INVALID_OWNER_USER_ID/OWNER_ACCOUNT_NOT_FOUND pathologiques (le compte vient d'etre cree
      // DANS CETTE MEME requete) — jamais une erreur metier exposee au client (ADR-0010 §2).
      // Le compte reste orphelin (aucune compensation par suppression, O-03.1/ADR-0008 §5,
      // §3 de l'ADR : "impasse fonctionnelle" acceptee et documentee, deblocage operationnel).
      this.logger.error(
        { event: 'registration.create-health-facility.pathological-error', error: facilityResult.getError(), userAccountId },
        'CreateHealthFacility : erreur pathologique post-creation-de-compte (compte orphelin)',
      );
      res.status(500).json({ error: 'internal_error' });
      return;
    }
    const { tenantId } = facilityResult.getValue();

    // 202 Accepted — JAMAIS 201 : le tenant existe (HealthFacility ACTIVE) mais n'est pas encore
    // ACCESSIBLE tant que StartTrialSubscription n'a pas ete rejoue par l'Outbox (ADR-0008 §3).
    // `status` est une CONSTANTE litterale, jamais une lecture d'etat de Saga (ADR-0010 §2).
    res.status(202).json({ userAccountId, tenantId, status: 'provisioning' });
  };
}
