import { Result } from '../../../../shared-kernel/domain/Result.js';
import type { SessionStore } from '../ports/SessionStore.js';

export interface CloseSessionCommand {
  readonly sessionId: string;
}

/** Fermeture explicite de session (deconnexion). Idempotent : fermer une session deja fermee ne produit pas d'erreur (regle d'idempotence des mutations, cf. system prompt §2 regle 7). */
export class CloseSessionHandler {
  constructor(private readonly sessionStore: SessionStore) {}

  async execute(command: CloseSessionCommand): Promise<Result<void, never>> {
    await this.sessionStore.delete(command.sessionId);
    return Result.success(undefined);
  }
}
