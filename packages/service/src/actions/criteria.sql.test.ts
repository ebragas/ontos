import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { propertyOfType, twinObjectType, unchecked } from '../ontology/stored.test-utils.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  account,
  CLIENT_ACCOUNTS,
  CLIENT_ENGAGEMENTS,
  engagement,
  errorAnswer,
  insertObjects,
  NS,
  parameterResult,
  parameterValue,
  rowsOf,
  startActions,
  staticString,
  twinFunctions,
  twinIr,
  type ActionsService,
  newVersion,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const property = (parameterId: string, propertyTypeId: string) => ({
  type: 'objectParameterPropertyValue',
  objectParameterPropertyValue: { parameterId, propertyTypeId },
});

const listLength = (parameterId: string) => ({
  type: 'parameterLength',
  parameterLength: { type: 'parameterId', parameterId },
});

const staticDouble = (value: number) => ({ type: 'staticValue', staticValue: { type: 'double', double: value } });
const staticInteger = (value: number) => ({ type: 'staticValue', staticValue: { type: 'integer', integer: value } });

const staticDecimal = (value: string) => ({
  type: 'staticValue',
  staticValue: { type: 'decimal', decimal: { decimalValue: value } },
});

const INFINITY = { type: 'staticValue', staticValue: { type: 'double', double: 'Infinity' } };

const staticStrings = (values: string[]) => ({
  type: 'staticValue',
  staticValue: { type: 'stringList', stringList: { strings: values } },
});

type Operator =
  'EQUALS' | 'NOT_EQUALS' | 'LESS_THAN' | 'LESS_THAN_EQUALS' | 'GREATER_THAN' | 'GREATER_THAN_EQUALS' | 'INTERSECTS';

const comparison = (operator: Operator, left: unknown, right: unknown) => ({
  type: 'comparison',
  comparison: { operator, left, right },
});

const regex = (value: unknown, pattern: string) => ({ type: 'regex', regex: { value, regex: pattern } });
const and = (...conditions: unknown[]) => ({ type: 'and', and: { conditions } });
const or = (...conditions: unknown[]) => ({ type: 'or', or: { conditions } });
const not = (condition: unknown) => ({ type: 'not', not: { condition } });
const TRUE = { type: 'true', true: {} };

const ORDER = [
  ['LESS_THAN', true, false, false],
  ['LESS_THAN_EQUALS', true, true, false],
  ['GREATER_THAN', false, false, true],
  ['GREATER_THAN_EQUALS', false, true, true],
] as const satisfies readonly (readonly [Operator, boolean, boolean, boolean])[];

const orderName = (value: 'status' | 'amount', operator: Operator) =>
  `${value}-${operator.toLowerCase().replaceAll('_', '-')}`;

const STATUS_IS_OPEN = comparison('EQUALS', property('engagement', 'status'), staticString('open'));
const STATUS_IS_LOST = comparison('EQUALS', property('engagement', 'status'), staticString('lost'));
const STATUS_IS_WON = comparison('EQUALS', property('engagement', 'status'), staticString('won'));

const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const REQUIRED = { type: 'required', required: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };
const RANGE = { type: 'range', range: { type: 'range', range: {} } };
const DATETIME = { type: 'datetime', datetime: { type: 'datetime', datetime: {} } };
const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };

const PARAMETERS: Record<string, { type: unknown; allowedValues: unknown; required: unknown }> = {
  engagement: {
    type: { type: 'objectReference', objectReference: { objectTypeId: ENGAGEMENT } },
    allowedValues: OBJECT_QUERY,
    required: REQUIRED,
  },
  status: { type: { type: 'string', string: {} }, allowedValues: TEXT, required: NOT_REQUIRED },
  amount: { type: { type: 'double', double: {} }, allowedValues: RANGE, required: NOT_REQUIRED },
  price: { type: { type: 'decimal', decimal: {} }, allowedValues: RANGE, required: NOT_REQUIRED },
  due: { type: { type: 'timestamp', timestamp: {} }, allowedValues: DATETIME, required: NOT_REQUIRED },
  tags: { type: { type: 'stringList', stringList: {} }, allowedValues: TEXT, required: NO_LIST_LENGTH },
};

const APPROVE = {
  type: 'modifyObjectRule',
  modifyObjectRule: {
    objectToModify: 'engagement',
    propertyValues: { status: { type: 'staticValue', staticValue: { type: 'string', string: 'approved' } } },
    structFieldValues: {},
  },
};

const REFUSED_RULES = [{ type: 'deleteObjectRule', deleteObjectRule: { objectToDelete: 'engagement' } }, APPROVE];

type TestCriterion = readonly [condition: unknown, failureMessage: string];

