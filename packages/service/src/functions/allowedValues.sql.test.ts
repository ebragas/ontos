import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NS, rowsOf, startActions, type ActionsService } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const PHASES = ['prospect', 'customer', 'closed'];

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'setPhase',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'phase', type: 'string', allowedValues: PHASES },
    ],
    edits: [ACCOUNT],
  },
  {
    apiName: 'setPhases',
    inputs: [
      { name: 'accountId', type: 'string' },
      { name: 'phases', type: 'stringList', allowedValues: PHASES },
    ],
    edits: [ACCOUNT],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

function create(client, accountId, phase) {
  const batch = createEditBatch(client);
  batch.create(Account, { accountId, name: accountId, phase });
  return batch.getEdits();
}

export const functions = {
  setPhase: async (client, accountId, phase) => create(client, accountId, phase),
  setPhases: async (client, accountId, phases = []) => create(client, accountId, phases.join(',')),
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE);

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const ONE_OF = { type: 'oneOf', options: PHASES.map((value) => ({ value })), otherValuesAllowed: false };

function apply(apiName: string, parameters: Record<string, unknown>, options = EXECUTE) {
  return service.apply(actionOf(apiName), { parameters, options });
}

async function phases(): Promise<Record<string, string>> {
  const rows = (await rowsOf(service.db, ACCOUNT, 'account_id')) as { account_id: string; phase: string }[];

  return Object.fromEntries(rows.map((row) => [row.account_id, row.phase]));
}

describe('a Function input of string literals', () => {
  it('ontology/functions/functions#function-backed-actions: VALIDATE_ONLY and apply with a literal pass, give the oneOf constraint, and the Function runs', async () => {
    const parameters = { accountId: 'acc-good', phase: 'customer' };

    const validated = await apply('setPhase', parameters, VALIDATE_ONLY);

    expect(validated).toMatchObject({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          parameters: { phase: { result: 'VALID', evaluatedConstraints: [ONE_OF], required: true } },
        },
      },
    });

    expect(await phases()).toEqual({});

    expect(await apply('setPhase', parameters)).toMatchObject({ status: 200 });

    expect(await phases()).toEqual({ 'acc-good': 'customer' });
  });

  it('ontology/functions/functions#function-backed-actions: VALIDATE_ONLY and apply with a value outside the literals give INVALID, and the Function does not run', async () => {
    const parameters = { accountId: 'acc-bad', phase: 'Customer' };

    for (const options of [VALIDATE_ONLY, EXECUTE]) {
      expect(await apply('setPhase', parameters, options)).toMatchObject({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            parameters: { phase: { result: 'INVALID', evaluatedConstraints: [ONE_OF], required: true } },
          },
        },
      });
    }

    expect(await phases()).toEqual({});
  });

  it('ontology/functions/functions#function-backed-actions, ontology/action-types/action-types#parameters: a list input of string literals checks each element', async () => {
    expect(await apply('setPhases', { accountId: 'acc-list', phases: ['prospect', 'closed'] })).toMatchObject({
      status: 200,
    });

    expect(await apply('setPhases', { accountId: 'acc-list-bad', phases: ['prospect', 'lost'] })).toMatchObject({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          parameters: { phases: { result: 'INVALID', evaluatedConstraints: [ONE_OF], required: false } },
        },
      },
    });

    expect(await phases()).toEqual({ 'acc-list': 'prospect,closed' });
  });
});
