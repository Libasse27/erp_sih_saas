import { describe, expect, it } from 'vitest';
import {
  FakePasswordHasher,
  FixedClock,
  InMemoryUnitOfWork,
  InMemoryUserAccountRepository,
  SequentialIdGenerator,
} from '../../../../../test/identity/builders/testKit.js';
import { Email } from '../../domain/value-objects/Email.js';
import { CreateUserAccountHandler } from './CreateUserAccount.js';

function buildHandler() {
  const repo = new InMemoryUserAccountRepository();
  const handler = new CreateUserAccountHandler(
    repo,
    new FakePasswordHasher(),
    new InMemoryUnitOfWork(),
    new FixedClock('2026-08-23T10:00:00Z'),
    new SequentialIdGenerator(),
  );
  return { repo, handler };
}

describe('CreateUserAccountHandler', () => {
  it('cree un compte avec un mot de passe hache (jamais en clair)', async () => {
    const { repo, handler } = buildHandler();

    const result = await handler.execute({
      email: 'admin@hopital.sn',
      plainPassword: 'un-mot-de-passe-suffisant',
      platformRole: 'NONE',
    });

    expect(result.isSuccess()).toBe(true);
    const saved = await repo.findByEmail(Email.create('admin@hopital.sn').getValue());
    expect(saved).not.toBeNull();
    expect(saved?.passwordHash.value).not.toBe('un-mot-de-passe-suffisant');
  });

  it('rejette un email invalide', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ email: 'pas-un-email', plainPassword: 'suffisant123', platformRole: 'NONE' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('INVALID_EMAIL');
  });

  it('rejette un mot de passe trop court', async () => {
    const { handler } = buildHandler();
    const result = await handler.execute({ email: 'a@b.sn', plainPassword: 'court', platformRole: 'NONE' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('PASSWORD_TOO_SHORT');
  });

  it('rejette un email deja enregistre', async () => {
    const { handler } = buildHandler();
    await handler.execute({ email: 'dup@hopital.sn', plainPassword: 'suffisant123', platformRole: 'NONE' });
    const result = await handler.execute({ email: 'dup@hopital.sn', plainPassword: 'suffisant456', platformRole: 'NONE' });
    expect(result.isFailure()).toBe(true);
    expect(result.getError()).toBe('EMAIL_ALREADY_REGISTERED');
  });
});
