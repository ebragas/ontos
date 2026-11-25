import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '../spans/traceRoutes.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import { errorAnswer, NS, parameterResult, twinFunctions } from '../actions/actions.test-utils.ts';
import { stubActions, type StubActions } from '../actions/stubActions.test-utils.ts';
import {
  CHECK_TYPES,
  CLOSE_ACCOUNT_ACTION,
  CREATE_ACCOUNT,
  CREATE_ENGAGEMENT,
  CREATE_STRUCT_PROBE,
  EXECUTE_ALL,
  EXECUTE_NONE,
  invalidParameterValue,
  PHASE_REQUIRED,
  SET_ENGAGEMENT_STATUS,
  SET_RELATIONSHIP_ACTION,
  structConstraint,
  testIr,
} from '../actions/parametersSupport.test-utils.ts';

const functionRuns = async () => (await routeSpans()).filter((span) => span.name === 'function run');

let stub: StubActions;

beforeAll(async () => {
  stub = await stubActions(testIr(), twinFunctions('0.6.3'));
});

beforeEach(() => {
  stub.clear();
});

afterEach(() => {
  expect(stub.unexpected).toEqual([]);
});

describe('an unknown Action Type', () => {
  it('service/http-api#errors: an apply of an unknown Action Type gets 404 ActionTypeNotFound with its API name', async () => {
    const answer = await stub.apply('nope', { parameters: {}, options: {} });

    expect(errorAnswer(answer)).toEqual({
      status: 404,
      body: {
        errorCode: 'NOT_FOUND',
        errorName: 'ActionTypeNotFound',
        parameters: { actionType: 'nope' },
      },
    });
  });

  it('service/http-api#errors: an apply of a camelCase Action Type name gets 404 ActionTypeNotFound that also names the published name', async () => {
    for (const [name, parameters] of [
      [`${NS}closeAccountAction`, { actionType: `${NS}closeAccountAction`, publishedApiName: CLOSE_ACCOUNT_ACTION }],
      ['closeAccountAction', { actionType: 'closeAccountAction', publishedApiName: CLOSE_ACCOUNT_ACTION }],
      ['nopeAction', { actionType: 'nopeAction' }],
    ] as const) {
      const answer = await stub.apply(name, { parameters: {}, options: {} });

      expect(errorAnswer(answer)).toEqual({
        status: 404,
        body: { errorCode: 'NOT_FOUND', errorName: 'ActionTypeNotFound', parameters },
      });
    }
  });
});

describe('an apply body of the wrong shape', () => {
  it.each([
    ['a body that is a list', []],
    ['a body with no parameters', { options: EXECUTE_NONE }],
    ['parameters that are a list', { parameters: [], options: EXECUTE_NONE }],
    ['parameters that are null', { parameters: null, options: EXECUTE_NONE }],
    ['options that are a string', { parameters: {}, options: 'VALIDATE_ONLY' }],
    ['options that are null', { parameters: {}, options: null }],
    ['options that are a list', { parameters: {}, options: [] }],
    ['an unknown mode', { parameters: {}, options: { mode: 'EXECUTE' } }],
    ['a null mode', { parameters: {}, options: { mode: null } }],
    ['an unknown returnEdits', { parameters: {}, options: { returnEdits: 'SOME' } }],
    ['a null returnEdits', { parameters: {}, options: { returnEdits: null } }],
  ])('%s gets 400 Default:InvalidArgument with parameters {}, and the Action writes nothing', async (_case, body) => {
    const answer = await stub.apply(CREATE_ACCOUNT, body);

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'Default:InvalidArgument', parameters: {} },
    });
  });
});

describe('an unknown parameter', () => {
  it('service/http-api#errors, ontology/action-types/action-types#apply: an unknown parameter gets 400 ParametersNotFound, and the Action writes nothing', async () => {
    const answer = await stub.apply(CREATE_ACCOUNT, {
      parameters: { accountId: 'p-extra', name: 'Extra', nope: 'x' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'ParametersNotFound',
        parameters: {
          actionType: CREATE_ACCOUNT,
          unknownParameterIds: ['nope'],
          configuredParameterIds: ['accountId', 'name', 'phase'],
        },
      },
    });
  });

  it('service/http-api#errors: a function-backed Action gets the same 400 ParametersNotFound, and its Function does not run', async () => {
    const answer = await stub.apply(CLOSE_ACCOUNT_ACTION, {
      parameters: { account: 'p-fv', nope: 'x' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'ParametersNotFound',
        parameters: {
          actionType: CLOSE_ACCOUNT_ACTION,
          unknownParameterIds: ['nope'],
          configuredParameterIds: ['account', 'reason'],
        },
      },
    });

    expect(await functionRuns()).toEqual([]);
  });
});

