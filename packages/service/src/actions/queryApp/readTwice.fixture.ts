import type { Client } from '@osdk/client';
import { Account } from './sdk.fixture.ts';

export const READ_TWICE_CHANNEL = 'query.sql.test.ts readTwice';

export default async function readTwice(client: Client, accountId: string): Promise<string> {
  const first = await client(Account).fetchOne(accountId);

  const channel = new BroadcastChannel(READ_TWICE_CHANNEL);

  await new Promise((resolve) => {
    channel.onmessage = resolve;

    channel.postMessage('read');
  });

  channel.close();

  const second = await client(Account).fetchOne(accountId);

  return JSON.stringify({ first: first.phase ?? null, second: second.phase ?? null });
}
