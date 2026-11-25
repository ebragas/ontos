import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routeSpans } from '../routeHarness.test-utils.ts';
import {
  account,
  CLIENT_ACCOUNTS,
  CLIENT_ENGAGEMENTS,
  engagement,
  errorAnswer,
  insertObjects,
  parameterResult,
  rowsOf,
  startActions,
  twinFunctions,
  type ActionsService,
  type ObjectRow,
} from './actions.test-utils.ts';
import {
  ACCOUNT,
  CLOSE_ACCOUNT_ACTION,
  CREATE_ACCOUNT,
  CREATE_ENGAGEMENT,
  ENGAGEMENT,
  EXECUTE_ALL,
  EXECUTE_NONE,
  invalidParameterValue,
  OBJECT_QUERY,
  SET_ENGAGEMENT_STATUS,
  SET_RELATIONSHIP_ACTION,
  STRUCT_PROBE,
  structConstraint,
  testIr,
} from './parametersSupport.test-utils.ts';

const functionRuns = async () => (await routeSpans()).filter((span) => span.name === 'function run').length;

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();
});

const PROBE_ACCOUNTS = [
  account('acc-2', 'Globex', 'prospect'),
  account('acc-1', 'Acme', 'customer'),
  account('acc-3', 'Initech', 'closed'),
];

const PROBE_FV = account('p-fv', 'Probe fv', 'customer');

