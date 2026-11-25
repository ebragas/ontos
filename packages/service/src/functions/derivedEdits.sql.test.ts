import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  errorAnswer,
  insertObjects,
  NS,
  ONTOLOGY_RID,
  rowsOf,
  startActions,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const SECTION = 'ontology/functions/functions#function-backed-actions';

const FUNCTIONS: TestFunction[] = [
  { apiName: 'rawEdits', inputs: [{ name: 'edits', type: 'string' }], edits: [ACCOUNT] },
];

const SOURCE = `export const functions = { rawEdits: async (client, edits) => JSON.parse(edits) };`;
const ir = JSON.parse(readFileSync(new URL('../../twin/ir/derived.json', import.meta.url), 'utf8')) as OntologyIr;

let service: ActionsService;

beforeAll(async () => {
  const published = await withFunctions(FUNCTIONS, SOURCE, ir);

  const discovered = published.functions.discovered.filter(
    (fn) => fn.locator.type === 'typescript' && fn.locator.typescript?.functionName === 'rawEdits',
  );

  service = await startActions(published.ir, { ...published.functions, discovered });
}, 120_000);

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await insertObjects(service.db, ACCOUNT, [{ account_id: 'acc-1', name: 'Acme', entity: 'e' }]);
});

const account = { $apiName: ACCOUNT, $primaryKey: 'acc-1' };

async function apply(returned: unknown) {
  const { status, text } = await service.call(
    'POST',
    `/api/v2/ontologies/${ONTOLOGY_RID}/actions/${actionOf('rawEdits')}/apply`,
    { parameters: { edits: JSON.stringify(returned) }, options: { mode: 'VALIDATE_AND_EXECUTE' } },
  );

  const accounts = (await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => ({
    id: row['account_id'],
    name: row['name'],
  }));

  return { body: errorAnswer({ status, body: JSON.parse(text) as unknown }), accounts };
}

describe(SECTION, () => {
  it(`${SECTION}: a Function edit of a derived property gets 400 FunctionExecutionFailed that says the Property is derived, and writes nothing`, async () => {
    const answer = await apply([
      { type: 'updateObject', obj: account, properties: { name: 'Renamed', balance: '5.00' } },
    ]);

    expect(answer.body).toMatchObject({
      status: 400,
      body: {
        errorName: 'FunctionExecutionFailed',
        parameters: {
          message: `An edit of ${ACCOUNT} names the Property balance, which is a derived property of ${ACCOUNT}. A Function cannot edit a derived property.`,
        },
      },
    });

    expect(answer.accounts).toEqual([{ id: 'acc-1', name: 'Acme' }]);
  });

  it(`${SECTION}: a Function create of an Object with a derived property gets the same refusal`, async () => {
    const answer = await apply([
      {
        type: 'createObject',
        obj: { type: 'object', apiName: ACCOUNT },
        properties: { accountId: 'acc-2', balance: '5.00' },
      },
    ]);

    expect(answer.body).toMatchObject({
      status: 400,
      body: {
        errorName: 'FunctionExecutionFailed',
        parameters: {
          message: `An edit of ${ACCOUNT} names the Property balance, which is a derived property of ${ACCOUNT}. A Function cannot edit a derived property.`,
        },
      },
    });

    expect(answer.accounts).toEqual([{ id: 'acc-1', name: 'Acme' }]);
  });

  it(`${SECTION}: a Function edit of a Property that the Object Type does not have keeps its message`, async () => {
    const answer = await apply([{ type: 'updateObject', obj: account, properties: { nmae: 'n' } }]);

    expect(answer.body).toMatchObject({
      status: 400,
      body: {
        errorName: 'FunctionExecutionFailed',
        parameters: { message: `An edit of ${ACCOUNT} names the Property nmae, which ${ACCOUNT} does not have.` },
      },
    });
  });
});
