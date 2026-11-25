import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actionOf, ScriptedFunctions, withFunctions } from './functions.test-utils.ts';
import {
  propertyOfType,
  renamed,
  STRING_FLAGS,
  stringProperty,
  twinObjectType,
  unchecked,
} from '../ontology/stored.test-utils.ts';
import {
  actionType,
  addRule,
  errorAnswer,
  insertObjects,
  invalidValue,
  modifyRule,
  NS,
  parameterValue,
  rowsOf,
  startActions,
  staticString,
  twinIr,
  type ActionsService,
  type ObjectRow,
  newVersion,
} from '../actions/actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const SCRIPTED_ACTION = actionOf('scripted');
const VALUE_PROBE = `${NS}ValueProbe`;
const STRUCT_PROBE = `${NS}StructProbe`;
const SET_STRUCT_PROBE_RELATIONSHIP = `${NS}set-struct-probe-relationship`;
const CREATE_PROBE = `${NS}create-value-probe`;
const SET_PROBE = `${NS}set-value-probe`;
const CREATE_AND_SET_PROBE = `${NS}create-and-set-value-probe`;
const COPY_TAGS_PROBE = `${NS}copy-tags-value-probe`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

type PropertyBlock = ReturnType<typeof stringProperty>;

const STRING_ARRAY = {
  type: 'array',
  array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
} as PropertyBlock['type'];

const required = (property: PropertyBlock, noEmptyCollections = false): PropertyBlock =>
  unchecked({
    ...property,
    dataConstraints: { propertyTypeConstraints: [], nullabilityV2: { noNulls: true, noEmptyCollections } },
  });

function valueProbe(): OntologyIr['ontology']['objectTypes'][string] {
  const block = renamed(twinObjectType('Account'), VALUE_PROBE);

  const properties: PropertyBlock[] = [
    stringProperty('note'),
    propertyOfType('score', { type: 'double', double: {} }),
    propertyOfType('tags', STRING_ARRAY),
    required(propertyOfType('labels', STRING_ARRAY), true),
    required(propertyOfType('aliases', STRING_ARRAY)),
    propertyOfType('price', unchecked({ type: 'decimal', decimal: { precision: 5, scale: 2 } })),
    propertyOfType('seen', { type: 'timestamp', timestamp: {} }),
  ];

  for (const property of properties) block.objectType.propertyTypes[property.apiName] = property;

  return block;
}

const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const RANGE = { type: 'range', range: { type: 'range', range: {} } };
const DATETIME = { type: 'datetime', datetime: { type: 'datetime', datetime: {} } };
const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
const REQUIRED = { type: 'required', required: {} };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };

interface TestParameter {
  readonly type: unknown;
  readonly allowedValues: unknown;
  readonly required: unknown;
}

const stringParameter: TestParameter = {
  type: { type: 'string', string: {} },
  allowedValues: TEXT,
  required: NOT_REQUIRED,
};

const doubleParameter: TestParameter = {
  type: { type: 'double', double: {} },
  allowedValues: RANGE,
  required: NOT_REQUIRED,
};

const decimalParameter: TestParameter = {
  type: { type: 'decimal', decimal: {} },
  allowedValues: RANGE,
  required: NOT_REQUIRED,
};

const timestampParameter: TestParameter = {
  type: { type: 'timestamp', timestamp: {} },
  allowedValues: DATETIME,
  required: NOT_REQUIRED,
};

const stringListParameter: TestParameter = {
  type: { type: 'stringList', stringList: {} },
  allowedValues: TEXT,
  required: NO_LIST_LENGTH,
};

const probeParameter: TestParameter = {
  type: { type: 'objectReference', objectReference: { objectTypeId: VALUE_PROBE } },
  allowedValues: OBJECT_QUERY,
  required: REQUIRED,
};

const CREATE_PARAMETERS: Record<string, TestParameter> = {
  accountId: stringParameter,
  name: stringParameter,
  note: stringParameter,
  score: doubleParameter,
  tags: stringListParameter,
  labels: stringListParameter,
  aliases: stringListParameter,
  price: decimalParameter,
  seen: timestampParameter,
};

