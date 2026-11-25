import { describe, expect, it } from 'vitest';
import type { LoadedObject } from '../objects.ts';
import { checkParameters, defaultValues, omittedDefaults } from './parameters.ts';
import { orThrow } from '../../errors/fallible.ts';
import { type JsonValue, type ParameterId } from '../../ontology/index.ts';
import { compileOrThrow, stored, twinFunctions, twinIr } from '../../ontology/stored.test-utils.ts';
import { structListOntology } from '../../functions/structList.test-utils.ts';
import { actionOf } from '../../functions/functions.test-utils.ts';
import { actionType, addRule, NS, parameterValue } from '../actions.test-utils.ts';

const ontology = compileOrThrow(stored(twinIr('0.7.0'), { functions: twinFunctions('0.7.0') }));
const setAccountPhase = ontology.actionTypes.get(`${NS}set-account-phase`);

if (!setAccountPhase) throw new Error('The twin 0.7.0 IR has no set-account-phase.');

const PHASE_DEFAULT = { kind: 'objectProperty', parameter: 'objectToModifyParameter', property: 'phase' };

describe('an omitted parameter and the value null', () => {
  it.each([
    ['no key', { objectToModifyParameter: 'p-om-a1' }, true, new Map([['phase', PHASE_DEFAULT]])],
    [
      'the key with undefined',
      { objectToModifyParameter: 'p-om-a1', phase: undefined },
      true,
      new Map([['phase', PHASE_DEFAULT]]),
    ],
    ['the value null', { objectToModifyParameter: 'p-om-a1', phase: null }, false, new Map()],
  ])(
    'ontology/action-types/action-types#apply: phase with %s has no value, and takes its default value only when it is omitted',
    (_name, sent, omitted, expectedDefaults) => {
      const check = orThrow(checkParameters(setAccountPhase, sent as Record<ParameterId, JsonValue>, ontology));

      expect(check.values.has('phase')).toBe(false);
      expect(check.omitted.has('phase')).toBe(omitted);
      expect(check.omitted.has('objectToModifyParameter')).toBe(false);

      expect(omittedDefaults(setAccountPhase, check)).toEqual(expectedDefaults);

      expect(check.results.get('phase')).toEqual({ result: 'VALID', evaluatedConstraints: [], required: false });
    },
  );

  it('ontology/action-types/action-types#apply: a sent value is not omitted, and takes no default value', () => {
    const check = orThrow(
      checkParameters(setAccountPhase, { objectToModifyParameter: 'p-om-a1', phase: 'prospect' }, ontology),
    );

    expect([
      check.values.get('phase'),
      check.omitted.has('phase'),
      omittedDefaults(setAccountPhase, check).size,
    ]).toEqual(['prospect', false, 0]);
  });
});

describe('the defaultValue that a default value gives', () => {
  const loaded = (properties: Record<string, JsonValue>): ReadonlyMap<ParameterId, LoadedObject> =>
    new Map([
      [
        'objectToModifyParameter',
        {
          objectType: `${NS}Account`,
          primaryKey: 'p-om-a1',
          version: '1',
          properties: new Map(Object.entries(properties)),
        },
      ],
    ]);

  it('ontology/action-types/action-types#apply: gives the Property value of the loaded Object', () => {
    expect(defaultValues(setAccountPhase, loaded({ phase: 'customer' }))).toEqual(new Map([['phase', 'customer']]));
  });

  it('ontology/action-types/action-types#apply, ontology/action-types/action-types#security: gives no defaultValue when the Property has no value, or the person cannot see it', () => {
    expect(defaultValues(setAccountPhase, loaded({}))).toEqual(new Map());
    expect(defaultValues(setAccountPhase, new Map())).toEqual(new Map());
  });
});

const structListIr = await structListOntology();

const structList = compileOrThrow(stored(structListIr.ir, { functions: structListIr.functions }));
const applyRowProbes = structList.actionTypes.get(actionOf('applyRowProbes'));

if (!applyRowProbes) throw new Error('The struct list test Ontology has no Action of applyRowProbes.');

