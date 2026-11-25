import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName } from './index.ts';
import { errorAnswer, NS, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'createNamedAccount',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'name', type: 'string' },
    ],
    edits: [ACCOUNT],
  },
];

const SOURCE = `
import { createEditBatch, UserFacingError } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

export const functions = {
  createNamedAccount: async (client, accountId, name) => {
    if (name.trim() === '') throw Object.assign(new UserFacingError('name must not be blank'), { parameterId: 'name' });
    const batch = createEditBatch(client);
    batch.create(Account, { accountId, name, phase: 'prospect' });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

function validateOnly(name: string) {
  return service.apply(actionOf('createNamedAccount'), {
    parameters: { accountId: 'acc-dry', name },
    options: { mode: 'VALIDATE_ONLY', returnEdits: 'ALL_V2_WITH_DELETIONS' },
  });
}

async function rowCounts(): Promise<Record<string, number>> {
  const tables = await service.db.query<{ name: string }>(
    sql("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'ontology_1_objects' ORDER BY tablename"),
  );

  const counts: Record<string, number> = {};

  for (const table of [
    ...tables.map(({ name }) => `ontology_1_objects.${quoteName(name)}`),
    'ontology_1_engine.edit_history',
  ]) {
    const [row] = await service.db.query<{ count: number }>(sql(`SELECT count(*)::int AS count FROM ${table}`));

    counts[table] = row?.count ?? -1;
  }

  return counts;
}

describe('a VALIDATE_ONLY apply of a function-backed Action', () => {
  it('ontology/functions/functions#function-backed-actions: a value that the Function refuses gives the Function error, and writes nothing', async () => {
    const before = await rowCounts();

    expect(errorAnswer(await validateOnly(' '))).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionEncounteredUserFacingError',
        parameters: {
          functionRid: expect.any(String),
          functionVersion: '1.0.0',
          message: 'name must not be blank',
          parameterId: 'name',
        },
      },
    });

    expect(await rowCounts()).toEqual(before);
  });

  it('ontology/functions/functions#function-backed-actions: a valid value gives VALID with no operationId and no edits, and writes no Object and no Edit History entry', async () => {
    const before = await rowCounts();

    const answer = await validateOnly('Acme');

    expect(answer).toMatchObject({ status: 200, body: { validation: { result: 'VALID' } } });
    expect(Object.keys(answer.body as object)).toEqual(['validation']);

    expect(await rowCounts()).toEqual(before);

    const executed = await service.apply(actionOf('createNamedAccount'), {
      parameters: { accountId: 'acc-dry', name: 'Acme' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(executed).toMatchObject({ status: 200 });

    expect(await rowCounts()).not.toEqual(before);
  });
});