function actionType(
  apiName: string,
  criteria: readonly TestCriterion[],
  rules: readonly unknown[] = [APPROVE],
): ActionTypeBlock {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[SET_ENGAGEMENT_STATUS]);

  if (!block) throw new Error('The twin 0.6.3 IR has no set-engagement-status.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;
  metadata.parameters = {};
  metadata.parameterOrdering = Object.keys(PARAMETERS);

  actionTypeLogic.validation.parameterValidations = {};

  for (const [id, { type, allowedValues, required }] of Object.entries(PARAMETERS)) {
    metadata.parameters[id] = unchecked({
      id,
      type,
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    actionTypeLogic.validation.parameterValidations[id] = unchecked({
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: { allowedValues, required },
      },
      conditionalOverrides: [],
    });
  }

  actionTypeLogic.validation.actionTypeLevelValidation.rules = Object.fromEntries(
    criteria.map(([condition, failureMessage], index) => [
      String(index),
      unchecked({ condition, displayMetadata: { failureMessage, typeClasses: [] } }),
    ]),
  );

  actionTypeLogic.logic.rules = unchecked(rules);

  return block;
}

const named = (name: string) => `${NS}criteria-${name}`;

const CRITERIA: Record<string, readonly TestCriterion[]> = {
  'status-open': [[STATUS_IS_OPEN, 'The Engagement must be open.']],
  'three-criteria': [
    [STATUS_IS_LOST, 'The Engagement must be lost.'],
    [TRUE, 'This criterion always passes.'],
    [comparison('EQUALS', parameterValue('status'), staticString('closed')), 'The status parameter must be closed.'],
  ],
  equals: [[comparison('EQUALS', property('engagement', 'status'), staticString('open')), 'EQUALS failed.']],
  'not-equals': [
    [comparison('NOT_EQUALS', property('engagement', 'status'), staticString('lost')), 'NOT_EQUALS failed.'],
  ],
  'less-than': [
    [comparison('LESS_THAN', parameterValue('amount'), property('engagement', 'amount')), 'LESS_THAN failed.'],
  ],
  'less-than-equals': [
    [
      comparison('LESS_THAN_EQUALS', parameterValue('amount'), property('engagement', 'amount')),
      'LESS_THAN_EQUALS failed.',
    ],
  ],
  'greater-than': [
    [comparison('GREATER_THAN', property('engagement', 'amount'), staticDouble(20000)), 'GREATER_THAN failed.'],
  ],
  'greater-than-equals': [
    [
      comparison('GREATER_THAN_EQUALS', property('engagement', 'amount'), staticDouble(15000)),
      'GREATER_THAN_EQUALS failed.',
    ],
  ],
  intersects: [
    [comparison('INTERSECTS', parameterValue('tags'), staticStrings(['priority', 'urgent'])), 'INTERSECTS failed.'],
  ],
  'due-after-created': [
    [
      comparison('GREATER_THAN', parameterValue('due'), property('engagement', 'createdAt')),
      'The due time must be after the creation.',
    ],
  ],
  'price-above': [
    [comparison('GREATER_THAN', parameterValue('price'), staticDecimal('200')), 'The price must be more than 200.'],
  ],
  'two-tags': [[comparison('GREATER_THAN_EQUALS', listLength('tags'), staticInteger(2)), 'Give 2 tags or more.']],
  'title-regex': [[regex(property('engagement', 'title'), 'Ontology.*'), 'The title must start with Ontology.']],
  'status-regex': [
    [regex(parameterValue('status'), '[a-z]+-[0-9]+'), 'The status must be a word, a hyphen, and a number.'],
  ],
  and: [
    [
      and(STATUS_IS_OPEN, comparison('GREATER_THAN', property('engagement', 'amount'), staticDouble(20000))),
      'Only a large open Engagement.',
    ],
  ],
  or: [
    [
      or(STATUS_IS_WON, comparison('GREATER_THAN', property('engagement', 'amount'), staticDouble(40000))),
      'Only a won or very large Engagement.',
    ],
  ],
  not: [[not(STATUS_IS_LOST), 'A lost Engagement cannot change.']],
  true: [[TRUE, 'This message never shows.']],
  nested: [
    [
      not(
        or(
          and(STATUS_IS_OPEN, comparison('LESS_THAN', property('engagement', 'amount'), staticDouble(10000))),
          STATUS_IS_LOST,
        ),
      ),
      'No small open or lost Engagement.',
    ],
  ],
  'status-param-open': [
    [comparison('EQUALS', parameterValue('status'), staticString('open')), 'The status parameter must be open.'],
  ],
  'status-param-not-open': [
    [
      comparison('NOT_EQUALS', parameterValue('status'), staticString('open')),
      'The status parameter must not be open.',
    ],
  ],
  'greater-than-equals-param': [
    [
      comparison('GREATER_THAN_EQUALS', parameterValue('amount'), property('engagement', 'amount')),
      'GREATER_THAN_EQUALS failed.',
    ],
  ],
  'no-tags': [[comparison('EQUALS', listLength('tags'), staticInteger(0)), 'Give no tags.']],
  'amount-above-decimal': [
    [
      comparison('GREATER_THAN', property('engagement', 'amount'), staticDecimal('20000')),
      'The amount must be more than 20000.',
    ],
  ],
  'decimal-below-amount': [
    [
      comparison('LESS_THAN', staticDecimal('20000'), property('engagement', 'amount')),
      'The amount must be more than 20000.',
    ],
  ],
  'visited-at-due': [
    [
      comparison('INTERSECTS', property('engagement', 'visits'), parameterValue('due')),
      'The due time must be a visit.',
    ],
  ],
  'status-intersects': [
    [
      comparison('INTERSECTS', parameterValue('status'), staticStrings(['open', 'won'])),
      'The status must be open or won.',
    ],
  ],
  'price-is-static': [
    [comparison('EQUALS', parameterValue('price'), staticDecimal('1299.90')), 'The price must be 1299.90.'],
  ],
  'price-above-big': [
    [
      comparison('GREATER_THAN', parameterValue('price'), staticDecimal('9007199254740992')),
      'The price must be more than 2^53.',
    ],
  ],
  'fee-is-static': [
    [comparison('EQUALS', property('engagement', 'fee'), staticDecimal('1299.9')), 'The fee must be 1299.9.'],
  ],
  'fee-above-big': [
    [
      comparison('GREATER_THAN', property('engagement', 'fee'), staticDecimal('9007199254740992')),
      'The fee must be more than 2^53.',
    ],
  ],
  'price-above-nine': [
    [comparison('GREATER_THAN', parameterValue('price'), staticDecimal('9')), 'The price must be more than 9.'],
  ],
  'amount-is-infinity': [
    [comparison('EQUALS', property('engagement', 'amount'), INFINITY), 'The amount must be Infinity.'],
  ],
  'amount-at-most-infinity': [
    [
      comparison('LESS_THAN_EQUALS', property('engagement', 'amount'), INFINITY),
      'The amount must be at most Infinity.',
    ],
  ],
  'price-is-fee': [
    [comparison('EQUALS', parameterValue('price'), property('engagement', 'fee')), 'The price must be the fee.'],
  ],
  'price-above-fee': [
    [
      comparison('GREATER_THAN', parameterValue('price'), property('engagement', 'fee')),
      'The price must be more than the fee.',
    ],
  ],
  ...Object.fromEntries(
    ORDER.flatMap(([operator]) => [
      [
        orderName('status', operator),
        [[comparison(operator, parameterValue('status'), staticString('open')), `${operator} failed.`]],
      ],
      [
        orderName('amount', operator),
        [[comparison(operator, parameterValue('amount'), staticDouble(48000)), `${operator} failed.`]],
      ],
    ]),
  ),
};

const REFUSED = named('refused');

const PHASE_IS_CUSTOMER = comparison('EQUALS', property('account', 'phase'), staticString('customer'));

const FUNCTION_CRITERIA: Record<string, unknown> = {
  'function-phase': PHASE_IS_CUSTOMER,
  'function-and': and(TRUE, PHASE_IS_CUSTOMER),
  'function-or': or(comparison('EQUALS', staticString('a'), staticString('b')), PHASE_IS_CUSTOMER),
  'function-not': not(comparison('NOT_EQUALS', property('account', 'phase'), staticString('customer'))),
  'function-regex': regex(property('account', 'phase'), 'cust.*'),
};

function functionActionType(apiName: string, condition: unknown): ActionTypeBlock {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[CLOSE_ACCOUNT_ACTION]);

  if (!block) throw new Error('The twin 0.6.3 IR has no close-account-action.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;

  actionTypeLogic.validation.actionTypeLevelValidation.rules = {
    '0': unchecked({
      condition,
      displayMetadata: { failureMessage: 'The Account must be a customer.', typeClasses: [] },
    }),
  };

  return block;
}

function testEngagement() {
  const block = twinObjectType('Engagement');

  block.objectType.propertyTypes['visits'] = propertyOfType('visits', {
    type: 'array',
    array: { subtype: { type: 'timestamp', timestamp: {} }, reducers: [] },
  });

  block.objectType.propertyTypes['fee'] = propertyOfType('fee', {
    type: 'decimal',
    decimal: { precision: 20, scale: 2 },
  });

  return block;
}

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  ir.ontology.objectTypes[ENGAGEMENT] = testEngagement();

  const blocks = [
    ...Object.entries(CRITERIA).map(([name, criteria]) => actionType(named(name), criteria)),
    actionType(REFUSED, CRITERIA['status-open'] ?? [], REFUSED_RULES),
    ...Object.entries(FUNCTION_CRITERIA).map(([name, condition]) => functionActionType(named(name), condition)),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await insertObjects(service.db, ENGAGEMENT, CLIENT_ENGAGEMENTS);
});

