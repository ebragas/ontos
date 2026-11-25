import type { Client } from '@osdk/client';
import { UserFacingError } from '@osdk/functions';
import { Account } from './sdk.fixture.ts';

export default async function failWithAccount(client: Client, accountId: string, userFacing: boolean): Promise<string> {
  const account = await client(Account).fetchOne(accountId);

  const message = JSON.stringify({ name: account.name ?? null, phase: account.phase ?? null });

  throw userFacing ? new UserFacingError(message) : new Error(message);
}
