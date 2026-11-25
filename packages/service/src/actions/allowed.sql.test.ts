import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quoteName } from '../db/index.ts';
import { tableName } from '../ontology/index.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  errorAnswer,
  NS,
  parameterResult,
  rowsOf,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
  type Answer,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CREATE_ACCOUNT = `${NS}create-account`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const staticValue = (type: string, value: unknown) => ({ type, [type]: value });

const oneOf = (values: unknown[], otherValueAllowed: boolean) => ({
  type: 'oneOf',
  oneOf: {
    type: 'oneOf',
    oneOf: {
      labelledValues: values.map((value, i) => ({ label: `Option ${i + 1}`, value })),
      otherValueAllowed: { allowed: otherValueAllowed },
    },
  },
});

const bound = (inclusive: boolean, value: unknown) => ({
  inclusive,
  value: { type: 'staticValue', staticValue: value },
});

const range = (bounds: { minimum?: unknown; maximum?: unknown }) => ({
  type: 'range',
  range: { type: 'range', range: bounds },
});

const fixed = (inclusive: boolean, value: unknown) => ({
  inclusive,
  value: { type: 'fixed', fixed: { type: 'staticValue', staticValue: value } },
});

const datetime = (bounds: { minimum?: unknown; maximum?: unknown }) => ({
  type: 'datetime',
  datetime: { type: 'datetime', datetime: bounds },
});

const text = (body: Record<string, unknown>) => ({ type: 'text', text: { type: 'text', text: body } });
const BOOLEAN = { type: 'boolean', boolean: { type: 'boolean', boolean: {} } };
const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };

const oneOfNoOther = (values: unknown[]) => ({
  type: 'oneOf',
  oneOf: { type: 'oneOf', oneOf: { labelledValues: values.map((value, i) => ({ label: `Option ${i + 1}`, value })) } },
});

const boundNoInclusive = (value: unknown) => ({ value: { type: 'staticValue', staticValue: value } });

const fixedNoInclusive = (value: unknown) => ({
  value: { type: 'fixed', fixed: { type: 'staticValue', staticValue: value } },
});

const listLength = (length: { minLength?: number; maxLength?: number }) => ({
  type: 'listLengthValidation',
  listLengthValidation: length,
});

function validationBlock(allowedValues: unknown, required: unknown): unknown {
  return {
    defaultValidation: {
      display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
      validation: { allowedValues, required },
    },
    conditionalOverrides: [],
  };
}

function withParameter(
  apiName: string,
  id: string,
  type: unknown,
  allowedValues: unknown,
  required: unknown = NOT_REQUIRED,
): ActionTypeBlock {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[CREATE_ACCOUNT]);

  if (!block) throw new Error('The twin 0.6.3 IR has no create-account.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;

  metadata.parameters[id] = unchecked({
    id,
    type,
    displayMetadata: { displayName: id, description: '', typeClasses: [] },
  });

  metadata.parameterOrdering.push(id);

  actionTypeLogic.validation.parameterValidations[id] = unchecked(validationBlock(allowedValues, required));

  return block;
}

const STRING = { type: 'string', string: {} };
const STRING_LIST = { type: 'stringList', stringList: {} };