async function statuses(): Promise<Record<string, [string | null, string]>> {
  const rows = await rowsOf(service.db, ENGAGEMENT, 'engagement_id');

  return Object.fromEntries(
    rows.map((row) => [row['engagement_id'] as string, [row['status'] as string | null, row['__version'] as string]]),
  );
}

const START_STATUSES = {
  'eng-1': ['won', '1'],
  'eng-2': ['open', '1'],
  'eng-3': ['open', '1'],
  'eng-4': ['lost', '1'],
  'eng-5': ['won', '1'],
  'eng-6': ['open', '1'],
};

const historyRows = () => service.db.query(sql('SELECT * FROM ontology_1_engine.edit_history'));

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY' };

async function criteriaResult(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  const answer = await service.apply(named(name), { parameters, options: VALIDATE_ONLY });

  expect(answer.status).toBe(200);

  const { result, submissionCriteria } = (answer.body as { validation: Record<string, unknown> }).validation;

  return { result, submissionCriteria };
}

const PASSES = { result: 'VALID', submissionCriteria: [] };

const fails = (...messages: string[]) => ({
  result: 'INVALID',
  submissionCriteria: messages.map((configuredFailureMessage) => ({ configuredFailureMessage, result: 'INVALID' })),
});

const parameterResults = (engagementResult: 'VALID' | 'INVALID' = 'VALID') => ({
  engagement: parameterResult(engagementResult, true, [{ type: 'objectQueryResult' }]),
  status: parameterResult('VALID', false),
  amount: parameterResult('VALID', false),
  price: parameterResult('VALID', false),
  due: parameterResult('VALID', false),
  tags: parameterResult('VALID', false, [{ type: 'arraySize' }]),
});

