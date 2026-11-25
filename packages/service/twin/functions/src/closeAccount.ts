import type { Client, Osdk } from '@osdk/client';
import { createEditBatch, type Edits, UserFacingError } from '@osdk/functions';
import { Account, Engagement } from './sdk.ts';

type OntologyEdit = Edits.Object<Account> | Edits.Object<Engagement>;

const loadedAt = new Date().toISOString();

export default async function closeAccount(
  client: Client,
  account: Osdk.Instance<Account>,
  reason?: string,
): Promise<OntologyEdit[]> {
  if (reason === 'test-throw') throw new Error('test plain error');

  if (reason === 'test-throw-user') throw new UserFacingError('test user-facing error');

  if (reason === 'test-refuse')
    throw Object.assign(new UserFacingError('reason test-refuse is refused'), { parameterId: 'reason' });

  const batch = createEditBatch<OntologyEdit>(client);

  batch.update(account, { phase: 'closed' });

  const open = await client(Engagement).where({ accountId: account.accountId, status: 'open' }).fetchPage();

  for (const e of open.data) batch.update(e, { status: reason ? `cancelled: ${reason}` : 'cancelled' });

  console.log(
    `[function closeAccount] module loaded at ${loadedAt}; ${open.data.length} open Engagements; env keys: ${Object.keys(process.env).length}`,
  );

  return batch.getEdits();
}

export const config = {
  apiName: 'closeAccount',
};