const ONE_OF = `${NS}allowed-one-of`;
const ONE_OF_OTHER = `${NS}allowed-one-of-other`;
const ONE_OF_INTEGER = `${NS}allowed-one-of-integer`;
const RANGE_INTEGER = `${NS}allowed-range-integer`;
const RANGE_DOUBLE = `${NS}allowed-range-double`;
const RANGE_DECIMAL = `${NS}allowed-range-decimal`;
const RANGE_DECIMAL_MAX = `${NS}allowed-range-decimal-max`;
const ONE_OF_DECIMAL = `${NS}allowed-one-of-decimal`;
const RANGE_DECIMAL_NINE = `${NS}allowed-range-decimal-nine`;
const DATETIME_DATE_TIME_MIN = `${NS}allowed-datetime-date-time-min`;
const DATETIME_DATE_TIME_MAX = `${NS}allowed-datetime-date-time-max`;
const TEXT = `${NS}allowed-text`;
const TEXT_BAD_REGEX = `${NS}allowed-text-bad-regex`;
const DATETIME_DATE = `${NS}allowed-datetime-date`;
const DATETIME_TIMESTAMP = `${NS}allowed-datetime-timestamp`;
const BOOLEAN_FLAG = `${NS}allowed-boolean`;
const LIST_TAGS = `${NS}allowed-list-tags`;
const LIST_UNBOUNDED = `${NS}allowed-list-unbounded`;
const LIST_EMPTY = `${NS}allowed-list-empty`;
const LIST_OBJECTS = `${NS}allowed-list-objects`;
const LIST_ONE_OF = `${NS}allowed-list-one-of`;
const ONE_OF_NO_OTHER = `${NS}allowed-one-of-no-other`;
const RANGE_NO_INCLUSIVE = `${NS}allowed-range-no-inclusive`;
const DATETIME_NO_INCLUSIVE = `${NS}allowed-datetime-no-inclusive`;

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  const blocks: ActionTypeBlock[] = [
    withParameter(
      ONE_OF,
      'choice',
      STRING,
      oneOf([staticValue('string', 'customer'), staticValue('string', 'prospect')], false),
    ),
    withParameter(
      ONE_OF_OTHER,
      'choice',
      STRING,
      oneOf([staticValue('string', 'customer'), staticValue('string', 'prospect')], true),
    ),
    withParameter(
      ONE_OF_INTEGER,
      'count',
      { type: 'integer', integer: {} },
      oneOf([staticValue('integer', 1), staticValue('integer', 2)], false),
    ),
    withParameter(
      RANGE_INTEGER,
      'count',
      { type: 'integer', integer: {} },
      range({ minimum: bound(true, staticValue('integer', 1)), maximum: bound(false, staticValue('integer', 10)) }),
    ),
    withParameter(
      RANGE_DOUBLE,
      'score',
      { type: 'double', double: {} },
      range({ maximum: bound(true, staticValue('double', 100)) }),
    ),
    withParameter(
      RANGE_DECIMAL,
      'rate',
      { type: 'decimal', decimal: {} },
      range({ minimum: bound(false, staticValue('decimal', { decimalValue: '0.50' })) }),
    ),
    withParameter(
      RANGE_DECIMAL_MAX,
      'rate',
      { type: 'decimal', decimal: {} },
      range({ maximum: bound(true, staticValue('decimal', { decimalValue: '9007199254740992' })) }),
    ),
    withParameter(
      ONE_OF_DECIMAL,
      'rate',
      { type: 'decimal', decimal: {} },
      oneOf([staticValue('decimal', { decimalValue: '1.50' })], false),
    ),
    withParameter(
      RANGE_DECIMAL_NINE,
      'rate',
      { type: 'decimal', decimal: {} },
      range({ minimum: bound(true, staticValue('decimal', { decimalValue: '9' })) }),
    ),
    withParameter(
      DATETIME_DATE_TIME_MIN,
      'due',
      { type: 'date', date: {} },
      datetime({ minimum: fixed(true, staticValue('timestamp', '2026-01-01T00:00:00Z')) }),
    ),
    withParameter(
      DATETIME_DATE_TIME_MAX,
      'due',
      { type: 'date', date: {} },
      datetime({ maximum: fixed(false, staticValue('timestamp', '2026-01-01T00:00:00Z')) }),
    ),
    withParameter(
      TEXT,
      'code',
      STRING,
      text({ minLength: 2, maxLength: 4, regex: { regex: '[A-Z]+', failureMessage: 'Invalid input' } }),
    ),
    withParameter(
      TEXT_BAD_REGEX,
      'code',
      STRING,
      text({ regex: { regex: '(?i)abc', failureMessage: 'Invalid input' } }),
    ),
    withParameter(
      DATETIME_DATE,
      'due',
      { type: 'date', date: {} },
      datetime({
        minimum: fixed(true, staticValue('date', { dateValue: '2026-01-01' })),
        maximum: fixed(true, staticValue('date', { dateValue: '2026-12-31' })),
      }),
    ),
    withParameter(
      DATETIME_TIMESTAMP,
      'at',
      { type: 'timestamp', timestamp: {} },
      datetime({ minimum: fixed(false, staticValue('timestamp', '2026-01-01T00:00:00Z')) }),
    ),
    withParameter(BOOLEAN_FLAG, 'flag', { type: 'boolean', boolean: {} }, BOOLEAN),
    withParameter(LIST_TAGS, 'tags', STRING_LIST, text({ maxLength: 5 }), listLength({ minLength: 1, maxLength: 3 })),
    withParameter(LIST_UNBOUNDED, 'tags', STRING_LIST, text({}), listLength({})),
    withParameter(LIST_EMPTY, 'tags', STRING_LIST, text({}), listLength({ maxLength: 0 })),
    withParameter(
      LIST_OBJECTS,
      'engagements',
      { type: 'objectReferenceList', objectReferenceList: { objectTypeId: ENGAGEMENT } },
      OBJECT_QUERY,
      listLength({}),
    ),
    withParameter(
      LIST_ONE_OF,
      'counts',
      { type: 'integerList', integerList: {} },
      oneOf([staticValue('integer', 1), staticValue('integer', 2)], false),
      listLength({}),
    ),
    withParameter(
      ONE_OF_NO_OTHER,
      'choice',
      STRING,
      oneOfNoOther([staticValue('string', 'customer'), staticValue('string', 'prospect')]),
    ),
    withParameter(
      RANGE_NO_INCLUSIVE,
      'count',
      { type: 'integer', integer: {} },
      range({
        minimum: boundNoInclusive(staticValue('integer', 1)),
        maximum: boundNoInclusive(staticValue('integer', 10)),
      }),
    ),
    withParameter(
      DATETIME_NO_INCLUSIVE,
      'due',
      { type: 'date', date: {} },
      datetime({
        minimum: fixedNoInclusive(staticValue('date', { dateValue: '2026-01-01' })),
        maximum: fixedNoInclusive(staticValue('date', { dateValue: '2026-12-31' })),
      }),
    ),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

const invalid = (errorName: string, parameters: Record<string, unknown>): Answer => ({
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName, parameters },
});