const mapEach = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, parameterValue(id)]));

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  ir.ontology.objectTypes[VALUE_PROBE] = valueProbe();

  const blocks: ActionTypeBlock[] = [
    actionType(CREATE_PROBE, CREATE_PARAMETERS, [addRule(VALUE_PROBE, mapEach(Object.keys(CREATE_PARAMETERS)))]),
    actionType(SET_PROBE, { probe: probeParameter, name: stringParameter, note: stringParameter }, [
      modifyRule('probe', mapEach(['name', 'note'])),
    ]),
    actionType(COPY_TAGS_PROBE, { probe: probeParameter }, [
      modifyRule('probe', {
        aliases: {
          type: 'objectParameterPropertyValue',
          objectParameterPropertyValue: { parameterId: 'probe', propertyTypeId: 'tags' },
        },
      }),
    ]),
    actionType(
      CREATE_AND_SET_PROBE,
      {
        accountId: stringParameter,
        labels: stringListParameter,
        aliases: stringListParameter,
        probe: probeParameter,
        note: stringParameter,
      },
      [
        addRule(VALUE_PROBE, {
          accountId: parameterValue('accountId'),
          name: staticString('Created'),
          ...mapEach(['labels', 'aliases']),
        }),
        modifyRule('probe', { note: parameterValue('note') }),
      ],
    ),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;
let scripted: ScriptedFunctions;

beforeAll(async () => {
  const ir = testIr();

  scripted = new ScriptedFunctions(ir);

  const scriptedFunction = {
    apiName: 'scripted',
    inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }],
    edits: [ACCOUNT, VALUE_PROBE],
  } as const;

  const { ir: withScripted, functions } = await withFunctions([scriptedFunction], scripted.source, ir);

  service = await startActions(withScripted, functions);
});

afterAll(() => {
  scripted?.close();

  return service?.stop();
});

beforeEach(() => {
  scripted.reset();

  return service.clear();
});

const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };
const APPLIED = { status: 200, body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID } };

const probeRefused = (property: string, builderErrorMessage: string) =>
  invalidValue(VALUE_PROBE, property, builderErrorMessage);

const EMPTY_STRING = 'A string is never empty.';

const FUNCTION_TYPE_MISMATCH = 'The Function assigned a value whose type does not match the Property.';

const LONG_STRING = 'A string has at most 1,000,000 bytes in UTF-8.';
const DECIMAL_5_2 = 'A Decimal value fits the precision 5 and the scale 2 of its Property.';
const REQUIRED_NULL = 'A required Property never holds null.';
const REQUIRED_EMPTY = 'A required array Property with noEmptyCollections never holds an empty array.';

const create = (changes: Record<string, unknown> = {}) => ({
  parameters: { accountId: 'vp-new', name: 'New', labels: ['first'], ...changes },
  options: EXECUTE_NONE,
});

const VP_1: ObjectRow = { accountId: 'vp-1', name: 'First', phase: null, note: 'before', labels: ['l'], aliases: [] };

const probeRow = (accountId: string, values: Record<string, unknown> = {}) => ({
  account_id: accountId,
  name: 'New',
  phase: null,
  note: null,
  score: null,
  tags: [],
  labels: ['first'],
  aliases: [],
  price: null,
  seen: null,
  __version: '1',
  ...values,
});

const VP_1_ROW = probeRow('vp-1', { name: 'First', note: 'before', tags: null, labels: ['l'] });

const probes = () => rowsOf(service.db, VALUE_PROBE, 'account_id');

async function expectRefused(actionType: string, body: unknown, expected: unknown): Promise<void> {
  await insertObjects(service.db, VALUE_PROBE, [VP_1]);

  expect(errorAnswer(await service.apply(actionType, body))).toEqual(expected);

  expect(await probes()).toEqual([VP_1_ROW]);
}

