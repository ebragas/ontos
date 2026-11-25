import type { Client, Osdk } from '@osdk/client';
import { Account } from './sdk.fixture.ts';

export interface RequiredPayment {
  readonly account: Osdk.Instance<Account>;
  readonly amount: string;
  readonly due: string;
}

export default async function requiredPayments(client: Client): Promise<RequiredPayment[]> {
  const page = await client(Account)
    .where({ accountId: { $in: ['acc-1', 'acc-2'] } })
    .fetchPage();

  return page.data
    .toSorted((a, b) => (a.accountId < b.accountId ? -1 : 1))
    .map((account) => ({ account, amount: account.cost ?? '0', due: '2026-12-01' }));
}