const CREATE_ACCOUNT_RESULTS = {
  accountId: parameterResult('VALID', false),
  name: parameterResult('VALID', true),
  phase: parameterResult('VALID', false),
};

const validateOnly = (actionType: string, id: string, value: unknown): Promise<Answer> =>
  service.apply(actionType, {
    parameters: { accountId: 'p-allowed', name: 'Allowed', [id]: value },
    options: VALIDATE_ONLY,
  });

const validated = (id: string, result: ReturnType<typeof parameterResult>): Answer => ({
  status: 200,
  body: {
    validation: {
      result: result.result,
      submissionCriteria: [],
      parameters: { ...CREATE_ACCOUNT_RESULTS, [id]: result },
    },
  },
});

const accountIds = async () => (await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row.account_id);

describe('a value outside its allowed values (#parameters)', () => {
  it('ontology/action-types/action-types#parameters: a VALIDATE_AND_EXECUTE apply with a value outside the allowed values gives HTTP 200 with INVALID, and the Action writes nothing', async () => {
    const answer = await service.apply(ONE_OF, {
      parameters: { accountId: 'p-outside', name: 'Outside', choice: 'closed' },
      options: EXECUTE_NONE,
    });

    expect(answer).toEqual(
      validated(
        'choice',
        parameterResult('INVALID', false, [
          { type: 'oneOf', options: [{ value: 'customer' }, { value: 'prospect' }], otherValuesAllowed: false },
        ]),
      ),
    );

    expect(await accountIds()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a VALIDATE_AND_EXECUTE apply with a value inside the allowed values writes its Object', async () => {
    const answer = await service.apply(ONE_OF, {
      parameters: { accountId: 'p-inside', name: 'Inside', choice: 'customer' },
      options: EXECUTE_NONE,
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(/^ri\.actions\.main\.action\./),
        validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
      },
    });

    expect(await accountIds()).toEqual(['p-inside']);
  });

  it('ontology/action-types/action-types#parameters: a parameter with no value is not checked against its allowed values', async () => {
    const answer = await service.apply(TEXT, {
      parameters: { accountId: 'p-none', name: 'None' },
      options: VALIDATE_ONLY,
    });

    expect(answer).toEqual(
      validated(
        'code',
        parameterResult('VALID', false, [
          { type: 'stringLength', gte: 2, lte: 4 },
          { type: 'stringRegexMatch', regex: '[A-Z]+' },
        ]),
      ),
    );
  });
});

describe('oneOf (#parameters)', () => {
  const ONE_OF_CONSTRAINT = {
    type: 'oneOf',
    options: [{ value: 'customer' }, { value: 'prospect' }],
    otherValuesAllowed: false,
  };

  it('ontology/action-types/action-types#parameters: a value from the list passes, and the result gives the oneOf constraint', async () => {
    expect(await validateOnly(ONE_OF, 'choice', 'prospect')).toEqual(
      validated('choice', parameterResult('VALID', false, [ONE_OF_CONSTRAINT])),
    );
  });

  it('ontology/action-types/action-types#parameters: a value that is not in the list gives INVALID', async () => {
    expect(await validateOnly(ONE_OF, 'choice', 'Customer')).toEqual(
      validated('choice', parameterResult('INVALID', false, [ONE_OF_CONSTRAINT])),
    );
  });

  it('ontology/action-types/action-types#parameters: with otherValueAllowed, a value that is not in the list passes', async () => {
    expect(await validateOnly(ONE_OF_OTHER, 'choice', 'closed')).toEqual(
      validated('choice', parameterResult('VALID', false, [{ ...ONE_OF_CONSTRAINT, otherValuesAllowed: true }])),
    );
  });

  it('ontology/action-types/action-types#parameters: an Integer list of values checks each value of another base type', async () => {
    const constraint = { type: 'oneOf', options: [{ value: 1 }, { value: 2 }], otherValuesAllowed: false };

    expect(await validateOnly(ONE_OF_INTEGER, 'count', 2)).toEqual(
      validated('count', parameterResult('VALID', false, [constraint])),
    );

    expect(await validateOnly(ONE_OF_INTEGER, 'count', 3)).toEqual(
      validated('count', parameterResult('INVALID', false, [constraint])),
    );
  });
});

