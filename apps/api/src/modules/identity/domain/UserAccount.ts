import { AggregateRoot } from '../../../shared-kernel/domain/AggregateRoot.js';
import type { Clock } from '../../../shared-kernel/domain/ports/Clock.js';
import type { IdGenerator } from '../../../shared-kernel/domain/ports/IdGenerator.js';
import { UserAccountCreated } from './events/UserAccountCreated.js';
import type { Email } from './value-objects/Email.js';
import type { PasswordHash } from './value-objects/PasswordHash.js';
import type { PlatformRole } from './value-objects/PlatformRole.js';
import { UserAccountId } from './value-objects/UserAccountId.js';

interface UserAccountProps {
  readonly email: Email;
  passwordHash: PasswordHash;
  readonly platformRole: PlatformRole;
  readonly createdAt: Date;
}

/**
 * Identite globale d'une personne (01-target-architecture.md §6.3, O-05).
 *
 * Regle non negociable : **aucun `tenantId` sur cet agregat**. C'est une donnee de niveau
 * plateforme (schema `platform`, hors RLS tenant) — indispensable pour retrouver un compte par
 * email au login, avant qu'un quelconque contexte tenant existe. Le contexte tenant actif est
 * une notion de session (voir application/ResolveTenantContext), jamais un attribut d'identite.
 *
 * Represente soit un `SUPER_ADMIN` (statut plateforme explicite, sans membership), soit un
 * utilisateur d'etablissement porteur de `0..N` `UserTenantMembership` (agregats separes,
 * lies uniquement par `userId` — jamais charges dans le meme agregat).
 */
export class UserAccount extends AggregateRoot<UserAccountId> {
  private props: UserAccountProps;

  private constructor(id: UserAccountId, props: UserAccountProps) {
    super(id);
    this.props = props;
  }

  static register(params: {
    email: Email;
    passwordHash: PasswordHash;
    platformRole: PlatformRole;
    clock: Clock;
    idGenerator: IdGenerator;
  }): UserAccount {
    const idResult = UserAccountId.create(params.idGenerator.generate());
    if (idResult.isFailure()) {
      // L'IdGenerator est cense produire un UUID v4 valide (UuidGenerator, crypto.randomUUID).
      // Une valeur invalide ici est un bug d'infrastructure, pas un echec metier attendu.
      throw new Error('IdGenerator a produit un identifiant invalide pour UserAccount.');
    }
    const id = idResult.getValue();
    const account = new UserAccount(id, {
      email: params.email,
      passwordHash: params.passwordHash,
      platformRole: params.platformRole,
      createdAt: params.clock.now(),
    });
    account.addDomainEvent(
      UserAccountCreated.create({
        userAccountId: id.toString(),
        clock: params.clock,
        idGenerator: params.idGenerator,
      }),
    );
    return account;
  }

  /** Reconstruction depuis la persistance — n'emet aucun evenement. */
  static reconstitute(id: UserAccountId, props: UserAccountProps): UserAccount {
    return new UserAccount(id, props);
  }

  get email(): Email {
    return this.props.email;
  }

  get passwordHash(): PasswordHash {
    return this.props.passwordHash;
  }

  get platformRole(): PlatformRole {
    return this.props.platformRole;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  isSuperAdmin(): boolean {
    return this.props.platformRole === 'SUPER_ADMIN';
  }
}
