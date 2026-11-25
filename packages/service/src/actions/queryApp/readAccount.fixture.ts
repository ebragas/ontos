import type { Client } from '@osdk/client';
import { Account } from './sdk.fixture.ts';
import { answerOf } from './raw.fixture.ts';

export default async function readAccount(client: Client, accountId: string): Promise<string> {
  try {
    const account = await client(Account).fetchOne(accountId);

    return JSON.stringify({ name: account.name ?? null, phase: account.phase ?? null });
  } catch (error) {
    return JSON.stringify(answerOf(error));
  }
}
