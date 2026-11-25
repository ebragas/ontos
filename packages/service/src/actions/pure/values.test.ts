import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import type { Edit } from '../index.ts';
import { checkValues } from './values.ts';
import { ApiError, errorBody } from '../../errors/index.ts';
import { orThrow } from '../../errors/fallible.ts';
import { type JsonValue } from '../../ontology/index.ts';
import {
  accountWith,
  compileOrThrow,
  NS,
  propertyOfType,
  stored,
  STRING_FLAGS,
  twinFunctions,
  twinIr,
  unchecked,
} from '../../ontology/stored.test-utils.ts';
import { invalidValue, type Answer } from '../actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const ontology = compileOrThrow(stored(testIr(), { functions: twinFunctions('0.6.3') }));

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  const account = accountWith(
    propertyOfType('tags', {
      type: 'array',
      array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
    }),
  );

  account.objectType.propertyTypes['price'] = propertyOfType(
    'price',
    unchecked({ type: 'decimal', decimal: { precision: 5, scale: 2 } }),
  );

  account.objectType.propertyTypes['share'] = propertyOfType(
    'share',
    unchecked({ type: 'decimal', decimal: { precision: 2, scale: 2 } }),
  );

  account.objectType.propertyTypes['units'] = propertyOfType(
    'units',
    unchecked({ type: 'decimal', decimal: { precision: 3, scale: 0 } }),
  );

  ir.ontology.objectTypes[ACCOUNT] = account;

  return ir;
}

const modify = (objectType: string, primaryKey: string, properties: Record<string, JsonValue>): Edit => ({
  type: 'modifyObject',
  object: { objectType, primaryKey },
  properties: new Map(Object.entries(properties)),
});

const createAccount = (primaryKey: string): Edit => ({
  type: 'addObject',
  object: { objectType: ACCOUNT, primaryKey },
  properties: new Map([['name', 'Acme']]),
});

function errorOf(edits: readonly Edit[]): Answer | undefined {
  try {
    orThrow(checkValues(edits, ontology, 'rules'));

    return undefined;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    const { errorCode, errorName, parameters } = errorBody(error, 'none');

    return { status: error.status, body: { errorCode, errorName, parameters } };
  }
}

const exceeded = (editsCount: number, editsLimit: number): Answer => ({
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'OntologyEditsExceededLimit',
    parameters: { editsCount, editsLimit },
  },
});

const NOT_FINITE = 'A number is never NaN or ±infinity.';
const WRONG_TYPE = 'A value has the base type of its Property.';