const PROBE_ENGAGEMENTS = [
  engagement('eng-7', 'acc-2', 'Expansion', 22000, 'won', '2026-10-17T18:20:08.937Z'),
  engagement('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won', '2026-10-17T18:20:05.687Z'),
  engagement('eng-3', 'acc-1', 'Support retainer', 6000, 'open', '2026-10-17T18:20:05.991Z'),
  engagement('eng-6', 'acc-3', 'Migration', 30000, 'cancelled: churned', '2026-10-17T18:20:06.436Z'),
  engagement('eng-2', 'acc-1', 'Ontology build', 48000, 'race-c', '2026-10-17T18:20:05.839Z'),
  engagement('eng-5', 'acc-3', 'Data audit', 9000, 'won', '2026-10-17T18:20:06.284Z'),
  engagement('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
];

const engagementRow = (
  engagementId: string,
  accountId: string,
  title: string,
  amount: number,
  status: string,
  createdAt: string,
) => ({
  engagement_id: engagementId,
  account_id: accountId,
  title,
  amount,
  status,
  created_at: new Date(createdAt),
  __version: '1',
});

const CLIENT_ENGAGEMENT_ROWS = [
  engagementRow('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won', '2026-10-17T18:20:05.687Z'),
  engagementRow('eng-2', 'acc-1', 'Ontology build', 48000, 'open', '2026-10-17T18:20:05.839Z'),
  engagementRow('eng-3', 'acc-1', 'Support retainer', 6000, 'open', '2026-10-17T18:20:05.991Z'),
  engagementRow('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
  engagementRow('eng-5', 'acc-3', 'Data audit', 9000, 'won', '2026-10-17T18:20:06.284Z'),
  engagementRow('eng-6', 'acc-3', 'Migration', 30000, 'open', '2026-10-17T18:20:06.436Z'),
];

async function seedProbe(): Promise<void> {
  await insertObjects(service.db, ACCOUNT, [...PROBE_ACCOUNTS, PROBE_FV]);

  await insertObjects(service.db, ENGAGEMENT, PROBE_ENGAGEMENTS);
}

const accountRow = (accountId: string, name: string, phase: string | null) => ({
  account_id: accountId,
  name,
  phase,
  __version: '1',
});

const PROBE_ACCOUNT_ROWS = [
  accountRow('acc-1', 'Acme', 'customer'),
  accountRow('acc-2', 'Globex', 'prospect'),
  accountRow('acc-3', 'Initech', 'closed'),
  accountRow('p-fv', 'Probe fv', 'customer'),
];

const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');

const engagementIds = async () =>
  (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => row.engagement_id);

const PROBE_ENGAGEMENT_IDS = ['eng-1', 'eng-2', 'eng-3', 'eng-4', 'eng-5', 'eng-6', 'eng-7'];

const SP_F1: ObjectRow = {
  probeId: 'sp-f1',
  relationship: { label: 'before', since: '2020-01-01' },
  measures: {},
};

const seedSpF1 = () => insertObjects(service.db, STRUCT_PROBE, [SP_F1]);

describe('struct parameters', () => {
  it.each([[{ label: null, since: '2026-01-01' }], [{ label: null }]])(
    'ontology/action-types/action-types#parameters: the struct value %j with null for a required field gives 200 INVALID in both modes, and the Function does not run',
    async (relationship) => {
      await seedSpF1();

      for (const options of [{ mode: 'VALIDATE_ONLY', returnEdits: 'NONE' }, EXECUTE_ALL]) {
        const answer = await service.apply(SET_RELATIONSHIP_ACTION, {
          parameters: { probe: 'sp-f1', relationship, mode: 'full' },
          options,
        });

        expect(answer).toMatchObject({
          status: 200,
          body: {
            validation: {
              result: 'INVALID',
              parameters: {
                relationship: {
                  result: 'INVALID',
                  evaluatedConstraints: [
                    {
                      type: 'struct',
                      structFields: {
                        label: { result: 'INVALID', evaluatedConstraints: [], required: true },
                        since: { result: 'VALID', evaluatedConstraints: [], required: false },
                      },
                    },
                  ],
                  required: true,
                },
              },
            },
          },
        });
      }

      expect(await functionRuns()).toBe(0);
    },
  );
});

describe('Object reference parameters', () => {
  it('service/http-api#errors, ontology/action-types/action-types#parameters: the Object of an Object parameter of a rule-backed Action must exist: a missing Engagement gets 404 ObjectNotFound, and the Action writes nothing', async () => {
    await seedProbe();

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'p-missing', status: 'x' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'ObjectNotFound',
        parameters: { primaryKey: {} },
      },
    });

    expect(await engagementIds()).toEqual(PROBE_ENGAGEMENT_IDS);
  });

  it('service/http-api#errors: a function-backed Action does not load the Object of an Object parameter: a missing Account gets no 404, and the Function gets the primary key as its input', async () => {
    await seedProbe();

    const answer = await service.apply(CLOSE_ACCOUNT_ACTION, {
      parameters: { account: 'p-missing' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: {
          functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
          functionVersion: expect.any(String),
          message: 'Object not found',
        },
      },
    });

    expect(await functionRuns()).toBe(1);

    expect(await accounts()).toEqual(PROBE_ACCOUNT_ROWS);
  });

  it('ontology/action-types/action-types#parameters, ontology/action-types/action-types#apply: an existing Object passes, its result has the objectQueryResult constraint, and status has the default value as defaultValue', async () => {
    await seedProbe();

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-1', status: 'lost' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            objectToModifyParameter: parameterResult('VALID', true, [OBJECT_QUERY]),
            status: { ...parameterResult('VALID', false), defaultValue: 'won' },
          },
        },
      },
    });
  });
});

