import type { Client } from '@osdk/client';

export default async function pickPhase(
  _client: Client,
  phase: 'customer' | 'prospect',
  tags: string[],
): Promise<string> {
  return `${phase}:${tags.length}`;
}