describe('the value rules on write', () => {
  it('ontology/object-link-types/properties#value-rules-on-write: checks the rules on each write, a create and a modify', async () => {
    await expectRefused(CREATE_PROBE, create({ note: '' }), probeRefused('note', EMPTY_STRING));

    await service.clear();

    await expectRefused(
      SET_PROBE,
      { parameters: { probe: 'vp-1', name: 'Renamed', note: '' }, options: EXECUTE_NONE },
      probeRefused('note', EMPTY_STRING),
    );
  });

  it('ontology/object-link-types/properties#value-rules-on-write: a write whose values follow each rule succeeds', async () => {
    await insertObjects(service.db, VALUE_PROBE, [VP_1]);

    const answer = await service.apply(
      CREATE_PROBE,
      create({ note: 'n', score: 2.5, tags: ['a', 'b'], aliases: ['x'], price: '123.45' }),
    );

    expect(answer).toEqual(APPLIED);

    expect(await probes()).toEqual([
      VP_1_ROW,
      probeRow('vp-new', {
        note: 'n',
        score: 2.5,
        tags: ['a', 'b'],
        aliases: ['x'],
        price: '123.45',
        __version: newVersion(),
      }),
    ]);
  });

  it('ontology/object-link-types/properties#value-rules-on-write: refuses "" in a String Property, an array element, a struct field, and the primary key, and does not write null', async () => {
    await expectRefused(CREATE_PROBE, create({ note: '' }), probeRefused('note', EMPTY_STRING));

    await service.clear();

    await expectRefused(CREATE_PROBE, create({ tags: ['a', ''] }), probeRefused('tags', EMPTY_STRING));

    await service.clear();

    await expectRefused(CREATE_PROBE, create({ accountId: '' }), probeRefused('accountId', EMPTY_STRING));

    await service.clear();

    await insertObjects(service.db, STRUCT_PROBE, [{ probeId: 'sp-1', relationship: { label: 'introduced' } }]);

    const answer = await service.apply(SET_STRUCT_PROBE_RELATIONSHIP, {
      parameters: { objectToModifyParameter: 'sp-1', relationship: { label: '' } },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(invalidValue(STRUCT_PROBE, 'relationship.label', EMPTY_STRING));

    expect(await rowsOf(service.db, STRUCT_PROBE, 'probe_id')).toEqual([
      { probe_id: 'sp-1', relationship: { label: 'introduced' }, measures: {}, __version: '1' },
    ]);
  });

  it('ontology/object-link-types/properties#value-rules-on-write: refuses a null element in an array that a Function edit writes', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-1', name: 'Acme', phase: 'customer' }]);

    scripted.once(() => [
      {
        type: 'modifyObject',
        object: { objectType: VALUE_PROBE, primaryKey: 'vp-1' },
        properties: new Map([['tags', ['a', null]]]),
      },
    ]);

    await expectRefused(
      SCRIPTED_ACTION,
      { parameters: { account: 'acc-1' }, options: EXECUTE_NONE },
      probeRefused('tags', FUNCTION_TYPE_MISMATCH),
    );
  });

  it('ontology/object-link-types/properties#value-rules-on-write: refuses a stored null element that a rule copies with objectParameterPropertyValue, with the rule text', async () => {
    await insertObjects(service.db, VALUE_PROBE, [{ ...VP_1, tags: ['a', null] }]);

    const answer = await service.apply(COPY_TAGS_PROBE, { parameters: { probe: 'vp-1' }, options: EXECUTE_NONE });

    expect(errorAnswer(answer)).toEqual(probeRefused('aliases', 'An array never holds a null element.'));

    expect(await probes()).toEqual([
      probeRow('vp-1', { name: 'First', note: 'before', tags: ['a', null], labels: ['l'] }),
    ]);
  });

  it('ontology/object-link-types/properties#value-rules-on-write: a string has at most 1,000,000 bytes in UTF-8, not characters', async () => {
    await expectRefused(CREATE_PROBE, create({ note: 'é'.repeat(500_001) }), probeRefused('note', LONG_STRING));

    await service.clear();

    await expectRefused(
      CREATE_PROBE,
      create({ tags: ['a', 'x'.repeat(1_000_001)] }),
      probeRefused('tags', LONG_STRING),
    );

    await service.clear();

    expect(await service.apply(CREATE_PROBE, create({ note: 'é'.repeat(500_000) }))).toEqual(APPLIED);

    expect(await probes()).toEqual([probeRow('vp-new', { note: 'é'.repeat(500_000), __version: newVersion() })]);
  });

  it('ontology/object-link-types/properties#value-rules-on-write: a Decimal value fits the precision and the scale of its Property, with no rounding', async () => {
    for (const price of ['1.234', 1.234, '1234.5', 1234, '-1000']) {
      await expectRefused(CREATE_PROBE, create({ price }), probeRefused('price', DECIMAL_5_2));

      await service.clear();
    }

    for (const [accountId, price] of [
      ['vp-a', '999.99'],
      ['vp-b', -999.99],
      ['vp-c', '1.500'],
      ['vp-d', '0.01'],
    ] as const) {
      expect(await service.apply(CREATE_PROBE, create({ accountId, price }))).toEqual(APPLIED);
    }

    expect(await probes()).toEqual([
      probeRow('vp-a', { price: '999.99', __version: newVersion() }),
      probeRow('vp-b', { price: '-999.99', __version: newVersion() }),
      probeRow('vp-c', { price: '1.50', __version: newVersion() }),
      probeRow('vp-d', { price: '0.01', __version: newVersion() }),
    ]);
  });

  it('ontology/object-link-types/properties#value-rules-on-write: the refusal names the Object Type, the Property, and the rule, and the Action writes none of its edits', async () => {
    const body = {
      parameters: { accountId: 'vp-new', labels: ['first'], probe: 'vp-1', note: '' },
      options: EXECUTE_NONE,
    };

    await expectRefused(CREATE_AND_SET_PROBE, body, probeRefused('note', EMPTY_STRING));
  });
});

describe('the base type of a parameter value', () => {
  const wrongType = (parameterId: string, parameterBaseType: string, parameterValue: unknown) => ({
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'InvalidParameterValue',
      parameters: { parameterBaseType, parameterId, parameterValue },
    },
  });

  const CASES = [
    { name: 'a String with U+0000', body: '{"note":"a\\u0000b"}', expected: wrongType('note', 'String', 'a\u0000b') },
    { name: 'an infinite Double', body: '{"score":1e999}', expected: wrongType('score', 'Double', null) },
    { name: 'an infinite Decimal', body: '{"price":-1e999}', expected: wrongType('price', 'Decimal', null) },
    {
      name: 'a Timestamp on a day that its month does not have',
      body: '{"seen":"2026-02-30T00:00:00Z"}',
      expected: wrongType('seen', 'Timestamp', '2026-02-30T00:00:00Z'),
    },
    {
      name: 'a Timestamp with an offset over 15:59',
      body: '{"seen":"2026-10-17T18:00:00+23:59"}',
      expected: wrongType('seen', 'Timestamp', '2026-10-17T18:00:00+23:59'),
    },
    {
      name: 'a Timestamp in the year 0000',
      body: '{"seen":"0000-01-01T00:00:00Z"}',
      expected: wrongType('seen', 'Timestamp', '0000-01-01T00:00:00Z'),
    },
  ];

  const rawParameters = (changes: string) =>
    `{"accountId":"vp-new","name":"New","labels":["first"],${changes.slice(1)}`;

  it.each(CASES)(
    'service/http-api#errors: $name gets 400 InvalidParameterValue, and writes nothing',
    async ({ body, expected }) => {
      await expectRefused(
        CREATE_PROBE,
        `{"parameters":${rawParameters(body)},"options":${JSON.stringify(EXECUTE_NONE)}}`,
        expected,
      );
    },
  );

  it('service/http-api#errors: an Object parameter value with U+0000 gets 400 InvalidPropertyValue, over REST and over the MCP, and writes nothing', async () => {
    const expected = {
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidPropertyValue',
        parameters: { propertyBaseType: 'String', property: 'accountId', propertyValue: 'a\u0000b' },
      },
    };

    await expectRefused(
      SET_PROBE,
      { parameters: { probe: 'a\u0000b', name: 'Renamed' }, options: EXECUTE_NONE },
      expected,
    );

    await service.clear();

    await insertObjects(service.db, VALUE_PROBE, [VP_1]);

    const answer = await service.applyOverMcp(SET_PROBE, { probe: 'a\u0000b', name: 'Renamed' });

    const { result } = answer.body as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };

    expect(result.isError).toBe(true);

    const { errorInstanceId, ...error } = result.structuredContent;

    expect({ status: 400, body: error }).toEqual(expected);
    expect(errorInstanceId).toEqual(expect.any(String));

    expect(await probes()).toEqual([VP_1_ROW]);
  });

  it('service/http-api#errors: a Timestamp with no seconds and a Decimal with an exponent apply, as in an Object Set filter', async () => {
    expect(await service.apply(CREATE_PROBE, create({ seen: '2026-10-06T14:30Z', price: '1.5e2' }))).toEqual(APPLIED);

    expect(await probes()).toEqual([
      probeRow('vp-new', { seen: new Date('2026-10-06T14:30:00Z'), price: '150.00', __version: newVersion() }),
    ]);
  });

  it.each(CASES)(
    'service/http-api#errors: $name over the MCP gets the isError result 400 InvalidParameterValue, and writes nothing',
    async ({ body, expected }) => {
      await insertObjects(service.db, VALUE_PROBE, [VP_1]);

      const answer = await service.applyOverMcp(CREATE_PROBE, rawParameters(body));

      expect(answer.status).toBe(200);

      const { result } = answer.body as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };

      expect(result.isError).toBe(true);

      const { errorInstanceId, ...error } = result.structuredContent;

      expect({ status: 400, body: error }).toEqual(expected);
      expect(errorInstanceId).toEqual(expect.any(String));

      expect(await probes()).toEqual([VP_1_ROW]);
    },
  );
});