describe('required parameters and the validation result', () => {
  it('ontology/action-types/action-types#parameters: a function-backed Action with no value for its required Object parameter gives INVALID, and the Function does not run', async () => {
    await seedProbe();

    const answer = await service.apply(CLOSE_ACCOUNT_ACTION, {
      parameters: {},
      options: EXECUTE_NONE,
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [],
          parameters: {
            reason: parameterResult('VALID', false),
            account: parameterResult('INVALID', true, [OBJECT_QUERY]),
          },
        },
      },
    });

    expect(await functionRuns()).toBe(0);
  });

  it('ontology/action-types/action-types#apply: a function-backed Action with no value for its required struct parameter gives INVALID, with INVALID on its required field, and the Function does not run', async () => {
    await seedSpF1();

    const answer = await service.apply(SET_RELATIONSHIP_ACTION, {
      parameters: { probe: 'sp-f1', mode: 'full' },
      options: EXECUTE_ALL,
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [],
          parameters: {
            mode: parameterResult('VALID', true),
            relationship: parameterResult('INVALID', true, [
              structConstraint({
                label: parameterResult('INVALID', true),
                since: parameterResult('VALID', false),
              }),
            ]),
            probe: parameterResult('VALID', true, [OBJECT_QUERY]),
          },
        },
      },
    });

    expect(await functionRuns()).toBe(0);
  });
});

describe('VALIDATE_ONLY runs steps 1 and 2, and writes nothing', () => {
  it('ontology/action-types/action-types#apply: missing primary key gets 400 on execute, duplicate gets 409 on execute, VALIDATE_ONLY with no primary key gets 200 VALID, and Engagements keep their values', async () => {
    await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS);

    await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);

    const missingPk = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { title: 'No key' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(missingPk.status).toBe(400);

    const duplicate = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { engagementId: 'eng-1', title: 'Duplicate' },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' },
    });

    expect(duplicate.status).toBe(409);

    const validateOnly = await service.apply(CREATE_ENGAGEMENT, {
      parameters: { title: 'Validate only' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(validateOnly.status).toBe(200);
    expect((validateOnly.body as { validation: { result: string } }).validation.result).toBe('VALID');

    expect(await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });

  it('ontology/action-types/action-types#apply: a VALIDATE_ONLY apply runs step 1: a value of the wrong type gets 400, and a missing Object gets 404', async () => {
    await seedProbe();

    const badType = await service.apply(CREATE_ACCOUNT, {
      parameters: { accountId: 'p-badtype', name: 123 },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(errorAnswer(badType)).toEqual(
      invalidParameterValue({
        parameterBaseType: 'String',
        parameterId: 'name',
        parameterValue: 123,
      }),
    );

    const missing = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'p-missing', status: 'x' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(errorAnswer(missing)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'ObjectNotFound',
        parameters: { primaryKey: {} },
      },
    });

    expect(await accounts()).toEqual(PROBE_ACCOUNT_ROWS);

    expect(await engagementIds()).toEqual(PROBE_ENGAGEMENT_IDS);
  });

  it('ontology/action-types/action-types#apply, ontology/functions/functions#function-backed-actions: a VALIDATE_ONLY apply of a function-backed Action gives the validation of steps 1 and 2, runs its Function, and writes nothing', async () => {
    await seedProbe();

    const VALID = {
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            reason: parameterResult('VALID', false),
            account: parameterResult('VALID', true, [OBJECT_QUERY]),
          },
        },
      },
    };

    expect(
      await service.apply(CLOSE_ACCOUNT_ACTION, {
        parameters: { account: 'p-fv' },
        options: { mode: 'VALIDATE_ONLY' },
      }),
    ).toEqual(VALID);

    expect(await functionRuns()).toBe(1);

    expect(await accounts()).toEqual(PROBE_ACCOUNT_ROWS);
  });

  it('ontology/action-types/action-types#apply: a VALIDATE_ONLY apply of a function-backed Action with a struct parameter gives the result of each field', async () => {
    await seedSpF1();

    const answer = await service.apply(SET_RELATIONSHIP_ACTION, {
      parameters: {
        probe: 'sp-f1',
        relationship: { label: 'fn', since: '2026-02-03' },
        mode: 'full',
      },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            mode: parameterResult('VALID', true),
            relationship: parameterResult('VALID', true, [
              structConstraint({
                label: parameterResult('VALID', true),
                since: parameterResult('VALID', false),
              }),
            ]),
            probe: parameterResult('VALID', true, [OBJECT_QUERY]),
          },
        },
      },
    });
  });
});
