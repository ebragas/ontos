import type { Client, Osdk } from '@osdk/client';
import type { Account } from './sdk.fixture.ts';

export default async function accountCount(_client: Client, accounts: Osdk.Instance<Account>[]): Promise<string> {
  return `accounts:${accounts.length}`;
}