describe('the required Properties', () => {
  it('ontology/object-link-types/properties#required-properties: a required Property refuses null, on a create and on a modify', async () => {
    await expectRefused(CREATE_PROBE, create({ name: undefined }), probeRefused('name', REQUIRED_NULL));

    await service.clear();

    await expectRefused(CREATE_PROBE, create({ name: null }), probeRefused('name', REQUIRED_NULL));

    await service.clear();

    await expectRefused(
      SET_PROBE,
      { parameters: { probe: 'vp-1', note: 'after' }, options: EXECUTE_NONE },
      probeRefused('name', REQUIRED_NULL),
    );
  });

  it('ontology/object-link-types/properties#required-properties: an optional Property accepts null', async () => {
    await insertObjects(service.db, VALUE_PROBE, [VP_1]);

    expect(
      await service.apply(SET_PROBE, { parameters: { probe: 'vp-1', name: 'Renamed' }, options: EXECUTE_NONE }),
    ).toEqual(APPLIED);

    expect(await probes()).toEqual([
      probeRow('vp-1', { name: 'Renamed', tags: null, labels: ['l'], __version: newVersion('1') }),
    ]);
  });

  it('ontology/object-link-types/properties#required-properties: a required array with noEmptyCollections: true refuses [], and one with noEmptyCollections: false accepts it', async () => {
    await expectRefused(CREATE_PROBE, create({ labels: [] }), probeRefused('labels', REQUIRED_EMPTY));

    await service.clear();

    await expectRefused(CREATE_PROBE, create({ labels: undefined }), probeRefused('labels', REQUIRED_EMPTY));

    await service.clear();

    expect(await service.apply(CREATE_PROBE, create())).toEqual(APPLIED);

    expect(await probes()).toEqual([probeRow('vp-new', { __version: newVersion() })]);
  });
});

