import type { Client } from '@osdk/client';

export default async function amountLeft(_client: Client, budget?: string): Promise<string | undefined> {
  return budget;
}