describe('the check of a struct list', () => {
  const row = (rowId: string, fields: Record<string, JsonValue> = {}) => ({
    rowId,
    label: rowId,
    count: 1,
    op: 'noop',
    ...fields,
  });

  const rowsOf = (rows: JsonValue) =>
    orThrow(checkParameters(applyRowProbes, { rows }, structList)).results.get('rows');

  it('ontology/action-types/action-types#parameters: gives 1 struct entry for each row in list order, then a bare arraySize, and label null makes its entry INVALID', () => {
    const result = rowsOf([row('n0'), row('n1', { label: null })]);

    expect(result?.result).toBe('INVALID');
    expect(result?.evaluatedConstraints.map((constraint) => constraint.type)).toEqual(['array', 'arraySize']);

    const [array] = result?.evaluatedConstraints ?? [];
    const entries = array?.type === 'array' ? array.entries : [];

    expect(entries.map((entry) => (entry.type === 'struct' ? entry.structFields['label']?.result : undefined))).toEqual(
      ['VALID', 'INVALID'],
    );
  });

  it('ontology/action-types/action-types#parameters: a 400 of a later row wins over the INVALID result of an earlier row', () => {
    expect(() => rowsOf([row('n0', { label: null }), row('n1', { count: 'seven' })])).toThrow(
      expect.objectContaining({
        status: 400,
        errorName: 'InvalidParameterValue',
        parameters: { parameterBaseType: 'Integer', parameterId: 'rows.count', parameterValue: 'seven' },
      }),
    );
  });

  it('ontology/action-types/action-types#parameters: 10,000 rows are VALID, and 10,001 rows are INVALID with no entry', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => row(`n${i}`));
    const valid = (required: boolean) => ({ result: 'VALID', evaluatedConstraints: [], required });

    const entry = {
      type: 'struct',
      structFields: { rowId: valid(true), label: valid(true), count: valid(true), note: valid(false), op: valid(true) },
    };

    expect(rowsOf(rows(10_000))).toEqual({
      result: 'VALID',
      evaluatedConstraints: [
        { type: 'array', entries: Array.from({ length: 10_000 }, () => entry) },
        { type: 'arraySize' },
      ],
      required: false,
    });

    expect(rowsOf(rows(10_001))).toEqual({
      result: 'INVALID',
      evaluatedConstraints: [{ type: 'array', entries: [] }, { type: 'arraySize' }],
      required: false,
    });
  });
});

const CHECK_DECIMALS = `${NS}check-decimals`;
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const decimalIr = twinIr('0.6.3');

decimalIr.ontology.actionTypes[CHECK_DECIMALS] = actionType(
  CHECK_DECIMALS,
  {
    accountId: {
      type: { type: 'string', string: {} },
      allowedValues: { type: 'text', text: { type: 'text', text: {} } },
      required: NOT_REQUIRED,
    },
    rate: {
      type: { type: 'decimal', decimal: { precision: 6, scale: 2 } },
      allowedValues: { type: 'range', range: { type: 'range', range: {} } },
      required: NOT_REQUIRED,
    },
    line: {
      type: {
        type: 'struct',
        struct: { structFieldTypes: { unitPrice: { type: 'decimal', decimal: { precision: 6, scale: 2 } } } },
      },
      allowedValues: { type: 'struct', struct: { type: 'struct', struct: {} } },
      required: NOT_REQUIRED,
    },
  },
  [addRule(`${NS}Account`, { accountId: parameterValue('accountId') })],
);

const decimalOntology = compileOrThrow(stored(decimalIr, { functions: twinFunctions('0.6.3') }));
const checkDecimals = decimalOntology.actionTypes.get(CHECK_DECIMALS);

if (!checkDecimals) throw new Error('The Decimal test Ontology has no check-decimals.');

describe('a Decimal parameter with a declared scale', () => {
  it('checkParameters gives "+1.50" as "1.5", not padded to the scale 2, for the parameter and for the struct field', () => {
    const check = orThrow(
      checkParameters(checkDecimals, { accountId: 'a', rate: '+1.50', line: { unitPrice: '+1.50' } }, decimalOntology),
    );

    expect([check.values.get('rate'), check.values.get('line')]).toEqual(['1.5', { unitPrice: '1.5' }]);
  });
});