describe('range (#parameters)', () => {
  const INTEGER_RANGE = { type: 'range', gte: 1, lt: 10 };

  it.each([
    ['the inclusive minimum', 1, 'VALID'],
    ['a value between the bounds', 9, 'VALID'],
    ['a value below the minimum', 0, 'INVALID'],
    ['the exclusive maximum', 10, 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: an Integer range: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(RANGE_INTEGER, 'count', value)).toEqual(
        validated('count', parameterResult(result, false, [INTEGER_RANGE])),
      );
    },
  );

  it.each([
    ['the inclusive maximum', 100, 'VALID'],
    ['a value above the maximum', 100.5, 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a Double range with only a maximum: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(RANGE_DOUBLE, 'score', value)).toEqual(
        validated('score', parameterResult(result, false, [{ type: 'range', lte: 100 }])),
      );
    },
  );

  it.each([
    ['a string above the minimum', '0.51', 'VALID'],
    ['a number above the minimum', 0.75, 'VALID'],
    ['the exclusive minimum', '0.50', 'INVALID'],
    ['the exclusive minimum with another scale', '0.5', 'INVALID'],
    ['a value below the minimum', '0.10', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a Decimal range with only a minimum: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(RANGE_DECIMAL, 'rate', value)).toEqual(
        validated('rate', parameterResult(result, false, [{ type: 'range', gt: '0.5' }])),
      );
    },
  );
});

