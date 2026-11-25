import type { Client } from '@osdk/client';

export default async function echo(_client: Client, text: string): Promise<string> {
  return text;
}
