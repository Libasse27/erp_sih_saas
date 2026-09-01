import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { UnitOfWork } from '../../../../shared-kernel/application/UnitOfWork.js';
import type { PasswordHasher } from '../../domain/ports/PasswordHasher.js';
import type { UserAccountRepository } from '../../domain/ports/UserAccountRepository.js';
import type { UserTenantMembershipRepository } from '../../domain/ports/UserTenantMembershipRepository.js';
import { Email } from '../../domain/value-objects/Email.js';
import { PasswordHash } from '../../domain/value-objects/PasswordHash.js';
import { MFA_PENDING_SESSION_WINDOW_SECONDS } from '../../domain/MfaTuning.js';
import type { SessionAuditTrail } from '../ports/SessionAuditTrail.js';
import type { MfaBypassAttemptGuard } from '../ports/MfaBypassAttemptGuard.js';

export interface AuthenticateUserCommand {
  readonly email: string;
  readonly plainPassword: string;
}

/** Erreur volontairement unique et generique — jamais de distinction "email inconnu" vs "mot de passe incorrect" (regle 2.4, anti-enumeration). */
export type AuthenticateUserError = 'INVALID_CREDENTIALS';

export interface AuthenticateUserResult {
  readonly userAccountId: string;
  readonly isSuperAdmin: boolean;
  /** Tenants dans lesquels l'utilisateur porte un membership actif — sert a l'ecran de selection (O-05). Toujours vide pour un SUPER_ADMIN. */
  readonly activeTenantIds: readonly string[];
}

/**
 * Hachage Argon2id d'une valeur fixe, sans rapport avec un compte reel. Utilise pour executer
 * une verification factice a duree comparable quand l'email n'existe pas, afin de limiter (pas
 * d'annuler completement — le reseau et le GC introduisent d'autres variances) l'enumeration
 * de comptes par mesure de temps de reponse.
 */
const DUMMY_HASH = PasswordHash.fromHash(
  '$argon2id$v=19$m=65536,p=4,t=3$GzzpuCRsZHob1qUOe8y3lg$PjK26je6AqZ5Ar4k9eLHNhRYaFHpBVQCDz75q/0U4rE',
).getValue();

/**
 * Cas d'usage 2.4 : identite verifiee (email + mot de passe), **sans** resolution de tenant —
 * cette derniere est une etape distincte (ResolveTenantContext, 2.5), le serveur seul decide
 * du contexte (01-target-architecture.md §7.1).
 *
 * ADR-0009 §2.1 — ferme la lacune constatee au §Contexte 3 (« la connexion elle-meme n'est pas
 * auditee ») :
 *   - `SESSION_LOGIN_SUCCEEDED` a chaque authentification reussie ;
 *   - `SESSION_LOGIN_FAILED` UNIQUEMENT pour un compte EXISTANT (sujet identifiable) — jamais pour
 *     un identifiant inconnu (minimisation, ADR-0005 §6 : auditer un echec sur un identifiant
 *     inconnu obligerait a stocker l'email tente). Deduplique par la MEME mecanique que les
 *     tentatives de contournement MFA (`MfaBypassAttemptGuard`, Redis `SET NX EX`), reutilisee
 *     TELLE QUELLE (jamais un second mecanisme invente), meme fenetre
 *     `MFA_PENDING_SESSION_WINDOW_SECONDS`, cle namespacee `login-failed:<userAccountId>` pour ne
 *     jamais collisionner avec la cle `sessionId` du garde-fou MFA.
 */
export class AuthenticateUserHandler {
  constructor(
    private readonly userAccountRepository: UserAccountRepository,
    private readonly membershipRepository: UserTenantMembershipRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly sessionAuditTrail: SessionAuditTrail,
    private readonly loginFailureAttemptGuard: MfaBypassAttemptGuard,
  ) {}

  async execute(
    command: AuthenticateUserCommand,
  ): Promise<Result<AuthenticateUserResult, AuthenticateUserError>> {
    const emailResult = Email.create(command.email);
    if (emailResult.isFailure()) {
      return Result.failure('INVALID_CREDENTIALS');
    }
    const email = emailResult.getValue();

    const account = await this.unitOfWork.withTransaction(() =>
      this.userAccountRepository.findByEmail(email),
    );

    if (account === null) {
      await this.passwordHasher.verify(DUMMY_HASH, command.plainPassword);
      // Identifiant INCONNU : aucune entree d'audit (ADR-0009 §2.1 — minimisation + vecteur de
      // saturation auto-infligee sur un point d'entree non authentifie, voir alternative ecartee #9).
      return Result.failure('INVALID_CREDENTIALS');
    }

    const passwordMatches = await this.passwordHasher.verify(account.passwordHash, command.plainPassword);
    if (!passwordMatches) {
      const shouldRecord = await this.loginFailureAttemptGuard.tryMark(
        `login-failed:${account.id.toString()}`,
        MFA_PENDING_SESSION_WINDOW_SECONDS,
      );
      if (shouldRecord) {
        await this.unitOfWork.withTransaction(async () => {
          await this.sessionAuditTrail.record({
            eventType: 'SESSION_LOGIN_FAILED',
            outcome: 'FAILURE',
            tenantId: null,
            actorKind: account.isSuperAdmin() ? 'USER_PLATFORM' : 'USER_TENANT',
            actorUserId: account.id.toString(),
            actorRoleCodes: [],
            subjectUserId: account.id.toString(),
            reason: null,
            sessionId: null,
            correlationId: null,
          });
        });
      }
      return Result.failure('INVALID_CREDENTIALS');
    }

    await this.unitOfWork.withTransaction(async () => {
      await this.sessionAuditTrail.record({
        eventType: 'SESSION_LOGIN_SUCCEEDED',
        outcome: 'SUCCESS',
        tenantId: null,
        actorKind: account.isSuperAdmin() ? 'USER_PLATFORM' : 'USER_TENANT',
        actorUserId: account.id.toString(),
        actorRoleCodes: [],
        subjectUserId: account.id.toString(),
        reason: null,
        sessionId: null,
        correlationId: null,
      });
    });

    if (account.isSuperAdmin()) {
      return Result.success({
        userAccountId: account.id.toString(),
        isSuperAdmin: true,
        activeTenantIds: [],
      });
    }

    const tenantIds = await this.unitOfWork.withTransaction(
      () => this.membershipRepository.listActiveTenantIdsForUser(account.id),
      { actorUserId: account.id.toString() },
    );

    return Result.success({
      userAccountId: account.id.toString(),
      isSuperAdmin: false,
      activeTenantIds: tenantIds.map((tenantId) => tenantId.toString()),
    });
  }
}
