import type { Client, Osdk } from '@osdk/client';
import { createEditBatch, type Edits, type Integer, UserFacingError } from '@osdk/functions';
import { Account, Engagement } from './sdk.ts';

type OntologyEdit = Edits.Object<Account> | Edits.Object<Engagement>;

export default async function probeVersionCheck(
  client: Client,
  account: Osdk.Instance<Account>,
  engagementId: string,
  mode: string,
  delayMs?: Integer,
): Promise<OntologyEdit[]> {
  const wait = () => new Promise((r) => setTimeout(r, delayMs ?? 2500));

  const readEngagement = async () => (await client(Engagement).where({ engagementId }).fetchPage()).data[0];

  const engagement = { $apiName: Engagement.apiName, $primaryKey: engagementId } as Osdk.Instance<Engagement>;
  const batch = createEditBatch<OntologyEdit>(client);

  switch (mode) {
    case 'read-only': {
      const e = await readEngagement();

      await wait();

      batch.update(account, { phase: `read: ${e?.status}` });

      break;
    }
    case 'param-unedited': {
      await wait();

      batch.update(engagement, { status: `param: ${account.phase}` });

      break;
    }
    case 'blind-edit': {
      await wait();

      batch.update(engagement, { status: 'blind' });

      break;
    }
    case 'read-edit': {
      const e = await readEngagement();

      await wait();

      batch.update(e ?? engagement, { status: `read-edit: ${e?.status}` });

      break;
    }
    default:
      throw new UserFacingError(`unknown mode: ${mode}`);
  }

  return batch.getEdits();
}

export const config = {
  apiName: 'probeVersionCheck',
};
