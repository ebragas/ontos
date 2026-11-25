import type { OntologyIr } from '@osdk/client.unstable';
import type { ActionTypeV2, ObjectTypeFullMetadata } from '@osdk/foundry.ontologies';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { propertyOfType, renamed, twinObjectType, unchecked } from '../ontology/stored.test-utils.ts';
import {
  actionType,
  errorAnswer,
  invalidValue,
  NS,
  ONTOLOGY_RID,
  parameterValue,
  rowsOf,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
} from './actions.test-utils.ts';

const LINE_PROBE = `${NS}LineProbe`;
const CREATE_LINE = `${NS}create-line-probe`;
const CHECK_LINE = `${NS}check-line-probe`;
const COMPARE_STRUCTS = `${NS}compare-structs`;
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;

type PropertyBlock = ReturnType<typeof propertyOfType>;

const fieldType = (apiName: string, type: object) => ({
  apiName,
  displayMetadata: { displayName: apiName },
  typeClasses: [],
  aliases: [],
  fieldType: type,
});

const lineType = (precision: number, scale: number) =>
  unchecked<PropertyBlock['type']>({
    type: 'struct',
    struct: {
      structFields: [
        fieldType('sku', { type: 'string', string: {} }),
        fieldType('unitPrice', { type: 'decimal', decimal: { precision, scale } }),
      ],
    },
  });

function lineProbe(precision: number, scale: number): OntologyIr['ontology']['objectTypes'][string] {
  const block = renamed(twinObjectType('Account'), LINE_PROBE);
  const line = propertyOfType('line', lineType(precision, scale));

  block.objectType.propertyTypes[line.apiName] = line;

  block.entityMetadata = unchecked({
    ...block.entityMetadata,
    editsHistory: { type: 'config', config: { store: LINE_PROBE, storeAllPreviousProperties: false } },
  });

  return block;
}

const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const STRUCT = { type: 'struct', struct: { type: 'struct', struct: {} } };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };

const fieldOf = (field: string) => ({
  type: 'structParameterFieldValue',
  structParameterFieldValue: { parameterId: 'line', structFieldApiName: field },
});

const LINE_PARAMETER = {
  type: {
    type: 'struct',
    struct: {
      structFieldTypes: {
        sku: { type: 'string', string: {} },
        unitPrice: { type: 'decimal', decimal: { precision: 12, scale: 4 } },
      },
    },
  },
  allowedValues: STRUCT,
  required: NOT_REQUIRED,
};

function createLine(): OntologyIr['ontology']['actionTypes'][string] {
  return actionType(
    CREATE_LINE,
    {
      accountId: { type: { type: 'string', string: {} }, allowedValues: TEXT, required: NOT_REQUIRED },
      name: { type: { type: 'string', string: {} }, allowedValues: TEXT, required: NOT_REQUIRED },
      line: LINE_PARAMETER,
    },
    [
      {
        type: 'addObjectRule',
        addObjectRule: {
          objectTypeId: LINE_PROBE,
          propertyValues: { accountId: parameterValue('accountId'), name: parameterValue('name') },
          structFieldValues: { line: { sku: fieldOf('sku'), unitPrice: fieldOf('unitPrice') } },
        },
      },
    ],
  );
}

const STRING = { type: 'string', string: {} };

const structParameter = (fields: Record<string, object>) => ({
  type: { type: 'struct', struct: { structFieldTypes: fields } },
  allowedValues: STRUCT,
  required: NOT_REQUIRED,
});

const equals = (failureMessage: string, left: object, right: object) =>
  unchecked({
    condition: { type: 'comparison', comparison: { operator: 'EQUALS', left, right } },
    displayMetadata: { failureMessage, typeClasses: [] },
  });

