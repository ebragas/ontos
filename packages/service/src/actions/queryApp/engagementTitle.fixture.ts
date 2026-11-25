import type { Client, Osdk } from '@osdk/client';
import type { Engagement } from './sdk.fixture.ts';

export default async function engagementTitle(_client: Client, engagement: Osdk.Instance<Engagement>): Promise<string> {
  return engagement.title ?? '';
}
