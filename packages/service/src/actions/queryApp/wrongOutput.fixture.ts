import type { Client } from '@osdk/client';

export default async function wrongOutput(_client: Client, text: string): Promise<{ readonly leaked: string }> {
  return { leaked: text };
}
