import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimsOf } from '../people.test-utils.ts';
import { splitGrants } from '../roles.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { NS, seedClient, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const NOSUCHTYPE = `${NS}Nosuchtype`;

const FUNCTIONS: TestFunction[] = [
  { apiName: 'readAccount', inputs: [{ name: 'accountId', type: 'string' }], edits: [ENGAGEMENT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
const Nosuchtype = { type: 'object', apiName: '${NOSUCHTYPE}' };

async function read(client, objectType, primaryKey) {
  try {
    const object = await client(objectType).fetchOne(primaryKey);
    return { name: object.name, apiName: object.$apiName };
  } catch (error) {
    // The client of @osdk/client 2.92.0 wraps the OSDK API error of the answer as the cause of its error.
    const answer = error.cause ?? error;
    return { statusCode: answer.statusCode, errorName: answer.errorName, parameters: answer.parameters };
  }
}

export const functions = {
  readAccount: async (client, accountId) => {
    const batch = createEditBatch(client);
    const fact = { account: await read(client, Account, accountId), unknown: await read(client, Nosuchtype, accountId) };
    batch.update({ $apiName: '${ENGAGEMENT}', $primaryKey: 'eng-1' }, { title: JSON.stringify(fact) });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions, splitGrants(ir));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

async function readAs(role: string): Promise<{ status: number; fact: unknown }> {
  const answer = await service.apply(
    actionOf('readAccount'),
    { parameters: { accountId: 'acc-1' }, options: EXECUTE },
    { claims: claimsOf(role) },
  );

  const rows = await service.db.query<{ title: string }>(
    sql("SELECT title FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-1'"),
  );

  return { status: answer.status, fact: JSON.parse(rows[0]?.title ?? 'null') as unknown };
}

describe('a read of a type outside the permissions of the person', () => {
  it('ontology/functions/functions#reads: the client of a caller without the permission of Account gets 404 ObjectTypeNotFound for it, as for the unknown type, and the Action still applies its edits', async () => {
    const notFound = (objectType: string) => ({
      statusCode: 404,
      errorName: 'ObjectTypeNotFound',
      parameters: { objectType },
    });

    expect(await readAs('member')).toEqual({
      status: 200,
      fact: { account: notFound(ACCOUNT), unknown: notFound(NOSUCHTYPE) },
    });
  });

  it('the client of an admin reads the Account, and gets the same 404 for the unknown type', async () => {
    expect(await readAs('admin')).toEqual({
      status: 200,
      fact: {
        account: { name: 'Acme', apiName: ACCOUNT },
        unknown: { statusCode: 404, errorName: 'ObjectTypeNotFound', parameters: { objectType: NOSUCHTYPE } },
      },
    });
  });
});