describe('the struct values', () => {
  it('ontology/object-link-types/properties#structs: a struct value can leave out any field', async () => {
    await insertObjects(service.db, STRUCT_PROBE, [
      { probeId: 'sp-1', relationship: { label: 'introduced', since: '2024-03-01' } },
      { probeId: 'sp-2', relationship: { label: 'referred', since: '2025-07-15' } },
      { probeId: 'sp-3', relationship: { label: 'met', since: '2025-07-15' } },
    ]);

    for (const [key, relationship] of [
      ['sp-1', { since: '2026-01-02' }],
      ['sp-2', {}],
      ['sp-3', { label: 'met', since: null }],
    ] as const) {
      const answer = await service.apply(SET_STRUCT_PROBE_RELATIONSHIP, {
        parameters: { objectToModifyParameter: key, relationship },
        options: EXECUTE_NONE,
      });

      expect(answer).toEqual(APPLIED);
    }

    expect(await rowsOf(service.db, STRUCT_PROBE, 'probe_id')).toEqual([
      { probe_id: 'sp-1', relationship: { since: '2026-01-02' }, measures: {}, __version: newVersion('1') },
      { probe_id: 'sp-2', relationship: {}, measures: {}, __version: newVersion('1') },
      { probe_id: 'sp-3', relationship: { label: 'met' }, measures: {}, __version: newVersion('1') },
    ]);
  });
});

describe('the error of a rule-backed Action', () => {
  it('service/http-api#errors: a value of a rule-backed Action that breaks a value rule gets 400 ApplyActionFailed with originalErrorName Ontos:InvalidActionPropertyFormat', async () => {
    await expectRefused(CREATE_PROBE, create({ tags: [''] }), probeRefused('tags', EMPTY_STRING));
  });
});

describe('the error of a function-backed Action', () => {
  it('service/http-api#errors: a Function edit value that breaks a value rule gets the same 400 ApplyActionFailed with the Function builderErrorMessage, and writes nothing', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-1', name: 'Acme', phase: 'customer' }]);

    scripted.once(() => [
      {
        type: 'modifyObject',
        object: { objectType: ACCOUNT, primaryKey: 'acc-1' },
        properties: new Map([['phase', '']]),
      },
    ]);

    const answer = await service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE });

    expect(errorAnswer(answer)).toEqual(
      invalidValue(ACCOUNT, 'phase', 'The Function assigned a value whose type does not match the Property.'),
    );

    expect(await rowsOf(service.db, ACCOUNT, 'account_id')).toEqual([
      { account_id: 'acc-1', name: 'Acme', phase: 'customer', __version: '1' },
    ]);
  });
});