function criteriaAction(
  apiName: string,
  more: Record<string, Record<string, object>>,
  criteria: readonly unknown[],
): OntologyIr['ontology']['actionTypes'][string] {
  const block = actionType(
    apiName,
    {
      obj: {
        type: { type: 'objectReference', objectReference: { objectTypeId: LINE_PROBE } },
        allowedValues: { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
        required: { type: 'required', required: {} },
      },
      line: LINE_PARAMETER,
      ...Object.fromEntries(Object.entries(more).map(([id, fields]) => [id, structParameter(fields)])),
    },
    [
      {
        type: 'modifyObjectRule',
        modifyObjectRule: {
          objectToModify: 'obj',
          propertyValues: {},
          structFieldValues: { line: { sku: fieldOf('sku'), unitPrice: fieldOf('unitPrice') } },
        },
      },
    ],
  );

  block.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = unchecked(
    Object.fromEntries(criteria.map((criterion, i) => [String(i), criterion])),
  );

  return block;
}

const STORED_LINE = {
  type: 'objectParameterPropertyValue',
  objectParameterPropertyValue: { parameterId: 'obj', propertyTypeId: 'line' },
};

function testIr(precision = 12, scale = 4): OntologyIr {
  const ir = twinIr('0.6.3');

  ir.ontology.objectTypes[LINE_PROBE] = lineProbe(precision, scale);

  ir.ontology.actionTypes[CREATE_LINE] = createLine();

  ir.ontology.actionTypes[CHECK_LINE] = criteriaAction(CHECK_LINE, {}, [
    equals('The line changed.', parameterValue('line'), STORED_LINE),
  ]);

  ir.ontology.actionTypes[COMPARE_STRUCTS] = criteriaAction(
    COMPARE_STRUCTS,
    {
      exact: { str: STRING, dec: { type: 'decimal', decimal: { precision: 38, scale: 0 } } },
      rough: { str: STRING, dec: { type: 'double', double: {} }, extra: STRING },
      named: { sku: STRING, constructor: STRING },
      plain: { sku: STRING },
    },
    [
      equals('exact equals rough', parameterValue('exact'), parameterValue('rough')),
      equals('rough equals exact', parameterValue('rough'), parameterValue('exact')),
      equals('named equals plain', parameterValue('named'), parameterValue('plain')),
      equals('plain equals named', parameterValue('plain'), parameterValue('named')),
    ],
  );

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const FIT_RULE = 'A Decimal value fits the precision 12 and the scale 4 of its Property.';

const create = (accountId: string, line: unknown) =>
  service.apply(CREATE_LINE, { parameters: { accountId, name: 'Line', line }, options: EXECUTE });

async function loaded(): Promise<unknown> {
  const answer = await service.loadObjects({
    objectSet: { type: 'base', objectType: LINE_PROBE },
    select: ['accountId', 'line'],
    orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    excludeRid: true,
  });

  expect(answer.status).toBe(200);

  return (answer.body as { data: unknown[] }).data;
}

async function historyEdits(accountId: string): Promise<unknown> {
  const answer = await service.editsHistory(LINE_PROBE, { objectPrimaryKey: { accountId } });

  expect(answer.status).toBe(200);

  return (answer.body as { data: { edit: unknown }[] }).data.map(({ edit }) => edit);
}

async function getJson<T>(path: string): Promise<T> {
  const raw = await service.call('GET', `${ONTOLOGY}/${path}`);

  expect(raw.status).toBe(200);

  return JSON.parse(raw.text) as T;
}

describe('the metadata of a Decimal struct field', () => {
  it('ontology/object-link-types/properties#ontology-metadata: the Object Type gives the Decimal struct field with its precision and scale', async () => {
    const body = await getJson<ObjectTypeFullMetadata>(`objectTypes/${LINE_PROBE}/fullMetadata`);

    const line = body.objectType.properties['line']?.dataType;

    expect(
      line?.type === 'struct' ? line.structFieldTypes.map(({ apiName, dataType }) => ({ apiName, dataType })) : line,
    ).toEqual([
      { apiName: 'sku', dataType: { type: 'string' } },
      { apiName: 'unitPrice', dataType: { type: 'decimal', precision: 12, scale: 4 } },
    ]);
  });

  it('ontology/object-link-types/properties#ontology-metadata: the Action Type gives the Decimal field of its struct parameter', async () => {
    const body = await getJson<ActionTypeV2>(`actionTypes/${CREATE_LINE}`);

    expect(body.parameters['line']?.dataType).toEqual({
      type: 'struct',
      fields: [
        { name: 'sku', fieldType: { type: 'string' }, required: false },
        { name: 'unitPrice', fieldType: { type: 'decimal', precision: 12, scale: 4 }, required: false },
      ],
    });
  });
});

describe('a rule-backed write of a Decimal struct field', () => {
  it('ontology/object-link-types/properties#structs: a rule writes unitPrice: 12.5 to a field of scale 4, and loadObjects and the history entry give "12.5000"', async () => {
    expect((await create('lp-1', { sku: 'a', unitPrice: 12.5 })).status).toBe(200);

    expect(await loaded()).toEqual([
      { __apiName: LINE_PROBE, __primaryKey: 'lp-1', accountId: 'lp-1', line: { sku: 'a', unitPrice: '12.5000' } },
    ]);

    expect(await historyEdits('lp-1')).toEqual([
      { type: 'createEdit', properties: { name: 'Line', line: { sku: 'a', unitPrice: '12.5000' } } },
    ]);
  });

  it('ontology/object-link-types/properties#structs: a Decimal field sent as null has no key in the read and in the history entry', async () => {
    expect((await create('lp-1', { sku: 'a', unitPrice: null })).status).toBe(200);

    expect(await loaded()).toEqual([expect.objectContaining({ accountId: 'lp-1', line: { sku: 'a' } })]);

    expect(await historyEdits('lp-1')).toEqual([
      { type: 'createEdit', properties: { name: 'Line', line: { sku: 'a' } } },
    ]);
  });

  it('ontology/action-types/action-types#parameters: a Decimal field sent as "+1.50" passes the parameter check, and the rule writes "1.5000"', async () => {
    expect((await create('lp-1', { sku: 'a', unitPrice: '+1.50' })).status).toBe(200);

    expect(await loaded()).toEqual([
      expect.objectContaining({ accountId: 'lp-1', line: { sku: 'a', unitPrice: '1.5000' } }),
    ]);
  });
});

describe('a where clause on a Decimal struct field', () => {
  it('ontology/ontology-sdk/object-sets#where-clauses: "12.50", 12.5, and gt 12.4999 match the stored "12.5000" by its exact value', async () => {
    for (const [accountId, unitPrice] of [
      ['lp-1', 12.5],
      ['lp-2', 7],
    ] as const)
      expect((await create(accountId, { sku: 'a', unitPrice })).status).toBe(200);

    const unitPrice = { type: 'structField', propertyApiName: 'line', structFieldApiName: 'unitPrice' };

    for (const [type, value] of [
      ['eq', '12.50'],
      ['eq', 12.5],
      ['gt', 12.4999],
    ] as const) {
      const where = { type, propertyIdentifier: unitPrice, value };

      const answer = await service.loadObjects({
        objectSet: { type: 'filter', objectSet: { type: 'base', objectType: LINE_PROBE }, where },
        select: ['accountId'],
        excludeRid: true,
      });

      expect(answer).toEqual({
        status: 200,
        body: expect.objectContaining({ data: [expect.objectContaining({ accountId: 'lp-1' })] }),
      });
    }
  });
});

describe('a criterion that compares a struct with a Decimal field', () => {
  const checked = async (line: unknown) => {
    const answer = await service.apply(CHECK_LINE, {
      parameters: { obj: 'lp-1', line },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(answer.status).toBe(200);

    return (answer.body as { validation: { result: string } }).validation.result;
  };

  it.each([
    ['"7"', '7'],
    ['"7.0000"', '7.0000'],
    ['the number 7', 7],
    ['"+7.00"', '+7.00'],
  ])(
    'ontology/action-types/submission-criteria#conditions: the field %s equals the stored "7.0000", so the struct equals the stored struct',
    async (_, unitPrice) => {
      expect((await create('lp-1', { sku: 'b', unitPrice: 7 })).status).toBe(200);

      expect(await checked({ sku: 'b', unitPrice })).toBe('VALID');
    },
  );

  it('ontology/action-types/submission-criteria#conditions: another Decimal value, "8", does not equal the stored struct', async () => {
    expect((await create('lp-1', { sku: 'b', unitPrice: 7 })).status).toBe(200);

    expect(await checked({ sku: 'b', unitPrice: '8' })).toBe('INVALID');
  });

  it('ontology/action-types/submission-criteria#conditions: the order of the fields does not matter, and a null field equals a field with no value', async () => {
    expect((await create('lp-1', { sku: 'b', unitPrice: 7 })).status).toBe(200);

    expect(await checked({ unitPrice: '7', sku: 'b' })).toBe('VALID');

    await service.clear();

    expect((await create('lp-1', { sku: 'b', unitPrice: null })).status).toBe(200);

    expect(await checked({ sku: 'b', unitPrice: null })).toBe('VALID');
  });
});

describe('a criterion that compares 2 struct parameters', () => {
  const failed = async (parameters: Record<string, unknown>) => {
    expect((await create('lp-1', { sku: 'a', unitPrice: 1 })).status).toBe(200);

    const answer = await service.apply(COMPARE_STRUCTS, {
      parameters: { obj: 'lp-1', ...parameters },
      options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
    });

    expect(answer.status).toBe(200);

    return (
      answer.body as { validation: { submissionCriteria: { configuredFailureMessage: string }[] } }
    ).validation.submissionCriteria.map((c) => c.configuredFailureMessage);
  };

  it('ontology/action-types/submission-criteria#conditions: a Decimal field on either side makes the field compare exact, in both orders', async () => {
    expect(
      await failed({ exact: { str: 'a', dec: '9007199254740993' }, rough: { str: 'a', dec: 9007199254740992 } }),
    ).toEqual(['exact equals rough', 'rough equals exact']);

    await service.clear();

    expect(await failed({ exact: { str: 'a', dec: '7' }, rough: { str: 'a', dec: 7 } })).toEqual([]);
  });

  it('ontology/action-types/submission-criteria#conditions: a field named constructor with the value null equals the field with no value', async () => {
    expect(await failed({ named: { sku: 'a', constructor: null }, plain: { sku: 'a' } })).toEqual([]);
  });
});

describe('a Decimal struct field that does not fit', () => {
  it.each([
    ['"12.34567" on the scale 4', '12.34567'],
    ['too many digits before the point', 123456789],
  ])(
    'ontology/object-link-types/properties#value-rules-on-write: a write of %s gets the fit 400, and writes nothing',
    async (_, unitPrice) => {
      expect(errorAnswer(await create('lp-1', { sku: 'a', unitPrice }))).toEqual(
        invalidValue(LINE_PROBE, 'line.unitPrice', FIT_RULE),
      );

      expect(await rowsOf(service.db, LINE_PROBE, 'account_id')).toEqual([]);
    },
  );
});

describe('a publish that changes a Decimal struct field', () => {
  it.each([
    ['the scale', 12, 2],
    ['the precision', 14, 4],
  ])(
    'ontology/object-edits/schema-migrations#changes-that-need-a-schema-migration: a change of %s of a field that holds values needs a Drop of its Property',
    async (_, precision, scale) => {
      expect((await create('lp-1', { sku: 'a', unitPrice: 12.5 })).status).toBe(200);

      const refusal = await service.publish(testIr(precision, scale), twinFunctions('0.6.3')).then(
        () => 'published',
        (error: unknown) => String(error),
      );

      expect(refusal).toContain(
        `"change":"Change the base type of struct field unitPrice of Property line of Object Type ${LINE_PROBE}","schemaMigrations":["dropProperty"]`,
      );

      expect(await loaded()).toEqual([
        expect.objectContaining({ accountId: 'lp-1', line: { sku: 'a', unitPrice: '12.5000' } }),
      ]);
    },
  );
});
