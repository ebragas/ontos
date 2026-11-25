import { readFileSync } from 'node:fs';
import type { OntologyIr } from '@osdk/client.unstable';
import { describe, expect, it } from 'vitest';
import { valueTypeCheck } from '../valueTypes/index.ts';
import type { CompiledValueType } from './compiled/valueTypes.ts';
import { CompileError, type CompiledObjectType } from './index.ts';
import { compileOrThrow, NS, stored, STRING_FLAGS, unchecked } from './stored.test-utils.ts';

type Json = Record<string, unknown>;

const TASK = `${NS}Task`;

function makerIr(): OntologyIr {
  return JSON.parse(readFileSync(new URL('../../twin/ir/value-types.json', import.meta.url), 'utf8')) as OntologyIr;
}

function definitions(ir: OntologyIr): Json[] {
  return unchecked<Json[]>(ir.valueTypes.valueTypes);
}

function taskProperties(ir: OntologyIr): Record<string, Json> {
  const block = ir.ontology.objectTypes[TASK];

  if (!block) throw new Error('The IR has no Object Type Task.');

  return unchecked<Record<string, Json>>(block.objectType.propertyTypes);
}

function compiledTask(ir: OntologyIr): CompiledObjectType {
  const task = compileOrThrow(stored(ir)).objectTypes.get(TASK);

  if (!task) throw new Error('compileOntology gave no Object Type Task.');

  return task;
}

function valueTypeOf(ir: OntologyIr, property: string): CompiledValueType | undefined {
  return compiledTask(ir).properties.get(property)?.valueType;
}

function refusal(ir: OntologyIr): string {
  try {
    compileOrThrow(stored(ir));
  } catch (error) {
    if (error instanceof CompileError) return error.message;

    throw error;
  }

  throw new Error('compileOntology did not refuse the IR.');
}

const tagged = (type: string, body: unknown): Json => ({ type, [type]: body });

function definition(apiName: string, baseType: Json, constraints: Json[], versions: string[] = ['1.0.0']): Json {
  return {
    metadata: {
      apiName,
      packageNamespace: 'com.example.twin',
      displayMetadata: { displayName: apiName, description: '' },
      status: { type: 'active', active: {} },
    },
    versions: versions.map((version) => ({
      version,
      baseType,
      constraints: constraints.map((constraint) => ({ constraint: { constraint } })),
      exampleValues: [],
    })),
  };
}

const STRING_BASE = tagged('string', {});
const IR_STRING = tagged('string', STRING_FLAGS);

function withProbe(baseType: Json, constraints: Json[], type: Json = IR_STRING): OntologyIr {
  const ir = makerIr();

  definitions(ir).push(definition('probe', baseType, constraints));

  taskProperties(ir)['probe'] = {
    ...taskProperties(ir)['taskId'],
    apiName: 'probe',
    type,
    valueType: {
      apiName: 'probe',
      version: '1.0.0',
      packageNamespace: 'com.example.twin',
      displayMetadata: { displayName: 'probe', description: '' },
    },
    dataConstraints: { propertyTypeConstraints: constraints.map((constraints) => ({ constraints })) },
  };

  return ir;
}

function probe(baseType: Json, constraints: Json[], type?: Json): CompiledValueType | undefined {
  return valueTypeOf(withProbe(baseType, constraints, type), 'probe');
}

