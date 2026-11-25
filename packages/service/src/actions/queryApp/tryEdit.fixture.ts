import type { Client } from '@osdk/client';
import { post } from './raw.fixture.ts';

export default async function tryEdit(client: Client, ontology: string, accountId: string): Promise<string> {
  const answer = await post(client, ontology, 'actions/com.example.twin.set-account-phase/apply', {
    parameters: { accountToModify: accountId, phase: 'edited' },
  });

  return JSON.stringify(answer);
}