describe('the exact compare of a Decimal (#parameters)', () => {
  const MAX_RANGE = { type: 'range', lte: '9007199254740992' };
  const ONE_OF_150 = { type: 'oneOf', options: [{ value: '1.5' }], otherValuesAllowed: false };

  const execute = (actionType: string, accountId: string, value: unknown): Promise<Answer> =>
    service.apply(actionType, { parameters: { accountId, name: 'Exact', rate: value }, options: EXECUTE_NONE });

  const executed = {
    status: 200,
    body: {
      operationId: expect.stringMatching(/^ri\.actions\.main\.action\./),
      validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
    },
  };

  it.each([
    ['the maximum', '9007199254740992', 'VALID'],
    ['1 more than the maximum, which a double cannot tell from it', '9007199254740993', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a VALIDATE_ONLY apply of a Decimal range with the maximum 2^53: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(RANGE_DECIMAL_MAX, 'rate', value)).toEqual(
        validated('rate', parameterResult(result, false, [MAX_RANGE])),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a VALIDATE_AND_EXECUTE apply of a Decimal range with the maximum 2^53 gives INVALID for 9007199254740993 and writes nothing, and writes for 9007199254740992', async () => {
    expect(await execute(RANGE_DECIMAL_MAX, 'p-above', '9007199254740993')).toEqual(
      validated('rate', parameterResult('INVALID', false, [MAX_RANGE])),
    );

    expect(await accountIds()).toEqual([]);

    expect(await execute(RANGE_DECIMAL_MAX, 'p-at', '9007199254740992')).toEqual(executed);

    expect(await accountIds()).toEqual(['p-at']);
  });

  it.each([
    ['the string 1.5', '1.5', 'VALID'],
    ['the number 1.5', 1.5, 'VALID'],
    ['the option text', '1.50', 'VALID'],
    ['text with a + and an exponent', '+1.5e0', 'VALID'],
    ['another value', '1.51', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a VALIDATE_ONLY apply of a Decimal oneOf with the option 1.50: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(ONE_OF_DECIMAL, 'rate', value)).toEqual(
        validated('rate', parameterResult(result, false, [ONE_OF_150])),
      );
    },
  );

  it.each([
    ['10, whose text sorts before 9', '10', 'VALID'],
    ['8.5', '8.5', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a Decimal range with the minimum 9 compares by value, not by text: %s gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(RANGE_DECIMAL_NINE, 'rate', value)).toEqual(
        validated('rate', parameterResult(result, false, [{ type: 'range', gte: '9' }])),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a VALIDATE_AND_EXECUTE apply of a Decimal oneOf with the option 1.50 writes for the number 1.5, and gives INVALID for 1.51 and writes nothing', async () => {
    expect(await execute(ONE_OF_DECIMAL, 'p-other', '1.51')).toEqual(
      validated('rate', parameterResult('INVALID', false, [ONE_OF_150])),
    );

    expect(await accountIds()).toEqual([]);

    expect(await execute(ONE_OF_DECIMAL, 'p-number', 1.5)).toEqual(executed);

    expect(await accountIds()).toEqual(['p-number']);
  });
});

describe('text (#parameters)', () => {
  const TEXT_CONSTRAINTS = [
    { type: 'stringLength', gte: 2, lte: 4 },
    { type: 'stringRegexMatch', regex: '[A-Z]+' },
  ];

  it.each([
    ['a string with the minimum length', 'AB', 'VALID'],
    ['a string with the maximum length', 'ABCD', 'VALID'],
    ['a string below the minimum length', 'A', 'INVALID'],
    ['a string above the maximum length', 'ABCDE', 'INVALID'],
    ['a string that does not match the regex', 'ab', 'INVALID'],
    ['a string that matches the regex only in part', 'aBC', 'INVALID'],
  ] as const)('ontology/action-types/action-types#parameters: %s (%j) gives %s', async (_case, value, result) => {
    expect(await validateOnly(TEXT, 'code', value)).toEqual(
      validated('code', parameterResult(result, false, TEXT_CONSTRAINTS)),
    );
  });

  it('ontology/action-types/action-types#parameters: a regex that does not compile matches no value, so the value is INVALID', async () => {
    const constraints = [{ type: 'stringRegexMatch', regex: '(?i)abc' }];

    expect(await validateOnly(TEXT_BAD_REGEX, 'code', 'abc')).toEqual(
      validated('code', parameterResult('INVALID', false, constraints)),
    );
  });
});

describe('datetime (#parameters)', () => {
  const DATE_RANGE = { type: 'range', gte: '2026-01-01', lte: '2026-12-31' };

  it.each([
    ['the inclusive minimum', '2026-01-01', 'VALID'],
    ['the inclusive maximum', '2026-12-31', 'VALID'],
    ['a day before the minimum', '2025-12-31', 'INVALID'],
    ['a day after the maximum', '2027-01-01', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a Date between 2 bounds: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(DATETIME_DATE, 'due', value)).toEqual(
        validated('due', parameterResult(result, false, [DATE_RANGE])),
      );
    },
  );

  it.each([
    ['a time after the minimum', '2026-01-01T00:00:01Z', 'VALID'],
    ['a time after the minimum in another zone', '2026-01-01T01:00:00+00:30', 'VALID'],
    ['the exclusive minimum', '2026-01-01T00:00:00Z', 'INVALID'],
    ['the exclusive minimum in another zone', '2026-01-01T02:00:00+02:00', 'INVALID'],
    ['a time before the minimum', '2025-12-31T23:59:59Z', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a Timestamp with only a minimum: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(DATETIME_TIMESTAMP, 'at', value)).toEqual(
        validated('at', parameterResult(result, false, [{ type: 'range', gt: '2026-01-01T00:00:00Z' }])),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a Date at the inclusive Timestamp minimum of its day start is VALID', async () => {
    expect(await validateOnly(DATETIME_DATE_TIME_MIN, 'due', '2026-01-01')).toEqual(
      validated('due', parameterResult('VALID', false, [{ type: 'range', gte: '2026-01-01T00:00:00Z' }])),
    );
  });

  it('ontology/action-types/action-types#parameters: a Date at the exclusive Timestamp maximum of its day start is INVALID', async () => {
    expect(await validateOnly(DATETIME_DATE_TIME_MAX, 'due', '2026-01-01')).toEqual(
      validated('due', parameterResult('INVALID', false, [{ type: 'range', lt: '2026-01-01T00:00:00Z' }])),
    );
  });
});

describe('boolean (#parameters)', () => {
  it.each([true, false])(
    'ontology/action-types/action-types#parameters: %s passes, with no constraint',
    async (value) => {
      expect(await validateOnly(BOOLEAN_FLAG, 'flag', value)).toEqual(
        validated('flag', parameterResult('VALID', false)),
      );
    },
  );

  it('ontology/action-types/action-types#parameters, ontology/action-types/action-types#apply: a value other than true or false gets 400 InvalidParameterValue', async () => {
    const answer = await validateOnly(BOOLEAN_FLAG, 'flag', 'yes');

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidParameterValue',
        parameters: { parameterBaseType: 'Boolean', parameterId: 'flag', parameterValue: 'yes' },
      },
    });
  });
});