describe('the value rules on write, for the values that only an edit Function can give', () => {
  it('ontology/object-link-types/properties#value-rules-on-write: refuses NaN and ±infinity, in a Property and in a struct field', () => {
    expect(errorOf([modify(ENGAGEMENT, 'eng-1', { amount: Number.NaN })])).toEqual(
      invalidValue(ENGAGEMENT, 'amount', NOT_FINITE),
    );

    expect(errorOf([modify(ENGAGEMENT, 'eng-1', { amount: Number.POSITIVE_INFINITY })])).toEqual(
      invalidValue(ENGAGEMENT, 'amount', NOT_FINITE),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { measures: { score: Number.NEGATIVE_INFINITY } })])).toEqual(
      invalidValue(STRUCT_PROBE, 'measures.score', NOT_FINITE),
    );

    expect(errorOf([modify(ENGAGEMENT, 'eng-1', { amount: 12000.5 })])).toBeUndefined();
  });

  it('ontology/object-link-types/properties#value-rules-on-write: an array has at most 100,000 elements', () => {
    const tags = (length: number) => Array.from({ length }, () => 't');

    expect(errorOf([modify(ACCOUNT, 'acc-1', { tags: tags(100_001) })])).toEqual(
      invalidValue(ACCOUNT, 'tags', 'An array has at most 100,000 elements.'),
    );

    expect(errorOf([modify(ACCOUNT, 'acc-1', { tags: tags(100_000) })])).toBeUndefined();
  });

  it('ontology/object-link-types/properties#value-rules-on-write: a struct value has only the fields of its struct, and each field follows the rules of its base type', () => {
    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: { label: 'met', note: 'x' } })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship.note', 'A struct value has only the fields of its struct.'),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: { label: '' } })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship.label', 'A string is never empty.'),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: { label: 'met', since: '' } })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship.since', 'A string is never empty.'),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: { label: 'met', since: null } })])).toBeUndefined();
  });

  it('service/http-api#errors, ontology/functions/edit-functions#apply: a value that does not have the base type of its Property gets 400 ApplyActionFailed with originalErrorName Ontos:InvalidActionPropertyFormat', () => {
    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: { label: 'fn', since: 'bad-date' } })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship.since', WRONG_TYPE),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: 'fn' })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship', WRONG_TYPE),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { measures: { count: 1.5 } })])).toEqual(
      invalidValue(STRUCT_PROBE, 'measures.count', WRONG_TYPE),
    );

    expect(errorOf([modify(ACCOUNT, 'acc-1', { tags: 'a' })])).toEqual(invalidValue(ACCOUNT, 'tags', WRONG_TYPE));
    expect(errorOf([modify(ACCOUNT, 'acc-1', { tags: ['a', 1] })])).toEqual(invalidValue(ACCOUNT, 'tags', WRONG_TYPE));
    expect(errorOf([modify(ACCOUNT, 'acc-1', { price: 'abc' })])).toEqual(invalidValue(ACCOUNT, 'price', WRONG_TYPE));

    expect(errorOf([modify(ENGAGEMENT, 'eng-1', { amount: '12000' })])).toEqual(
      invalidValue(ENGAGEMENT, 'amount', WRONG_TYPE),
    );

    expect(errorOf([modify(ENGAGEMENT, 'eng-1', { createdAt: 'yesterday' })])).toEqual(
      invalidValue(ENGAGEMENT, 'createdAt', WRONG_TYPE),
    );

    expect(
      errorOf([
        modify(ACCOUNT, 'acc-1', { tags: ['a'], price: '12.5' }),
        modify(STRUCT_PROBE, 'sp-1', { measures: { flag: true, at: '2026-10-06T14:30:00Z' } }),
      ]),
    ).toBeUndefined();
  });

  const priceInvalid = invalidValue(
    ACCOUNT,
    'price',
    'A Decimal value fits the precision 5 and the scale 2 of its Property.',
  );

  it.each([
    ['0', undefined],
    [0, undefined],
    ['-0', undefined],
    ['0.000', undefined],
    ['000.00', undefined],
    ['0e9', undefined],
    ['0e-9', undefined],
    ['1e2', undefined],
    [1e2, undefined],
    ['1E2', undefined],
    ['1.5e2', undefined],
    ['9.9999e2', undefined],
    ['12345e-2', undefined],
    ['1e-2', undefined],
    ['0.0001e2', undefined],
    ['1e3', priceInvalid],
    ['9.9999e3', priceInvalid],
    ['9.99999e2', priceInvalid],
    ['1e-3', priceInvalid],
    [1e-7, priceInvalid],
    ['123456e-3', priceInvalid],
    ['1.23e-2', priceInvalid],
    ['0.00001e2', priceInvalid],
  ] as const)(
    'ontology/object-link-types/properties#value-rules-on-write: the Decimal %s, with or without an exponent, fits the precision 5 and the scale 2 only when it needs no rounding',
    (price, expected) => {
      const error = errorOf([modify(ACCOUNT, 'acc-1', { price })]);

      expect(error).toEqual(expected);
    },
  );

  const decimalInvalid = (property: string, precision: number, scale: number) =>
    invalidValue(
      ACCOUNT,
      property,
      `A Decimal value fits the precision ${precision} and the scale ${scale} of its Property.`,
    );

  it.each([
    ['share', '0.99', 2, 2, undefined],
    ['share', '0', 2, 2, undefined],
    ['share', '1', 2, 2, decimalInvalid('share', 2, 2)],
    ['share', '0.001', 2, 2, decimalInvalid('share', 2, 2)],
    ['units', '999', 3, 0, undefined],
    ['units', '1e2', 3, 0, undefined],
    ['units', '1e3', 3, 0, decimalInvalid('units', 3, 0)],
    ['units', '0.5', 3, 0, decimalInvalid('units', 3, 0)],
  ] as const)(
    'ontology/object-link-types/properties#value-rules-on-write: the Decimal %s with the value %s, the precision %s, and the scale %s fits with no rounding',
    (property, value, _precision, _scale, expected) => {
      const error = errorOf([modify(ACCOUNT, 'acc-1', { [property]: value })]);

      expect(error).toEqual(expected);
    },
  );

  it('service/http-api#errors: a struct value that is a list gets the refusal of a value that does not have the base type of its Property', () => {
    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: [] })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship', WRONG_TYPE),
    );

    expect(errorOf([modify(STRUCT_PROBE, 'sp-1', { relationship: ['met'] })])).toEqual(
      invalidValue(STRUCT_PROBE, 'relationship', WRONG_TYPE),
    );
  });

  it('ontology/object-link-types/properties#value-rules-on-write: the refusal names the first value that breaks a rule, in the order of the edits', () => {
    const edits = [
      modify(ENGAGEMENT, 'eng-1', { amount: 1 }),
      modify(ENGAGEMENT, 'eng-2', { status: '' }),
      modify(ENGAGEMENT, 'eng-3', { amount: Number.NaN }),
    ];

    expect(errorOf(edits)).toEqual(invalidValue(ENGAGEMENT, 'status', 'A string is never empty.'));
  });
});

describe('the limits of an Action', () => {
  it('ontology/action-types/action-types#apply: an Action edits at most 10,000 Objects', () => {
    const accounts = Array.from({ length: 10_001 }, (_, index) => createAccount(`acc-${index}`));

    expect(errorOf(accounts)).toEqual(exceeded(10_001, 10_000));
    expect(errorOf(accounts.slice(0, 10_000))).toBeUndefined();
  });

  it('ontology/action-types/action-types#apply: the limit counts distinct Objects, not edits', () => {
    const edits = [
      ...Array.from({ length: 10_000 }, (_, index) => createAccount(`acc-${index}`)),
      modify(ACCOUNT, 'acc-0', { phase: 'customer' }),
    ];

    expect(errorOf(edits)).toBeUndefined();
  });

  it('ontology/action-types/action-types#apply: an Action edits Objects of at most 50 Object Types', () => {
    const edits = Array.from({ length: 51 }, (_, index) =>
      ['key-1', 'key-2'].map((primaryKey): Edit => ({
        type: 'deleteObject',
        object: { objectType: `${NS}Type${index}`, primaryKey },
      })),
    ).flat();

    expect(errorOf(edits)).toEqual(exceeded(51, 50));
    expect(errorOf(edits.slice(0, 100))).toBeUndefined();
  });

  it('ontology/action-types/action-types#apply: an Action edits at most 10,000 Links', () => {
    const links: Edit[] = Array.from({ length: 10_001 }, (_, index) => ({
      type: index % 2 === 0 ? 'addLink' : 'deleteLink',
      link: 'engagements',
      source: { objectType: ACCOUNT, primaryKey: 'acc-1' },
      target: { objectType: ENGAGEMENT, primaryKey: `eng-${index}` },
    }));

    expect(errorOf(links)).toEqual(exceeded(10_001, 10_000));
    expect(errorOf(links.slice(0, 10_000))).toBeUndefined();
  });
});
