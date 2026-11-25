import type { Client, Osdk } from '@osdk/client';
import { Engagement } from './sdk.fixture.ts';

export default async function readEngagement(
  client: Client,
  engagementId: string,
): Promise<Osdk.Instance<Engagement> | undefined> {
  try {
    return await client(Engagement).fetchOne(engagementId);
  } catch {
    return undefined;
  }
}