describe('the contract of the criteria', () => {
  it('ontology/action-types/submission-criteria#contract, ontology/action-types/action-types#apply: a criterion that fails makes the Action fail and write nothing, and the validation result gives its failure message', async () => {
    const answer = await service.apply(named('status-open'), { parameters: { engagement: 'eng-4' }, options: EXECUTE });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [{ configuredFailureMessage: 'The Engagement must be open.', result: 'INVALID' }],
          parameters: parameterResults(),
        },
      },
    });

    expect(await statuses()).toEqual(START_STATUSES);

    expect(await historyRows()).toEqual([]);
  });

  it('ontology/action-types/action-types#apply: an Action whose criteria pass runs its rules and writes', async () => {
    const answer = await service.apply(named('status-open'), { parameters: { engagement: 'eng-2' }, options: EXECUTE });

    expect(answer).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(/^ri\.actions\.main\.action\./),
        validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
      },
    });

    expect(await statuses()).toEqual({ ...START_STATUSES, 'eng-2': ['approved', newVersion('1')] });
  });

  it('ontology/action-types/submission-criteria#contract: a VALIDATE_ONLY apply gives the same INVALID result for a criterion that fails', async () => {
    const answer = await service.apply(named('status-open'), {
      parameters: { engagement: 'eng-4' },
      options: VALIDATE_ONLY,
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [{ configuredFailureMessage: 'The Engagement must be open.', result: 'INVALID' }],
          parameters: parameterResults(),
        },
      },
    });
  });

  it('ontology/action-types/submission-criteria#contract: an Action Type has a list of criteria, and the result gives the failure message of each criterion that fails, in IR order', async () => {
    expect(await criteriaResult('three-criteria', { engagement: 'eng-2', status: 'open' })).toEqual(
      fails('The Engagement must be lost.', 'The status parameter must be closed.'),
    );

    expect(await criteriaResult('three-criteria', { engagement: 'eng-4', status: 'open' })).toEqual(
      fails('The status parameter must be closed.'),
    );

    expect(await criteriaResult('three-criteria', { engagement: 'eng-4', status: 'closed' })).toEqual(PASSES);
  });

  it('ontology/action-types/submission-criteria#contract: the parameter check runs before the criteria, so a parameter value of the wrong type gets its error and not the criteria result', async () => {
    const answer = await service.apply(named('status-open'), {
      parameters: { engagement: 'eng-4', amount: 'many' },
      options: EXECUTE,
    });

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidParameterValue',
        parameters: { parameterBaseType: 'Double', parameterId: 'amount', parameterValue: 'many' },
      },
    });
  });

  it('ontology/action-types/submission-criteria#contract: a missing required parameter and a criterion that fails both show in the INVALID result', async () => {
    const answer = await service.apply(named('status-param-open'), {
      parameters: { status: 'closed' },
      options: EXECUTE,
    });

    expect(answer).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [{ configuredFailureMessage: 'The status parameter must be open.', result: 'INVALID' }],
          parameters: parameterResults('INVALID'),
        },
      },
    });
  });

  it('ontology/action-types/submission-criteria#contract: the criteria run before the rules, so a criterion that fails stops an Action whose rules the apply refuses', async () => {
    const failed = await service.apply(REFUSED, { parameters: { engagement: 'eng-4' }, options: EXECUTE });

    expect(failed).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [{ configuredFailureMessage: 'The Engagement must be open.', result: 'INVALID' }],
          parameters: parameterResults(),
        },
      },
    });

    const refused = await service.apply(REFUSED, { parameters: { engagement: 'eng-2' }, options: EXECUTE });

    expect(errorAnswer(refused)).toEqual({
      status: 400,
      body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ApplyActionFailed', parameters: {} },
    });

    expect(await statuses()).toEqual(START_STATUSES);
  });
});