describe('a parameter value of the wrong type', () => {
  it('service/http-api#errors, ontology/action-types/action-types#apply: a number for a String parameter gets 400 InvalidParameterValue, and the Action writes nothing', async () => {
    const answer = await stub.apply(CREATE_ACCOUNT, {
      parameters: { accountId: 'p-badtype', name: 123 },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(
      invalidParameterValue({
        parameterBaseType: 'String',
        parameterId: 'name',
        parameterValue: 123,
      }),
    );
  });

  it('service/http-api#errors, ontology/action-types/action-types#apply: a string for a Double parameter gets 400 InvalidParameterValue, and the Action writes nothing', async () => {
    const answer = await stub.apply(CREATE_ENGAGEMENT, {
      parameters: {
        engagementId: 'p-badamount',
        accountId: 'p-a',
        title: 'Bad amount',
        amount: 'abc',
      },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(
      invalidParameterValue({
        parameterBaseType: 'Double',
        parameterId: 'amount',
        parameterValue: 'abc',
      }),
    );
  });

  it('service/http-api#errors: a function-backed Action gets the same 400 InvalidParameterValue, and its Function does not run', async () => {
    const answer = await stub.apply(CLOSE_ACCOUNT_ACTION, {
      parameters: { account: 'p-fv', reason: 123 },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(
      invalidParameterValue({
        parameterBaseType: 'String',
        parameterId: 'reason',
        parameterValue: 123,
      }),
    );

    expect(await functionRuns()).toEqual([]);
  });

  const wrongTypes: [string, string, unknown, string][] = [
    ['an Integer with a fraction', 'count', 1.5, 'Integer'],
    ['an Integer as a string', 'count', '3', 'Integer'],
    ['an Integer above the 32-bit maximum', 'count', 2147483648, 'Integer'],
    ['a Boolean as a string', 'flag', 'yes', 'Boolean'],
    ['a Date that is not a date', 'due', 'not-a-date', 'LocalDate'],
    ['a Timestamp that is not a timestamp', 'at', 'not-a-timestamp', 'Timestamp'],
    ['a Timestamp with no time', 'at', '2026-10-17', 'Timestamp'],
    ['a String list with a number', 'tags', ['a', 1], 'String'],
    ['a String list that is not a list', 'tags', 'a', 'String'],
  ];

  it.each(wrongTypes)(
    'service/http-api#errors, ontology/action-types/action-types#apply: %s gets 400 InvalidParameterValue',
    async (_case, parameterId, value, baseType) => {
      const answer = await stub.apply(CHECK_TYPES, {
        parameters: {
          accountId: 'p-types',
          name: 'Types',
          [parameterId]: value,
        },
        options: EXECUTE_NONE,
      });

      expect(errorAnswer(answer)).toEqual(
        invalidParameterValue({
          parameterBaseType: baseType,
          parameterId,
          parameterValue: value,
        }),
      );
    },
  );

  it('ontology/action-types/action-types#apply: a value of the right type for each base type passes step 1', async () => {
    const valid = [
      {
        count: 3,
        flag: true,
        due: '2026-10-06',
        at: '2026-10-17T12:00:00Z',
        rate: '1299.95',
        tags: ['a', 'b'],
      },
      {
        count: -1,
        flag: false,
        due: '2024-03-01',
        at: '2025-01-01T00:00:00.123Z',
        rate: 12.5,
        tags: [],
      },
    ];

    for (const values of valid) {
      const answer = await stub.apply(CHECK_TYPES, {
        parameters: { accountId: 'p-types', name: 'Types', ...values },
        options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
      });

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ validation: { result: 'VALID' } });
    }
  });
});

describe('a Decimal parameter', () => {
  const applyRate = (rate: unknown) =>
    stub.apply(CHECK_TYPES, {
      parameters: { accountId: 'p-types', name: 'Types', rate },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

  it.each([['abc'], ['1.2.3'], [''], [true], [[1.5]]])(
    'ontology/action-types/action-types#parameters: %j is not a Decimal, and gets 400 InvalidParameterValue',
    async (rate) => {
      expect(errorAnswer(await applyRate(rate))).toEqual(
        invalidParameterValue({ parameterBaseType: 'Decimal', parameterId: 'rate', parameterValue: rate }),
      );
    },
  );

  it.each([['+1.5'], ['1.5e3'], ['1299.955']])(
    'ontology/action-types/action-types#parameters: %s passes the check of rate, which has the precision 6 and the scale 2, with no fit check',
    async (rate) => {
      const answer = await applyRate(rate);

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ validation: { result: 'VALID' } });
    },
  );
});

describe('struct parameters', () => {
  it('ontology/action-types/action-types#parameters: a struct field value with the wrong base type gets 400 InvalidParameterValue with the parameterId "<parameter>.<field>", and the Action writes nothing', async () => {
    const since = await stub.apply(CREATE_STRUCT_PROBE, {
      parameters: {
        probeId: 'sp-x1',
        relationship: { label: 'bad', since: 'not-a-date' },
      },
      options: EXECUTE_ALL,
    });

    expect(errorAnswer(since)).toEqual(
      invalidParameterValue({
        parameterBaseType: 'LocalDate',
        parameterId: 'relationship.since',
        parameterValue: 'not-a-date',
      }),
    );

    const label = await stub.apply(CREATE_STRUCT_PROBE, {
      parameters: {
        probeId: 'sp-x4',
        relationship: { label: 7, since: '2024-03-01' },
      },
      options: EXECUTE_ALL,
    });

    expect(errorAnswer(label)).toEqual(
      invalidParameterValue({
        parameterBaseType: 'String',
        parameterId: 'relationship.label',
        parameterValue: 7,
      }),
    );
  });

  const measures: [number, Record<string, unknown>, string, string, unknown][] = [
    [50, { count: 1.5 }, 'Integer', 'measures.count', 1.5],
    [51, { count: '3' }, 'Integer', 'measures.count', '3'],
    [52, { count: 2147483648 }, 'Integer', 'measures.count', 2147483648],
    [53, { flag: 'yes' }, 'Boolean', 'measures.flag', 'yes'],
    [54, { score: 'x' }, 'Double', 'measures.score', 'x'],
    [55, { at: 'not-a-timestamp' }, 'Timestamp', 'measures.at', 'not-a-timestamp'],
    [56, { at: '2026-10-17' }, 'Timestamp', 'measures.at', '2026-10-17'],
  ];

  it.each(measures)(
    'ontology/action-types/action-types#parameters: a struct field value of each other base type is checked (case %i)',
    async (line, value, baseType, parameterId, parameterValue) => {
      const answer = await stub.apply(CREATE_STRUCT_PROBE, {
        parameters: { probeId: `sp-x${line - 45}`, measures: value },
        options: EXECUTE_ALL,
      });

      expect(errorAnswer(answer)).toEqual(
        invalidParameterValue({
          parameterBaseType: baseType,
          parameterId,
          parameterValue,
        }),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a struct value with an unknown field, or a value that is not a JSON object, gets 400 InvalidParameterValue with the parameter ID, and the Action writes nothing', async () => {
    const unknownField = await stub.apply(CREATE_STRUCT_PROBE, {
      parameters: {
        probeId: 'sp-x2',
        relationship: { label: 'bad', unknown: 'x' },
      },
      options: EXECUTE_ALL,
    });

    expect(errorAnswer(unknownField)).toEqual(
      invalidParameterValue({
        parameterId: 'relationship',
        parameterValue: { label: 'bad', unknown: 'x' },
      }),
    );

    const text = await stub.apply(CREATE_STRUCT_PROBE, {
      parameters: { probeId: 'sp-x3', relationship: 'introduced' },
      options: EXECUTE_ALL,
    });

    expect(errorAnswer(text)).toEqual(
      invalidParameterValue({
        parameterId: 'relationship',
        parameterValue: 'introduced',
      }),
    );

    const list = await stub.apply(CREATE_STRUCT_PROBE, {
      parameters: { probeId: 'sp-x12', relationship: ['introduced'] },
      options: EXECUTE_ALL,
    });

    expect(errorAnswer(list)).toEqual(
      invalidParameterValue({
        parameterId: 'relationship',
        parameterValue: ['introduced'],
      }),
    );
  });

  it('ontology/action-types/action-types#apply: a struct value of a function-backed Action with no value for a required field gets 400 InvalidParameterValue, and the Function does not run', async () => {
    const answer = await stub.apply(SET_RELATIONSHIP_ACTION, {
      parameters: {
        probe: 'sp-f1',
        relationship: { since: '2026-02-03' },
        mode: 'full',
      },
      options: EXECUTE_ALL,
    });

    expect(errorAnswer(answer)).toEqual(
      invalidParameterValue({
        parameterId: 'relationship',
        parameterValue: { since: '2026-02-03' },
      }),
    );

    expect(await functionRuns()).toEqual([]);
  });
});

describe('Object reference parameters', () => {
  it('service/http-api#errors, ontology/action-types/action-types#apply: an Object parameter value that is not a String primary key gets 400 InvalidPropertyValue, and the Function does not run', async () => {
    const answer = await stub.apply(CLOSE_ACCOUNT_ACTION, {
      parameters: { account: 123 },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyValue',
        parameters: {
          propertyBaseType: 'String',
          property: 'accountId',
          propertyValue: 123,
        },
      },
    });

    expect(await functionRuns()).toEqual([]);
  });

  it('service/http-api#errors, ontology/action-types/action-types#apply: a rule-backed Action gets the same 400 InvalidPropertyValue for an Object parameter value that is not a String', async () => {
    const answer = await stub.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 123, status: 'x' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyValue',
        parameters: {
          propertyBaseType: 'String',
          property: 'engagementId',
          propertyValue: 123,
        },
      },
    });
  });
});

describe('required parameters and the validation result', () => {
  const NO_NAME = {
    status: 200,
    body: {
      validation: {
        result: 'INVALID',
        submissionCriteria: [],
        parameters: {
          phase: parameterResult('VALID', false),
          accountId: parameterResult('VALID', false),
          name: parameterResult('INVALID', true),
        },
      },
    },
  };

  it('ontology/action-types/action-types#parameters, ontology/action-types/action-types#apply: a missing required parameter gives HTTP 200 with INVALID and 1 entry for each parameter, and the Action writes nothing', async () => {
    const answer = await stub.apply(CREATE_ACCOUNT, {
      parameters: { accountId: 'p-noname' },
      options: EXECUTE_NONE,
    });

    expect(answer).toEqual(NO_NAME);
  });

  it('ontology/action-types/action-types#parameters, ontology/action-types/action-types#apply: a VALIDATE_ONLY apply with no value for a required parameter gives the same INVALID result', async () => {
    const answer = await stub.apply(CREATE_ACCOUNT, {
      parameters: { accountId: 'p-noname-v' },
      options: { mode: 'VALIDATE_ONLY' },
    });

    expect(answer).toEqual(NO_NAME);
  });

  it('ontology/action-types/action-types#parameters: the required setting of each parameter comes from the IR: required on phase makes phase required, and a missing phase gives INVALID', async () => {
    const missing = await stub.apply(PHASE_REQUIRED, {
      parameters: { accountId: 'p-a', name: 'Probe phase a' },
      options: EXECUTE_NONE,
    });

    expect(missing).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [],
          parameters: {
            phase: parameterResult('INVALID', true),
            accountId: parameterResult('VALID', false),
            name: parameterResult('VALID', true),
          },
        },
      },
    });

    const sent = await stub.apply(PHASE_REQUIRED, {
      parameters: { accountId: 'p-a', name: 'Probe phase a', phase: 'a' },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(sent).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            phase: parameterResult('VALID', true),
            accountId: parameterResult('VALID', false),
            name: parameterResult('VALID', true),
          },
        },
      },
    });
  });

  it('ontology/action-types/action-types#apply: a struct parameter gives the result of each field in its struct constraint', async () => {
    const answer = await stub.apply(CREATE_STRUCT_PROBE, {
      parameters: {
        probeId: 'sp-v',
        relationship: { label: 'introduced', since: '2024-03-01' },
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
            measures: parameterResult('VALID', false, [
              structConstraint({
                score: parameterResult('VALID', false),
                flag: parameterResult('VALID', false),
                at: parameterResult('VALID', false),
                count: parameterResult('VALID', false),
              }),
            ]),
            probeId: parameterResult('VALID', false),
            relationship: parameterResult('VALID', false, [
              structConstraint({
                label: parameterResult('VALID', false),
                since: parameterResult('VALID', false),
              }),
            ]),
          },
        },
      },
    });
  });
});
