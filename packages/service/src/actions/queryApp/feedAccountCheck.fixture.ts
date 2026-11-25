import type { Client, Osdk } from '@osdk/client';
import type { Account } from './sdk.fixture.ts';

export interface FeedAccountCheck {
  readonly balance: string;
  readonly limit: string;
  readonly warnings: string[];
  readonly note?: string;
}

export default async function feedAccountCheck(
  _client: Client,
  account: Osdk.Instance<Account>,
): Promise<FeedAccountCheck> {
  return {
    balance: account.cost ?? '0',
    limit: '5000.00',
    warnings: account.phase === undefined ? ['The Account has no phase.'] : [],
  };
}