describe('the conditions', () => {
  it('ontology/action-types/submission-criteria#conditions: a comparison passes when the left value and the right value meet the operator: EQUALS and NOT_EQUALS', async () => {
    expect(await criteriaResult('equals', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('equals', { engagement: 'eng-4' })).toEqual(fails('EQUALS failed.'));

    expect(await criteriaResult('equals', { engagement: 'eng-3' })).toEqual(PASSES);

    expect(await criteriaResult('equals', { engagement: 'eng-1' })).toEqual(fails('EQUALS failed.'));

    expect(await criteriaResult('not-equals', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('not-equals', { engagement: 'eng-4' })).toEqual(fails('NOT_EQUALS failed.'));
  });

  it('ontology/action-types/submission-criteria#conditions: LESS_THAN and LESS_THAN_EQUALS', async () => {
    expect(await criteriaResult('less-than', { engagement: 'eng-2', amount: 47999.5 })).toEqual(PASSES);

    expect(await criteriaResult('less-than', { engagement: 'eng-2', amount: 48000 })).toEqual(
      fails('LESS_THAN failed.'),
    );

    expect(await criteriaResult('less-than-equals', { engagement: 'eng-2', amount: 48000 })).toEqual(PASSES);

    expect(await criteriaResult('less-than-equals', { engagement: 'eng-2', amount: 48000.5 })).toEqual(
      fails('LESS_THAN_EQUALS failed.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: GREATER_THAN and GREATER_THAN_EQUALS', async () => {
    expect(await criteriaResult('greater-than', { engagement: 'eng-6' })).toEqual(PASSES);

    expect(await criteriaResult('greater-than', { engagement: 'eng-4' })).toEqual(fails('GREATER_THAN failed.'));

    expect(await criteriaResult('greater-than-equals', { engagement: 'eng-4' })).toEqual(PASSES);

    expect(await criteriaResult('greater-than-equals', { engagement: 'eng-1' })).toEqual(
      fails('GREATER_THAN_EQUALS failed.'),
    );
  });

  it.each(ORDER)(
    'ontology/action-types/submission-criteria#conditions: %s compares 2 Strings in the order of their code units',
    async (operator, below, equal, above) => {
      const cases = [
        ['opem', below],
        ['open', equal],
        ['opeo', above],
        [undefined, false],
      ] as const;

      for (const [status, meets] of cases) {
        expect(
          await criteriaResult(orderName('status', operator), { engagement: 'eng-2', status }),
          String(status),
        ).toEqual(meets ? PASSES : fails(`${operator} failed.`));
      }
    },
  );

  it.each(ORDER)(
    'ontology/action-types/submission-criteria#conditions: %s compares 2 numbers by their value',
    async (operator, below, equal, above) => {
      const cases = [
        [47999.5, below],
        [48000, equal],
        [48000.5, above],
        [undefined, false],
      ] as const;

      for (const [amount, meets] of cases) {
        expect(
          await criteriaResult(orderName('amount', operator), { engagement: 'eng-2', amount }),
          String(amount),
        ).toEqual(meets ? PASSES : fails(`${operator} failed.`));
      }
    },
  );

  it('ontology/action-types/submission-criteria#conditions: INTERSECTS passes when the 2 lists have a value in common', async () => {
    expect(await criteriaResult('intersects', { engagement: 'eng-2', tags: ['late', 'urgent'] })).toEqual(PASSES);

    expect(await criteriaResult('intersects', { engagement: 'eng-2', tags: ['late'] })).toEqual(
      fails('INTERSECTS failed.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: INTERSECTS reads a single value as a list of 1 value, and no value as an empty list', async () => {
    expect(await criteriaResult('status-intersects', { engagement: 'eng-2', status: 'won' })).toEqual(PASSES);

    expect(await criteriaResult('status-intersects', { engagement: 'eng-2', status: 'lost' })).toEqual(
      fails('The status must be open or won.'),
    );

    expect(await criteriaResult('status-intersects', { engagement: 'eng-2' })).toEqual(
      fails('The status must be open or won.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: an order operator compares 2 Timestamps by their time, not by their text', async () => {
    expect(
      await criteriaResult('due-after-created', { engagement: 'eng-2', due: '2026-10-17T20:20:06+02:00' }),
    ).toEqual(PASSES);

    expect(
      await criteriaResult('due-after-created', { engagement: 'eng-2', due: '2026-10-17T19:20:05+02:00' }),
    ).toEqual(fails('The due time must be after the creation.'));
  });

  it('ontology/action-types/submission-criteria#conditions: an order operator compares 2 Decimals by their value, not by their text', async () => {
    expect(await criteriaResult('price-above', { engagement: 'eng-2', price: '1299.95' })).toEqual(PASSES);

    expect(await criteriaResult('price-above', { engagement: 'eng-2', price: '150' })).toEqual(
      fails('The price must be more than 200.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: an order operator compares a static Decimal with a Double Property by their value', async () => {
    expect(await criteriaResult('amount-above-decimal', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('amount-above-decimal', { engagement: 'eng-4' })).toEqual(
      fails('The amount must be more than 20000.'),
    );

    expect(await criteriaResult('decimal-below-amount', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('decimal-below-amount', { engagement: 'eng-4' })).toEqual(
      fails('The amount must be more than 20000.'),
    );
  });

  describe('the exact compare of a Decimal', () => {
    const withFee = (id: string, fee: string) =>
      insertObjects(service.db, ENGAGEMENT, [{ ...engagement(id, 'acc-1', 'Fee', 1000, 'open', null), fee }]);

    it.each([
      ['the string 1299.9', '1299.9', PASSES],
      ['the number 1299.9', 1299.9, PASSES],
      ['the string 1299.91', '1299.91', fails('The price must be 1299.90.')],
    ] as const)(
      'ontology/action-types/submission-criteria#conditions: a Decimal parameter EQUALS the static Decimal 1299.90 by its exact value: %s',
      async (_case, price, result) => {
        expect(await criteriaResult('price-is-static', { engagement: 'eng-2', price })).toEqual(result);
      },
    );

    it('ontology/action-types/submission-criteria#conditions: a Decimal parameter of 9007199254740993 is GREATER_THAN the static Decimal 9007199254740992, which a double cannot tell from it', async () => {
      expect(await criteriaResult('price-above-big', { engagement: 'eng-2', price: '9007199254740993' })).toEqual(
        PASSES,
      );

      expect(await criteriaResult('price-above-big', { engagement: 'eng-2', price: '9007199254740992' })).toEqual(
        fails('The price must be more than 2^53.'),
      );
    });

    it('ontology/action-types/submission-criteria#conditions: a Decimal Property compares with a static Decimal by its exact value', async () => {
      await withFee('eng-padded', '1299.9');

      await withFee('eng-big', '9007199254740993');

      await withFee('eng-2-53', '9007199254740992');

      expect(await criteriaResult('fee-is-static', { engagement: 'eng-padded' })).toEqual(PASSES);

      expect(await criteriaResult('fee-above-big', { engagement: 'eng-big' })).toEqual(PASSES);

      expect(await criteriaResult('fee-above-big', { engagement: 'eng-2-53' })).toEqual(
        fails('The fee must be more than 2^53.'),
      );
    });

    it('ontology/action-types/submission-criteria#conditions: a Decimal parameter compares with a Decimal Property by its exact value, so 1299.9 equals the stored 1299.90', async () => {
      await withFee('eng-padded', '1299.90');

      await withFee('eng-2-53', '9007199254740992');

      expect(
        (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).find((row) => row['engagement_id'] === 'eng-padded')?.[
          'fee'
        ],
      ).toBe('1299.90');

      expect(await criteriaResult('price-is-fee', { engagement: 'eng-padded', price: '1299.9' })).toEqual(PASSES);

      expect(await criteriaResult('price-is-fee', { engagement: 'eng-padded', price: '1299.91' })).toEqual(
        fails('The price must be the fee.'),
      );

      expect(await criteriaResult('price-above-fee', { engagement: 'eng-2-53', price: '9007199254740993' })).toEqual(
        PASSES,
      );

      expect(await criteriaResult('price-above-fee', { engagement: 'eng-2-53', price: '9007199254740992' })).toEqual(
        fails('The price must be more than the fee.'),
      );
    });
  });

  it('ontology/action-types/submission-criteria#conditions: a Decimal parameter of 10 is GREATER_THAN the static Decimal 9, whose text sorts after it', async () => {
    expect(await criteriaResult('price-above-nine', { engagement: 'eng-2', price: '10' })).toEqual(PASSES);

    expect(await criteriaResult('price-above-nine', { engagement: 'eng-2', price: '8.5' })).toEqual(
      fails('The price must be more than 9.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: a Double Property with no value does not EQUALS the static Double Infinity', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      { ...engagement('eng-no-amount', 'acc-1', 'No amount', 0, 'open', null), amount: null },
    ]);

    expect(await criteriaResult('amount-is-infinity', { engagement: 'eng-no-amount' })).toEqual(
      fails('The amount must be Infinity.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: a Double Property of Infinity is LESS_THAN_EQUALS the static Double Infinity', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      engagement('eng-infinity', 'acc-1', 'Infinity', Infinity, 'open', null),
    ]);

    expect(await criteriaResult('amount-at-most-infinity', { engagement: 'eng-infinity' })).toEqual(PASSES);

    expect(await criteriaResult('amount-is-infinity', { engagement: 'eng-infinity' })).toEqual(PASSES);
  });

  it('ontology/action-types/submission-criteria#conditions: a comparison reads the elements of an array Property with the type of the elements', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      { ...engagement('eng-visited', 'acc-1', 'Site visit', 1000, 'open', null), visits: ['2026-10-17T18:20:06Z'] },
    ]);

    expect(
      await criteriaResult('visited-at-due', { engagement: 'eng-visited', due: '2026-10-17T20:20:06+02:00' }),
    ).toEqual(PASSES);

    expect(
      await criteriaResult('visited-at-due', { engagement: 'eng-visited', due: '2026-10-17T20:20:07+02:00' }),
    ).toEqual(fails('The due time must be a visit.'));
  });

  it('ontology/action-types/submission-criteria#conditions: a condition value is a parameter, a static value, a Property of an Object parameter, or the length of a list parameter', async () => {
    expect(await criteriaResult('status-param-open', { engagement: 'eng-2', status: 'open' })).toEqual(PASSES);

    expect(await criteriaResult('status-param-open', { engagement: 'eng-2', status: 'won' })).toEqual(
      fails('The status parameter must be open.'),
    );

    expect(await criteriaResult('less-than', { engagement: 'eng-2', amount: 1000 })).toEqual(PASSES);

    expect(await criteriaResult('two-tags', { engagement: 'eng-2', tags: ['a', 'b'] })).toEqual(PASSES);

    expect(await criteriaResult('two-tags', { engagement: 'eng-2', tags: ['a'] })).toEqual(
      fails('Give 2 tags or more.'),
    );

    expect(await criteriaResult('two-tags', { engagement: 'eng-2' })).toEqual(fails('Give 2 tags or more.'));

    expect(await criteriaResult('no-tags', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('no-tags', { engagement: 'eng-2', tags: ['a'] })).toEqual(fails('Give no tags.'));
  });

  it('ontology/action-types/submission-criteria#conditions: the length of an omitted list parameter is 0, the same as for []', async () => {
    for (const parameters of [{ engagement: 'eng-2' }, { engagement: 'eng-2', tags: [] }]) {
      expect(await criteriaResult('no-tags', parameters)).toEqual(PASSES);

      expect(await criteriaResult('two-tags', parameters)).toEqual(fails('Give 2 tags or more.'));
    }
  });

  it('ontology/action-types/submission-criteria#conditions: the value 0 is a value, not a missing value', async () => {
    expect(await criteriaResult('less-than', { engagement: 'eng-2', amount: 0 })).toEqual(PASSES);

    await insertObjects(service.db, ENGAGEMENT, [engagement('eng-free', 'acc-1', 'Free trial', 0, 'open', null)]);

    expect(await criteriaResult('less-than', { engagement: 'eng-free', amount: -1 })).toEqual(PASSES);
  });

  it('ontology/action-types/submission-criteria#conditions: a parameter with no value is null in a comparison', async () => {
    expect(await criteriaResult('status-param-open', { engagement: 'eng-2' })).toEqual(
      fails('The status parameter must be open.'),
    );

    expect(await criteriaResult('status-param-not-open', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('less-than', { engagement: 'eng-2' })).toEqual(fails('LESS_THAN failed.'));

    expect(await criteriaResult('greater-than-equals-param', { engagement: 'eng-2' })).toEqual(
      fails('GREATER_THAN_EQUALS failed.'),
    );
  });

  it("ontology/action-types/submission-criteria#conditions: a Property value is the value before the Action's edits", async () => {
    const answer = await service.apply(named('status-open'), { parameters: { engagement: 'eng-2' }, options: EXECUTE });

    expect((answer.body as { validation: { result: string } }).validation.result).toBe('VALID');

    expect(await statuses()).toEqual({ ...START_STATUSES, 'eng-2': ['approved', newVersion('1')] });
  });

  it('ontology/action-types/submission-criteria#conditions: regex passes when a value matches a regular expression', async () => {
    expect(await criteriaResult('title-regex', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('title-regex', { engagement: 'eng-4' })).toEqual(
      fails('The title must start with Ontology.'),
    );

    expect(await criteriaResult('status-regex', { engagement: 'eng-2', status: 'phase-2' })).toEqual(PASSES);

    expect(await criteriaResult('status-regex', { engagement: 'eng-2', status: 'phase 2' })).toEqual(
      fails('The status must be a word, a hyphen, and a number.'),
    );

    expect(await criteriaResult('status-regex', { engagement: 'eng-2', status: 'see phase-2' })).toEqual(
      fails('The status must be a word, a hyphen, and a number.'),
    );
  });

  it('ontology/action-types/submission-criteria#conditions: and passes when all of its conditions pass', async () => {
    expect(await criteriaResult('and', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('and', { engagement: 'eng-3' })).toEqual(fails('Only a large open Engagement.'));

    expect(await criteriaResult('and', { engagement: 'eng-4' })).toEqual(fails('Only a large open Engagement.'));
  });

  it('ontology/action-types/submission-criteria#conditions: or passes when any of its conditions passes', async () => {
    expect(await criteriaResult('or', { engagement: 'eng-1' })).toEqual(PASSES);

    expect(await criteriaResult('or', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('or', { engagement: 'eng-3' })).toEqual(fails('Only a won or very large Engagement.'));
  });

  it('ontology/action-types/submission-criteria#conditions: not passes when its condition fails', async () => {
    expect(await criteriaResult('not', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('not', { engagement: 'eng-4' })).toEqual(fails('A lost Engagement cannot change.'));
  });

  it('ontology/action-types/submission-criteria#conditions: true always passes', async () => {
    for (const id of ['eng-1', 'eng-2', 'eng-4'])
      expect(await criteriaResult('true', { engagement: id })).toEqual(PASSES);
  });

  it('ontology/action-types/submission-criteria#conditions: and, or, and not can nest', async () => {
    expect(await criteriaResult('nested', { engagement: 'eng-2' })).toEqual(PASSES);

    expect(await criteriaResult('nested', { engagement: 'eng-6' })).toEqual(PASSES);

    expect(await criteriaResult('nested', { engagement: 'eng-3' })).toEqual(fails('No small open or lost Engagement.'));

    expect(await criteriaResult('nested', { engagement: 'eng-4' })).toEqual(fails('No small open or lost Engagement.'));
  });
});

describe('the criteria of a function-backed Action', () => {
  it.each(Object.keys(FUNCTION_CRITERIA))(
    'ontology/action-types/submission-criteria#conditions: a criterion of a function-backed Action reads a Property of an Object parameter (%s)',
    async (name) => {
      await insertObjects(service.db, ACCOUNT, CLIENT_ACCOUNTS.slice(0, 2));

      expect(await criteriaResult(name, { account: 'acc-1' })).toEqual(PASSES);

      expect(await criteriaResult(name, { account: 'acc-2' })).toEqual(fails('The Account must be a customer.'));
    },
  );

  it('ontology/action-types/submission-criteria#conditions: a missing Object of a function-backed Action gives no 404, and its Property has no value', async () => {
    expect(await criteriaResult('function-phase', { account: 'acc-missing' })).toEqual(
      fails('The Account must be a customer.'),
    );
  });

  it("ontology/functions/edit-functions#version-check: the criteria read in the run's snapshot, so a change that commits before the snapshot fails the criterion and the Action writes nothing", async () => {
    await insertObjects(service.db, ACCOUNT, [account('acc-1', 'Acme', 'customer')]);

    const makeProspect = sql(
      "UPDATE ontology_1_objects.account SET phase = 'prospect', __version = __version + 1 WHERE account_id = 'acc-1'",
    );

    const db: Db = {
      query: (statement) => service.db.query(statement),
      stream: (statement) => service.db.stream(statement),
      transaction: (run) => service.db.transaction(run),
      snapshot: async (run) => {
        await service.db.query(makeProspect);

        return service.db.snapshot(run);
      },
    };

    const answer = await service.apply(
      named('function-phase'),
      { parameters: { account: 'acc-1' }, options: EXECUTE },
      { db },
    );

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([
      { account_id: 'acc-1', name: 'Acme', phase: 'prospect', __version: '2' },
    ]);

    expect(await statuses()).toEqual(START_STATUSES);

    expect(await historyRows()).toEqual([]);

    expect(answer.status).toBe(200);

    const { result, submissionCriteria } = (answer.body as { validation: Record<string, unknown> }).validation;

    expect({ result, submissionCriteria }).toEqual(fails('The Account must be a customer.'));
  });
});