describe('ontology/object-link-types/value-types#declaration', () => {
  it('ontology/object-link-types/value-types#declaration: the IR of stock @osdk/maker with a String enum, a Decimal range, and an array compiles, and each Property holds its value type', () => {
    const task = compiledTask(makerIr());

    expect(task.properties.get('taskId')?.valueType).toBeUndefined();

    expect(task.properties.get('status')?.valueType).toEqual({
      apiName: 'taskStatus',
      rid: 'ri.type-registry.main.value-type.1eb6ee5b-3fde-5044-acd7-66d67cbce23b',
      version: '1.1.0',
      status: 'active',
      displayName: 'Task status',
      description: undefined,
      baseType: { kind: 'string' },
      constraints: [{ rule: { kind: 'enum', options: ['open', 'done'] }, failureMessage: 'Use open or done.' }],
    });

    expect(task.properties.get('budget')?.valueType).toEqual({
      apiName: 'money',
      rid: 'ri.type-registry.main.value-type.434a6667-a05f-50c1-80a7-5c7c3b6edb01',
      version: '1.0.0',
      status: 'deprecated',
      displayName: 'Money',
      description: 'An amount from 0 to 1000000.',
      baseType: { kind: 'decimal' },
      constraints: [{ rule: { kind: 'range', minimum: '0', maximum: '1000000' }, failureMessage: undefined }],
    });

    expect(task.properties.get('labels')?.valueType).toEqual({
      apiName: 'tags',
      rid: 'ri.type-registry.main.value-type.787effd1-de20-5e01-a194-606ff7c77339',
      version: '2.0.0',
      status: 'active',
      displayName: 'Tags',
      description: undefined,
      baseType: { kind: 'array', element: 'string' },
      constraints: [
        {
          rule: {
            kind: 'array',
            minimumSize: 1,
            maximumSize: 5,
            uniqueValues: true,
            element: { kind: 'regex', pattern: '[a-z]+', partialMatch: false },
          },
          failureMessage: 'Use 1 to 5 lowercase tags.',
        },
      ],
    });
  });

  it('ontology/object-link-types/value-types#declaration: 2 Properties with 1 value type hold the same object', () => {
    const ir = makerIr();
    const properties = taskProperties(ir);

    properties['state'] = { ...structuredClone(properties['status']), apiName: 'state' };

    const task = compiledTask(ir);

    expect(task.properties.get('state')?.valueType).toBe(task.properties.get('status')?.valueType);
  });

  it.each<[string, Json, Json[], Json, CompiledValueType['constraints'][number]['rule']]>([
    [
      'a Boolean enum',
      tagged('boolean', {}),
      [tagged('boolean', { allowedValues: ['TRUE_VALUE', 'FALSE_VALUE'] })],
      tagged('boolean', {}),
      { kind: 'enum', options: [true, false] },
    ],
    [
      'an Integer enum',
      tagged('integer', {}),
      [tagged('integer', { type: 'oneOf', oneOf: { values: [1, 2] } })],
      tagged('integer', {}),
      { kind: 'enum', options: [1, 2] },
    ],
    [
      'a Double range',
      tagged('double', {}),
      [tagged('double', { type: 'range', range: { min: 0.5 } })],
      tagged('double', {}),
      { kind: 'range', minimum: 0.5 },
    ],
    [
      'a Decimal enum, as exact strings',
      tagged('decimal', {}),
      [tagged('decimal', { type: 'oneOf', oneOf: { values: ['1.50', '2'] } })],
      tagged('decimal', { precision: 10, scale: 2 }),
      { kind: 'enum', options: ['1.5', '2'] },
    ],
    [
      'a Date range',
      tagged('date', {}),
      [tagged('date', { range: { min: '2026-01-01', max: '2026-12-31' } })],
      tagged('date', {}),
      { kind: 'range', minimum: '2026-01-01', maximum: '2026-12-31' },
    ],
    [
      'a Timestamp range',
      tagged('timestamp', {}),
      [tagged('timestamp', { range: { max: '2026-01-01T00:00:00Z' } })],
      tagged('timestamp', {}),
      { kind: 'range', maximum: '2026-01-01T00:00:00Z' },
    ],
    [
      'a String length',
      STRING_BASE,
      [tagged('string', { type: 'length', length: { minSize: 6, maxSize: 12 } })],
      IR_STRING,
      { kind: 'length', minimum: 6, maximum: 12 },
    ],
    [
      'a partial regex',
      STRING_BASE,
      [tagged('string', { type: 'regex', regex: { regexPattern: '[A-Z]{3}', usePartialMatch: true } })],
      IR_STRING,
      { kind: 'regex', pattern: '[A-Z]{3}', partialMatch: true },
    ],
    ['a UUID', STRING_BASE, [tagged('string', { type: 'isUuid', isUuid: {} })], IR_STRING, { kind: 'uuid' }],
    [
      'an array with no element constraint',
      tagged('array', { elementType: tagged('integer', {}) }),
      [tagged('array', { elementsUnique: false })],
      tagged('array', { subtype: tagged('integer', {}), reducers: [] }),
      { kind: 'array', uniqueValues: false },
    ],
  ])('ontology/object-link-types/value-types#declaration: compiles %s', (_name, baseType, constraints, type, rule) => {
    expect(probe(baseType, constraints, type)?.constraints).toEqual([{ rule, failureMessage: undefined }]);
  });

  it('ontology/object-link-types/value-types#declaration: a value type with no constraint compiles, and accepts each value', () => {
    const valueType = probe(STRING_BASE, []);

    expect(valueType?.constraints).toEqual([]);

    const check = valueTypeCheck(valueType as CompiledValueType);

    for (const value of ['', 'open', 'any text']) expect(check(value)).toBeUndefined();
  });

  it('ontology/object-link-types/value-types#declaration: a Boolean NULL_VALUE option has no effect', () => {
    const valueType = probe(
      tagged('boolean', {}),
      [tagged('boolean', { allowedValues: ['TRUE_VALUE', 'NULL_VALUE'] })],
      tagged('boolean', {}),
    );

    expect(valueType?.constraints).toEqual([{ rule: { kind: 'enum', options: [true] }, failureMessage: undefined }]);

    const check = valueTypeCheck(valueType as CompiledValueType);

    expect(check(true)).toBeUndefined();
    expect(check(false)).toEqual(valueType?.constraints[0]);
  });

  it('ontology/object-link-types/value-types#declaration: an IR with no valueTypes compiles, and no Property has a value type', () => {
    const ir = makerIr();

    Reflect.deleteProperty(ir, 'valueTypes');

    for (const name of ['status', 'budget', 'labels']) {
      const property = taskProperties(ir)[name] as Json;

      Reflect.deleteProperty(property, 'valueType');

      Reflect.deleteProperty(property, 'dataConstraints');
    }

    expect([...compiledTask(ir).properties.values()].map((property) => property.valueType)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('ontology/object-link-types/value-types#declaration: the refusals of compile', () => {
  const oneOf = (values: unknown[], useIgnoreCase = false): Json =>
    tagged('string', { type: 'oneOf', oneOf: { values, useIgnoreCase } });

  it('ontology/object-link-types/value-types#declaration: refuses 2 definitions of 1 value type', () => {
    const ir = makerIr();

    definitions(ir).push(structuredClone(definitions(ir)[0] as Json));

    expect(refusal(ir)).toBe(
      '2 value types have the API name taskStatus. A publish holds 1 definition of each value type.',
    );
  });

  it.each([
    [0, []],
    [2, ['1.0.0', '1.1.0']],
  ])('ontology/object-link-types/value-types#declaration: refuses a value type with %i versions', (count, versions) => {
    const ir = makerIr();

    definitions(ir).push(definition('probe', STRING_BASE, [], versions));

    expect(refusal(ir)).toBe(`Value type probe has ${count} versions. A value type has exactly 1 version.`);
  });

  it.each([
    ['long', tagged('long', {})],
    ['struct', tagged('structV2', { fields: [] })],
    ['array of long', tagged('array', { elementType: tagged('long', {}) })],
    ['array of array', tagged('array', { elementType: tagged('array', { elementType: STRING_BASE }) })],
  ])('ontology/object-link-types/value-types#declaration: refuses the base type %s', (name, baseType) => {
    const ir = makerIr();

    definitions(ir).push(definition('probe', baseType, []));

    expect(refusal(ir)).toBe(
      `Value type probe has the base type ${name}. The base type of a value type is String, Boolean, Integer, Double, Decimal, Date, Timestamp, or an array of 1 of them.`,
    );
  });

  it('ontology/object-link-types/value-types#declaration: refuses an isRid constraint', () => {
    expect(refusal(withProbe(STRING_BASE, [tagged('string', { type: 'isRid', isRid: {} })]))).toBe(
      'Value type probe has an isRid constraint. The Ontology service has no RID constraint.',
    );
  });

  it('ontology/object-link-types/value-types#declaration: refuses a struct constraint', () => {
    expect(refusal(withProbe(STRING_BASE, [tagged('structV2', { elementConstraints: {} })]))).toBe(
      'Value type probe has a struct constraint. The Ontology service has no struct constraint.',
    );
  });

  it('ontology/object-link-types/value-types#declaration: refuses a struct value type on a Property', () => {
    const field = {
      apiName: 'a',
      displayMetadata: { displayName: 'a' },
      typeClasses: [],
      aliases: [],
      fieldType: tagged('boolean', {}),
    };

    const ir = withProbe(STRING_BASE, [], tagged('struct', { structFields: [field] }));

    expect(refusal(ir)).toBe(
      'Property probe of Object Type com.example.twin.Task is a struct with the value type probe. A struct Property has no value type.',
    );
  });

  it('ontology/object-link-types/value-types#declaration: refuses an enum with useIgnoreCase: true', () => {
    expect(refusal(withProbe(STRING_BASE, [oneOf(['a'], true)]))).toBe(
      'Value type probe has an enum with useIgnoreCase: true. The Ontology service has no case-insensitive enum.',
    );
  });

  it.each([
    [
      'an enum on a Date',
      tagged('date', {}),
      tagged('date', { type: 'oneOf', oneOf: { values: ['2026-01-01'] } }),
      'oneOf',
      'date',
    ],
    ['a range on a String', STRING_BASE, tagged('string', { type: 'range', range: { min: 'a' } }), 'range', 'string'],
    [
      'an Integer constraint on a String',
      STRING_BASE,
      tagged('integer', { type: 'oneOf', oneOf: { values: [1] } }),
      'integer',
      'string',
    ],
    ['a String constraint on an array', tagged('array', { elementType: STRING_BASE }), oneOf(['a']), 'string', 'array'],
    ['an array constraint on a String', STRING_BASE, tagged('array', { elementsUnique: true }), 'array', 'string'],
  ])(
    'ontology/object-link-types/value-types#declaration: refuses a constraint kind that does not fit its base type: %s',
    (_name, baseType, constraint, kind, base) => {
      const ir = makerIr();

      definitions(ir).push(definition('probe', baseType, [constraint]));

      expect(refusal(ir)).toBe(
        `Value type probe has a ${kind} constraint on the base type ${base}. The constraint does not fit the base type.`,
      );
    },
  );

  it('ontology/object-link-types/value-types#declaration: refuses a regex that does not compile, also in an array element constraint', () => {
    const regex = (regexPattern: string): Json =>
      tagged('string', { type: 'regex', regex: { regexPattern, usePartialMatch: false } });

    expect(refusal(withProbe(STRING_BASE, [regex('(?i)abc')]))).toBe(
      'Value type probe has the regex (?i)abc, which JavaScript RegExp does not compile.',
    );

    const ir = makerIr();

    definitions(ir).push(
      definition('probe', tagged('array', { elementType: STRING_BASE }), [
        tagged('array', { elementsConstraint: regex('a)(b') }),
      ]),
    );

    expect(refusal(ir)).toBe('Value type probe has the regex a)(b, which JavaScript RegExp does not compile.');
  });

  it.each([
    [
      'a String option that is a number',
      STRING_BASE,
      oneOf([1]),
      'the option 1, which is not a value of the base type string',
    ],
    [
      'a Boolean option of another kind',
      tagged('boolean', {}),
      tagged('boolean', { allowedValues: ['YES'] }),
      'the option "YES", which is not a value of the base type boolean',
    ],
    [
      'an Integer option with a fraction',
      tagged('integer', {}),
      tagged('integer', { type: 'oneOf', oneOf: { values: [1.5] } }),
      'the option 1.5, which is not a value of the base type integer',
    ],
    [
      'an Integer bound past 32 bits',
      tagged('integer', {}),
      tagged('integer', { type: 'range', range: { max: 2 ** 31 } }),
      'the maximum 2147483648, which is not a value of the base type integer',
    ],
    [
      'a Double bound that is a string',
      tagged('double', {}),
      tagged('double', { type: 'range', range: { min: '1' } }),
      'the minimum "1", which is not a value of the base type double',
    ],
    [
      'a Decimal option that is not a number',
      tagged('decimal', {}),
      tagged('decimal', { type: 'oneOf', oneOf: { values: ['1,5'] } }),
      'the option "1,5", which is not a value of the base type decimal',
    ],
    [
      'a Date bound that is not a day',
      tagged('date', {}),
      tagged('date', { range: { min: '2026-02-30' } }),
      'the minimum "2026-02-30", which is not a value of the base type date',
    ],
    [
      'a Timestamp bound with no time',
      tagged('timestamp', {}),
      tagged('timestamp', { range: { max: 'soon' } }),
      'the maximum "soon", which is not a value of the base type timestamp',
    ],
    [
      'a length that is negative',
      STRING_BASE,
      tagged('string', { type: 'length', length: { minSize: -1 } }),
      'the minimum -1, which is not a whole number of 0 or more',
    ],
    [
      'an array size with a fraction',
      tagged('array', { elementType: STRING_BASE }),
      tagged('array', { size: { maxSize: 1.5 } }),
      'the maximum 1.5, which is not a whole number of 0 or more',
    ],
    [
      'an element option of the wrong type',
      tagged('array', { elementType: tagged('integer', {}) }),
      tagged('array', { elementsConstraint: tagged('integer', { type: 'oneOf', oneOf: { values: ['a'] } }) }),
      'the option "a", which is not a value of the base type integer',
    ],
  ])(
    'ontology/object-link-types/value-types#declaration: refuses a bound or an option that is not a value of the base type: %s',
    (_name, baseType, constraint, fault) => {
      const ir = makerIr();

      definitions(ir).push(definition('probe', baseType, [constraint]));

      expect(refusal(ir)).toBe(`Value type probe has ${fault}.`);
    },
  );

  it.each([
    [
      'a Decimal range',
      tagged('decimal', {}),
      tagged('decimal', { type: 'range', range: { min: '10.5', max: '9' } }),
      '"10.5"',
      '"9"',
    ],
    [
      'a Timestamp range',
      tagged('timestamp', {}),
      tagged('timestamp', { range: { min: '2026-01-01T01:00:00+02:00', max: '2025-12-31T22:00:00Z' } }),
      '"2026-01-01T01:00:00+02:00"',
      '"2025-12-31T22:00:00Z"',
    ],
    [
      'a String length',
      STRING_BASE,
      tagged('string', { type: 'length', length: { minSize: 3, maxSize: 2 } }),
      '3',
      '2',
    ],
    [
      'an array size',
      tagged('array', { elementType: STRING_BASE }),
      tagged('array', { size: { minSize: 3, maxSize: 2 } }),
      '3',
      '2',
    ],
  ])(
    'ontology/object-link-types/value-types#declaration: refuses a minimum above the maximum: %s',
    (_name, baseType, constraint, minimum, maximum) => {
      const ir = makerIr();

      definitions(ir).push(definition('probe', baseType, [constraint]));

      expect(refusal(ir)).toBe(`Value type probe has the minimum ${minimum} above the maximum ${maximum}.`);
    },
  );

  it.each([
    ['an API name', { apiName: 'nope', version: '1.1.0' }, 'nope 1.1.0'],
    ['a version', { apiName: 'taskStatus', version: '1.0.0' }, 'taskStatus 1.0.0'],
  ])(
    'ontology/object-link-types/value-types#declaration: refuses a Property value type with %s that the IR does not define',
    (_name, reference, named) => {
      const ir = makerIr();
      const status = taskProperties(ir)['status'] as Json;

      status['valueType'] = { ...(status['valueType'] as Json), ...reference };

      expect(refusal(ir)).toBe(
        `Property status of Object Type com.example.twin.Task uses the value type ${named}, which the IR does not define.`,
      );
    },
  );

  it.each([
    ['a Double Property with a Decimal value type', 'budget', tagged('double', {}), 'double', 'money', 'decimal'],
    [
      'an array Property with a String value type',
      'status',
      tagged('array', { subtype: IR_STRING, reducers: [] }),
      'array of string',
      'taskStatus',
      'string',
    ],
    ['a String Property with an array value type', 'labels', IR_STRING, 'string', 'tags', 'array of string'],
    [
      'an array of Integer with an array of String value type',
      'labels',
      tagged('array', { subtype: tagged('integer', {}), reducers: [] }),
      'array of integer',
      'tags',
      'array of string',
    ],
  ])(
    'ontology/object-link-types/value-types#declaration: refuses a Property base type that differs from its value type: %s',
    (_name, property, type, base, valueType, valueTypeBase) => {
      const ir = makerIr();

      (taskProperties(ir)[property] as Json)['type'] = type;

      expect(refusal(ir)).toBe(
        `Property ${property} of Object Type com.example.twin.Task has the base type ${base}, and its value type ${valueType} has the base type ${valueTypeBase}. The base type of a Property is the base type of its value type.`,
      );
    },
  );

  it.each([
    ['another option', [{ constraints: oneOf(['open']), failureMessage: { message: 'Use open or done.' } }]],
    ['another failure message', [{ constraints: oneOf(['open', 'done']), failureMessage: { message: 'Use open.' } }]],
    ['no constraint', []],
  ])(
    'ontology/object-link-types/value-types#declaration: refuses a propertyTypeConstraints copy with %s',
    (_name, copy) => {
      const ir = makerIr();

      (taskProperties(ir)['status'] as Json)['dataConstraints'] = { propertyTypeConstraints: copy };

      expect(refusal(ir)).toBe(
        'Property status of Object Type com.example.twin.Task has propertyTypeConstraints that differ from the constraints of its value type taskStatus. The value type definition is the 1 source of its constraints.',
      );
    },
  );

  it('ontology/object-link-types/value-types#declaration: refuses propertyTypeConstraints on a Property with no value type', () => {
    const ir = makerIr();

    (taskProperties(ir)['taskId'] as Json)['dataConstraints'] = {
      propertyTypeConstraints: [{ constraints: oneOf(['a']) }],
    };

    expect(refusal(ir)).toBe(
      'Property taskId of Object Type com.example.twin.Task has propertyTypeConstraints and no value type. Only a value type gives a Property constraints.',
    );
  });
});
