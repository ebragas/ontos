import type { Client, Osdk } from '@osdk/client';
import { Account } from './sdk.fixture.ts';

export default async function classificationSuggestion(
  client: Client,
  accountId: string,
): Promise<Osdk.Instance<Account>> {
  return client(Account).fetchOne(accountId);
}