describe('struct (#parameters)', () => {
  it("ontology/action-types/action-types#parameters: a struct value with the parameter's fields passes, with the result of each field", async () => {
    const answer = await service.apply(CREATE_STRUCT_PROBE, {
      parameters: { probeId: 'sp-v', relationship: { label: 'introduced', since: '2024-03-01' } },
      options: VALIDATE_ONLY,
    });

    const field = parameterResult('VALID', false);

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            measures: parameterResult('VALID', false, [
              { type: 'struct', structFields: { score: field, flag: field, at: field, count: field } },
            ]),
            probeId: parameterResult('VALID', false),
            relationship: parameterResult('VALID', false, [
              { type: 'struct', structFields: { label: field, since: field } },
            ]),
          },
        },
      },
    });
  });

  it('ontology/action-types/action-types#parameters: a struct value with a field that the parameter does not have gets 400 InvalidParameterValue', async () => {
    const answer = await service.apply(CREATE_STRUCT_PROBE, {
      parameters: { probeId: 'sp-x2', relationship: { label: 'bad', unknown: 'x' } },
      options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidParameterValue',
        parameters: { parameterId: 'relationship', parameterValue: { label: 'bad', unknown: 'x' } },
      },
    });
  });
});

describe('each element of a list parameter (#parameters)', () => {
  const TAGS_CONSTRAINTS = [
    { type: 'arraySize', gte: 1, lte: 3 },
    { type: 'stringLength', lte: 5 },
  ];

  it('ontology/action-types/action-types#parameters: a list whose elements each fit the allowed values passes', async () => {
    expect(await validateOnly(LIST_TAGS, 'tags', ['vip', 'new'])).toEqual(
      validated('tags', parameterResult('VALID', true, TAGS_CONSTRAINTS)),
    );
  });

  it('ontology/action-types/action-types#parameters: a list with 1 element outside the allowed values gives INVALID', async () => {
    expect(await validateOnly(LIST_TAGS, 'tags', ['vip', 'too-long'])).toEqual(
      validated('tags', parameterResult('INVALID', true, TAGS_CONSTRAINTS)),
    );
  });

  it('ontology/action-types/action-types#parameters: a null element gets 400 InvalidParameterValue in both modes, not a result of the allowed values', async () => {
    for (const options of [VALIDATE_ONLY, EXECUTE_ALL_V2]) {
      const answer = await service.apply(LIST_TAGS, {
        parameters: { accountId: 'p-allowed', name: 'Allowed', tags: ['vip', null] },
        options,
      });

      expect(errorAnswer(answer)).toEqual(
        invalid('InvalidParameterValue', {
          parameterBaseType: 'String',
          parameterId: 'tags',
          parameterValue: ['vip', null],
        }),
      );
    }

    expect(await accountIds()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: each element of an Integer list is checked against the oneOf values, and the list with allowed values keeps only its oneOf constraint', async () => {
    const constraints = [{ type: 'oneOf', options: [{ value: 1 }, { value: 2 }], otherValuesAllowed: false }];

    expect(await validateOnly(LIST_ONE_OF, 'counts', [1, 2, 1])).toEqual(
      validated('counts', parameterResult('VALID', false, constraints)),
    );

    expect(await validateOnly(LIST_ONE_OF, 'counts', [1, 3])).toEqual(
      validated('counts', parameterResult('INVALID', false, constraints)),
    );
  });
});

describe('list lengths (#parameters)', () => {
  const TAGS_CONSTRAINTS = [
    { type: 'arraySize', gte: 1, lte: 3 },
    { type: 'stringLength', lte: 5 },
  ];

  it.each([
    ['1 element, the minimum length', ['a'], 'VALID'],
    ['3 elements, the maximum length', ['a', 'b', 'c'], 'VALID'],
    ['no element, below the minimum length', [], 'INVALID'],
    ['4 elements, above the maximum length', ['a', 'b', 'c', 'd'], 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a list parameter can set a minimum and a maximum length: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(LIST_TAGS, 'tags', value)).toEqual(
        validated('tags', parameterResult(result, true, TAGS_CONSTRAINTS)),
      );
    },
  );

  it.each([
    ['no element', [], 'VALID'],
    ['1 element', ['a'], 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a list parameter with the maximum length 0 takes only an empty list: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(LIST_EMPTY, 'tags', value)).toEqual(
        validated('tags', parameterResult(result, false, [{ type: 'arraySize', lte: 0 }])),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a VALIDATE_AND_EXECUTE apply with a list above its maximum length gives INVALID, and the Action writes nothing', async () => {
    const answer = await service.apply(LIST_TAGS, {
      parameters: { accountId: 'p-long', name: 'Long', tags: ['a', 'b', 'c', 'd'] },
      options: EXECUTE_NONE,
    });

    expect(answer).toEqual(validated('tags', parameterResult('INVALID', true, TAGS_CONSTRAINTS)));

    expect(await accountIds()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a list parameter with a minimum length of 1 is required, and no value gives INVALID', async () => {
    const answer = await service.apply(LIST_TAGS, {
      parameters: { accountId: 'p-tags', name: 'Tags' },
      options: EXECUTE_NONE,
    });

    expect(answer).toEqual(validated('tags', parameterResult('INVALID', true, TAGS_CONSTRAINTS)));

    expect(await accountIds()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a list parameter with a list length that has no minimum is not required, and no value passes with a bare arraySize', async () => {
    const answer = await service.apply(LIST_UNBOUNDED, {
      parameters: { accountId: 'p-untagged', name: 'Untagged' },
      options: VALIDATE_ONLY,
    });

    expect(answer).toEqual(validated('tags', parameterResult('VALID', false, [{ type: 'arraySize' }])));
  });

  it('ontology/action-types/action-types#parameters: a list parameter of a base type holds at most 10,000 values', async () => {
    const values = (count: number) => Array.from({ length: count }, (_, i) => `t${i}`);

    expect(await validateOnly(LIST_UNBOUNDED, 'tags', values(10_000))).toEqual(
      validated('tags', parameterResult('VALID', false, [{ type: 'arraySize' }])),
    );

    expect(await validateOnly(LIST_UNBOUNDED, 'tags', values(10_001))).toEqual(
      validated('tags', parameterResult('INVALID', false, [{ type: 'arraySize', lte: 10_000 }])),
    );
  });

  it('ontology/action-types/action-types#parameters: a list parameter of Objects holds at most 1,000 Objects', async () => {
    await service.db.query(
      sql(
        `INSERT INTO ontology_1_objects.${quoteName(tableName(ENGAGEMENT))} (engagement_id, account_id, title, amount, status, created_at) ` +
          "SELECT 'eng-' || n, 'acc-1', 'Bulk', 1000, 'open', '2026-10-17T18:20:05.687Z' FROM generate_series(1, 1001) AS n",
      ),
    );

    const keys = (count: number) => Array.from({ length: count }, (_, i) => `eng-${i + 1}`);

    expect(await validateOnly(LIST_OBJECTS, 'engagements', keys(1000))).toEqual(
      validated('engagements', parameterResult('VALID', false, [{ type: 'objectQueryResult' }, { type: 'arraySize' }])),
    );

    expect(await validateOnly(LIST_OBJECTS, 'engagements', keys(1001))).toEqual(
      validated(
        'engagements',
        parameterResult('INVALID', false, [{ type: 'arraySize', lte: 1000 }, { type: 'objectQueryResult' }]),
      ),
    );
  });

  it('service/http-api#errors: an Object list element with U+0000 gets 400 InvalidPropertyValue', async () => {
    const answer = await validateOnly(LIST_OBJECTS, 'engagements', ['eng-1', 'a\u0000b']);

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyValue',
        parameters: { propertyBaseType: 'String', property: 'engagementId', propertyValue: 'a\u0000b' },
      },
    });
  });
});

describe('the arraySize form of a list within its limit (#parameters)', () => {
  it.each([
    ['no value', undefined],
    ['[]', []],
    ['2 values', ['a', 'b']],
  ])(
    'ontology/action-types/action-types#parameters: a String list with no list length and no allowed values gets a bare arraySize: %s',
    async (_case, value) => {
      expect(await validateOnly(LIST_UNBOUNDED, 'tags', value)).toEqual(
        validated('tags', parameterResult('VALID', false, [{ type: 'arraySize' }])),
      );
    },
  );

  it.each([
    ['no value', undefined],
    ['[]', []],
  ])(
    'ontology/action-types/action-types#parameters: an Object list with no list length gets a bare arraySize after objectQueryResult: %s',
    async (_case, value) => {
      expect(await validateOnly(LIST_OBJECTS, 'engagements', value)).toEqual(
        validated(
          'engagements',
          parameterResult('VALID', false, [{ type: 'objectQueryResult' }, { type: 'arraySize' }]),
        ),
      );
    },
  );

  it('ontology/action-types/action-types#parameters: a list with a list length keeps its arraySize with its bounds first, and a list with allowed values keeps only its own constraint', async () => {
    expect(await validateOnly(LIST_TAGS, 'tags', ['a'])).toEqual(
      validated(
        'tags',
        parameterResult('VALID', true, [
          { type: 'arraySize', gte: 1, lte: 3 },
          { type: 'stringLength', lte: 5 },
        ]),
      ),
    );

    expect(await validateOnly(LIST_ONE_OF, 'counts', [1])).toEqual(
      validated(
        'counts',
        parameterResult('VALID', false, [
          { type: 'oneOf', options: [{ value: 1 }, { value: 2 }], otherValuesAllowed: false },
        ]),
      ),
    );
  });
});

describe('the list rules of an Object list of a rule-backed Action', () => {
  const ENGAGEMENT_TYPE = `OntologyObject<${ENGAGEMENT}>`;

  async function expectRefused(engagements: unknown, expected: Answer): Promise<void> {
    for (const options of [VALIDATE_ONLY, EXECUTE_ALL_V2]) {
      const answer = await service.apply(LIST_OBJECTS, {
        parameters: { accountId: 'p-refs', name: 'Refs', engagements },
        options,
      });

      expect(errorAnswer(answer)).toEqual(expected);
    }

    expect(await accountIds()).toEqual([]);
  }

  it('ontology/action-types/action-types#parameters, service/http-api#errors: null for an Object list gets 400 ApplyActionFailed in both modes, and the Action writes nothing', async () => {
    await expectRefused(
      null,
      invalid('ApplyActionFailed', {
        originalErrorName: 'Ontos:SingletonValueForListParameter',
        userErrorMessage: 'The Action could not apply because of an invalid list parameter.',
        builderErrorMessage: 'A list parameter received a single value instead of a list.',
      }),
    );
  });

  it('ontology/action-types/action-types#parameters: a null element gets 400 InvalidParameterValue with the Object base type and the whole list', async () => {
    await expectRefused(
      [null],
      invalid('InvalidParameterValue', {
        parameterBaseType: ENGAGEMENT_TYPE,
        parameterId: 'engagements',
        parameterValue: [null],
      }),
    );
  });

  it('ontology/action-types/action-types#parameters: an element that is not a String gets 400 InvalidPropertyValue of the primary key', async () => {
    await expectRefused(
      [1],
      invalid('InvalidPropertyValue', { propertyBaseType: 'String', property: 'engagementId', propertyValue: 1 }),
    );
  });

  it('ontology/action-types/action-types#parameters: a value that is not a list gets 400 InvalidParameterValue with the Object base type and the value', async () => {
    await expectRefused(
      'eng-1',
      invalid('InvalidParameterValue', {
        parameterBaseType: ENGAGEMENT_TYPE,
        parameterId: 'engagements',
        parameterValue: 'eng-1',
      }),
    );
  });
});

describe('the defaults of allowed values that the IR leaves out', () => {
  it.each([
    ['a value from the list', 'customer', 'VALID'],
    ['a value that is not in the list', 'closed', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a oneOf with no otherValueAllowed allows no other value: %s (%j) gives %s',
    async (_case, value, result) => {
      const constraint = {
        type: 'oneOf',
        options: [{ value: 'customer' }, { value: 'prospect' }],
        otherValuesAllowed: false,
      };

      expect(await validateOnly(ONE_OF_NO_OTHER, 'choice', value)).toEqual(
        validated('choice', parameterResult(result, false, [constraint])),
      );
    },
  );

  it.each([
    ['the minimum', 1, 'VALID'],
    ['the maximum', 10, 'VALID'],
    ['a value below the minimum', 0, 'INVALID'],
    ['a value above the maximum', 11, 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a range bound with no inclusive is inclusive: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(RANGE_NO_INCLUSIVE, 'count', value)).toEqual(
        validated('count', parameterResult(result, false, [{ type: 'range', gte: 1, lte: 10 }])),
      );
    },
  );

  it.each([
    ['the minimum', '2026-01-01', 'VALID'],
    ['the maximum', '2026-12-31', 'VALID'],
    ['a day before the minimum', '2025-12-31', 'INVALID'],
    ['a day after the maximum', '2027-01-01', 'INVALID'],
  ] as const)(
    'ontology/action-types/action-types#parameters: a date bound with no inclusive is inclusive: %s (%j) gives %s',
    async (_case, value, result) => {
      expect(await validateOnly(DATETIME_NO_INCLUSIVE, 'due', value)).toEqual(
        validated('due', parameterResult(result, false, [{ type: 'range', gte: '2026-01-01', lte: '2026-12-31' }])),
      );
    },
  );
});
