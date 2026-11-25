import type { Client } from '@osdk/client';
import { post } from './raw.fixture.ts';

export default async function callRun(client: Client, ontology: string): Promise<string> {
  const known = await post(client, ontology, 'queries/amountLeft/execute', { parameters: {} });

  const unknown = await post(client, ontology, 'queries/noSuchQuery/execute', { parameters: {} });

  return JSON.stringify({ known, unknown });
}
