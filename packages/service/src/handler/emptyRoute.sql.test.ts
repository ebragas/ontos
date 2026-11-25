import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle, type HandleInput } from './index.ts';
import { roleUsers } from '../people.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { newDatabase, type TestDatabase } from '../publish/publish.test-utils.ts';
import { errorAnswer, type Answer } from '../service.test-utils.ts';
import { createTestIssuer, type TestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';
import { ONTOLOGY_RID, settingsOf } from '../metadata.test-utils.ts';
import { fallibleOf } from '../db/promise.test-utils.ts';

let postgres: TestPostgres;
let database: TestDatabase;
let issuer: TestIssuer;
let input: HandleInput;

beforeAll(async () => {
  const settings = settingsOf('test');

  postgres = await startPostgres();

  database = await newDatabase(postgres.url);

  issuer = await createTestIssuer(settings.auth);

  input = {
    db: fallibleOf(database.db),
    directDb: fallibleOf(database.db),
    settings,
    keys: issuer.keys,
    users: roleUsers({}),
    workos: stubPublish(),
  };
});

afterAll(async () => {
  await database?.end();

  await postgres?.stop();
});

async function get(path: string): Promise<Answer> {
  const response = await handle(
    new Request(`http://localhost/api/v2/ontologies/${ONTOLOGY_RID}/${path}`, {
      headers: { authorization: `Bearer ${await issuer.workos()}` },
    }),
    input,
  );

  const text = await response.text();

  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

describe('GET fullMetadata with no installed Ontology', () => {
  it('an RID with no installed Ontology gets 404 OntologyNotFound', async () => {
    expect(errorAnswer(await get('fullMetadata'))).toEqual({
      status: 404,
      body: { errorCode: 'NOT_FOUND', errorName: 'OntologyNotFound', parameters: { ontologyRid: ONTOLOGY_RID } },
    });
  });
});
