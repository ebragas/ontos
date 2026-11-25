import type { OntologyIrType } from '@osdk/client.unstable';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CompileError, type PropertyType } from './index.ts';
import { accountWith, compileOrThrow, irOf, NS, propertyOfType, stored, STRING_FLAGS } from './stored.test-utils.ts';

const RUNS = { seed: 20261117, numRuns: 200 };

const ACCOUNT = `${NS}Account`;
const PROPERTY = 'extra';
const OWNER = `Property ${PROPERTY} of Object Type ${ACCOUNT}`;
const TYPE_PATH = `ontology.objectTypes.${ACCOUNT}.objectType.propertyTypes.${PROPERTY}.type`;

const ARRAY_RULE = 'String, Boolean, Integer, Double, Decimal, Date, or Timestamp';
const STRUCT_FIELD_RULE = 'String, Boolean, Integer, Double, Decimal, Date, or Timestamp';
const DECIMAL_RULE = 'A Decimal Property declares a precision of 38 or less and a scale.';

const SIMPLE_KINDS = ['string', 'boolean', 'integer', 'double', 'date', 'timestamp'] as const;

const FEATURES: Readonly<Record<string, string>> = {
  byte: 'Byte',
  short: 'Short',
  float: 'Float',
  long: 'Long',
  vector: 'Vector',
  experimentalTimeDependentV1: 'time series',
  geotimeSeriesReference: 'geotemporal series',
  cipherText: 'cipher text',
  attachment: 'attachment',
  geohash: 'Geopoint',
  geoshape: 'Geoshape',
  mediaReference: 'media reference',
};

const V1_TAGS = new Set<string>([...SIMPLE_KINDS, 'decimal', 'array', 'struct', 'marking']);

interface Accepted {
  readonly ir: unknown;
  readonly compiled: PropertyType;
}

interface Outside {
  readonly ir: unknown;
  readonly named: string;
}

const simpleIr = (kind: string) => ({ type: kind, [kind]: kind === 'string' ? STRING_FLAGS : {} });

const simple: fc.Arbitrary<Accepted> = fc
  .constantFrom(...SIMPLE_KINDS)
  .map((kind) => ({ ir: simpleIr(kind), compiled: { kind } }));

const decimal: fc.Arbitrary<Accepted> = fc
  .record({ precision: fc.integer({ min: 1, max: 38 }), scale: fc.integer({ min: 0, max: 38 }) })
  .map(({ precision, scale }) => ({
    ir: { type: 'decimal', decimal: { precision, scale } },
    compiled: { kind: 'decimal', precision, scale },
  }));

const scalar = fc.oneof(simple, decimal);

const noReducers = fc.constantFrom(undefined, null, []);

const array: fc.Arbitrary<Accepted> = fc.tuple(scalar, noReducers).map(([element, reducers]) => ({
  ir: { type: 'array', array: { subtype: element.ir, ...(reducers === undefined ? {} : { reducers }) } },
  compiled: { kind: 'array', element: element.compiled } as PropertyType,
}));

const fieldName = fc
  .stringMatching(/^[a-z][A-Za-z0-9]{0,11}$/)
  .filter((name) => !['rid', 'primarykey'].includes(name.toLowerCase()));

const structOf = (fields: readonly (readonly [string, unknown])[]) => ({
  type: 'struct',
  struct: {
    structFields: fields.map(([apiName, fieldType]) => ({
      apiName,
      displayMetadata: { displayName: apiName },
      typeClasses: [],
      aliases: [],
      fieldType,
    })),
  },
});

const struct: fc.Arbitrary<Accepted> = fc
  .uniqueArray(fc.tuple(fieldName, scalar), { minLength: 1, maxLength: 6, selector: ([name]) => name })
  .map((fields) => ({
    ir: structOf(fields.map(([name, field]) => [name, field.ir])),
    compiled: {
      kind: 'struct',
      fields: new Map(fields.map(([name, field]) => [name, field.compiled])),
    } as PropertyType,
  }));

const accepted = fc.oneof(scalar, array, struct);

const OUTSIDE: readonly Outside[] = [
  ...Object.entries(FEATURES).map(([tag, feature]) => ({ ir: { type: tag, [tag]: {} }, named: `${tag} (${feature})` })),
  { ir: { type: 'marking', marking: { markingType: 'MANDATORY' } }, named: 'marking MANDATORY (mandatory control)' },
  { ir: { type: 'marking', marking: { markingType: 'CBAC' } }, named: 'marking CBAC (marking property)' },
  ...['constructor', 'toString', 'objectReference'].map((tag) => ({ ir: { type: tag, [tag]: {} }, named: tag })),
];

const otherTag: fc.Arbitrary<Outside> = fc
  .stringMatching(/^[a-z][A-Za-z]{0,9}$/)
  .filter((tag) => !V1_TAGS.has(tag) && !(tag in FEATURES))
  .map((tag) => ({ ir: { type: tag, [tag]: {} }, named: tag }));

const outside = fc.oneof(fc.constantFrom(...OUTSIDE), otherTag);

function forEachOutside(check: (type: Outside) => void): void {
  OUTSIDE.forEach(check);

  fc.assert(fc.property(otherTag, check), RUNS);
}

const arrayOf = (subtype: unknown, reducers: unknown = []) => ({
  type: 'array',
  array: { subtype, ...(reducers === undefined ? {} : { reducers }) },
});

const withType = (type: unknown) => stored(irOf(accountWith(propertyOfType(PROPERTY, type as OntologyIrType))));

function compiledType(type: unknown): PropertyType | undefined {
  return compileOrThrow(withType(type)).objectTypes.get(ACCOUNT)?.properties.get(PROPERTY)?.type;
}

function refusal(type: unknown): string {
  try {
    compileOrThrow(withType(type));
  } catch (error) {
    if (error instanceof CompileError) return error.message;

    throw error;
  }

  throw new Error(`compile accepted ${JSON.stringify(type)}`);
}

function expectNamed(type: unknown, ...fragments: string[]): void {
  const message = refusal(type);

  expect(message).not.toMatch(/^The IR field /);

  for (const fragment of fragments) expect(message).toContain(fragment);
}

describe('the type of a Property', () => {
  it('ontology/object-link-types/properties#arrays ontology/object-link-types/properties#structs ontology/object-link-types/properties#base-types ontology/object-link-types/properties#out-of-scope: compile gives each V1 type, with the fields of a struct in IR order', () => {
    for (const kind of SIMPLE_KINDS) {
      expect(compiledType(simpleIr(kind))).toEqual({ kind });

      for (const reducers of [undefined, null, []])
        expect(compiledType(arrayOf(simpleIr(kind), reducers))).toEqual({ kind: 'array', element: { kind } });

      expect(compiledType(structOf([['a', simpleIr(kind)]]))).toEqual({
        kind: 'struct',
        fields: new Map([['a', { kind }]]),
      });
    }

    fc.assert(
      fc.property(accepted, ({ ir, compiled }) => {
        const type = compiledType(ir);

        expect(type).toEqual(compiled);

        const actualFields = type?.kind === 'struct' ? [...type.fields.keys()] : [];
        const expectedFields = compiled.kind === 'struct' ? [...compiled.fields.keys()] : [];

        expect(actualFields).toEqual(expectedFields);
      }),
      RUNS,
    );
  });

  it('ontology/object-link-types/properties#out-of-scope: compile refuses a Property of a type outside V1, and names the Property, the type, and the feature', () => {
    forEachOutside(({ ir, named }) => expectNamed(ir, `${OWNER} has the type ${named}, which V1 does not have.`));
  });

  it('ontology/object-link-types/properties#arrays: compile refuses an array of a type outside V1, and names the type and the base types of an array', () => {
    forEachOutside(({ ir, named }) => expectNamed(arrayOf(ir), `${OWNER} is an array of ${named}.`, ARRAY_RULE));
  });

  it('ontology/object-link-types/properties#structs ontology/object-link-types/properties#out-of-scope: compile refuses a struct field of a type outside the field types, and names the field, the type, and the field types', () => {
    fc.assert(
      fc.property(fc.tuple(fieldName, simple), otherTag, ([name, before], other) => {
        const inner = name === 'odd' ? 'odd2' : 'odd';

        for (const { ir, named } of [...OUTSIDE, other]) {
          expectNamed(
            structOf([
              [name, before.ir],
              [inner, ir],
            ]),
            `The struct field ${inner} of ${OWNER} has the type ${named}.`,
            STRUCT_FIELD_RULE,
          );
        }
      }),
      { ...RUNS, numRuns: 20 },
    );
  });

  it('ontology/object-link-types/properties#structs: compile refuses a Decimal struct field with no precision, no scale, or a precision over 38, with the rule of a Decimal Property', () => {
    const field = (decimal: object) => structOf([['unitPrice', { type: 'decimal', decimal }]]);

    expect(compiledType(field({ precision: 38, scale: 4 }))).toEqual({
      kind: 'struct',
      fields: new Map([['unitPrice', { kind: 'decimal', precision: 38, scale: 4 }]]),
    });

    for (const [decimal, named] of [
      [{ scale: 4 }, 'the precision undefined'],
      [{ precision: 12 }, 'the scale undefined'],
      [{ precision: 39, scale: 4 }, 'the precision 39'],
    ] as const) {
      expectNamed(field(decimal), `The struct field unitPrice of ${OWNER} has ${named}.`, DECIMAL_RULE);
    }
  });

  it('ontology/object-link-types/properties#arrays ontology/object-link-types/properties#structs ontology/object-link-types/properties#out-of-scope: compile refuses an array of an array or a struct, and a struct field that is an array or a struct', () => {
    fc.assert(
      fc.property(array, struct, fieldName, (arrayType, structType, name) => {
        expectNamed(arrayOf(arrayType.ir), `${OWNER} is an array of arrays. An array never holds an array.`);

        expectNamed(
          arrayOf(structType.ir),
          `${OWNER} is an array of structs, which V1 does not have. A struct Property is never an array.`,
        );

        expectNamed(
          structOf([[name, arrayType.ir]]),
          `The struct field ${name} of ${OWNER} is an array. A struct field is never a struct or an array.`,
        );

        expectNamed(
          structOf([[name, structType.ir]]),
          `The struct field ${name} of ${OWNER} is a struct. A struct field is never a struct or an array.`,
        );
      }),
      RUNS,
    );
  });

  it('ontology/object-link-types/properties#structs: compile refuses a struct with no field, and a struct with 2 fields of 1 API name', () => {
    expectNamed(structOf([]), `${OWNER} is a struct with no field. A struct has at least 1 field.`);

    fc.assert(
      fc.property(fieldName, simple, simple, (name, first, second) =>
        expectNamed(
          structOf([
            [name, first.ir],
            [name, second.ir],
          ]),
          `2 fields of ${OWNER} have the API name ${name}. A struct field API name is unique within its struct.`,
        ),
      ),
      RUNS,
    );
  });

  it('ontology/object-link-types/properties#base-types: a Decimal declares a precision of 1 to 38 and a scale of 0 or more, and a refusal names the value', () => {
    const rule = 'A Decimal Property declares a precision of 38 or less and a scale.';
    const decimalOf = (precision: unknown, scale: unknown) => ({ type: 'decimal', decimal: { precision, scale } });
    const precisions = fc.integer({ min: 1, max: 38 });
    const scales = fc.integer({ min: 0, max: 38 });

    for (const [precision, scale] of [
      [1, 0],
      [38, 0],
      [38, 38],
    ] as const)
      expect(compiledType(decimalOf(precision, scale))).toEqual({ kind: 'decimal', precision, scale });

    const badPrecisions = [0, -1, 39, 10.5, undefined, null, '10'];
    const badScales = [-1, 2.5, undefined, null, '2'];

    fc.assert(
      fc.property(
        precisions,
        scales,
        fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: 39 })),
        fc.integer({ max: -1 }),
        (precision, scale, badPrecision, badScale) => {
          expect(compiledType(decimalOf(precision, scale))).toEqual({ kind: 'decimal', precision, scale });

          for (const bad of [...badPrecisions, badPrecision])
            expectNamed(decimalOf(bad, scale), `${OWNER} has the precision ${String(bad)}. ${rule}`);

          for (const bad of [...badScales, badScale])
            expectNamed(decimalOf(precision, bad), `${OWNER} has the scale ${String(bad)}. ${rule}`);
        },
      ),
      { ...RUNS, numRuns: 30 },
    );
  });

  it('ontology/object-link-types/properties#out-of-scope: compile refuses analyzerOverride on each String, and names the String; a String with no analyzerOverride compiles', () => {
    const refusal = 'has an analyzerOverride. V1 has only the default analyzer.';

    const withAnalyzer = (analyzerOverride: unknown) => ({
      type: 'string',
      string: { ...STRING_FLAGS, analyzerOverride },
    });

    for (const analyzerOverride of [
      { type: 'standardAnalyzer', standardAnalyzer: {} },
      { type: 'languageAnalyzer', languageAnalyzer: {} },
      {},
    ]) {
      const string = withAnalyzer(analyzerOverride);

      expectNamed(string, `${OWNER} ${refusal}`);

      expectNamed({ ...string, array: {} }, `${OWNER} ${refusal}`);

      expectNamed(arrayOf(string), `${OWNER} ${refusal}`);

      expectNamed(structOf([['street', string]]), `The struct field street of ${OWNER} ${refusal}`);
    }

    for (const none of [undefined, null]) {
      expect(compiledType(withAnalyzer(none))).toEqual({ kind: 'string' });
      expect(compiledType(arrayOf(withAnalyzer(none)))).toEqual({ kind: 'array', element: { kind: 'string' } });

      expect(compiledType(structOf([['street', withAnalyzer(none)]]))).toEqual({
        kind: 'struct',
        fields: new Map([['street', { kind: 'string' }]]),
      });
    }
  });

  it('ontology/object-link-types/properties#out-of-scope: compile refuses an array with a property reducer, and names the reducers', () => {
    const reducers = fc.array(
      fc.record({ direction: fc.constantFrom('ASCENDING_NULLS_LAST', 'DESCENDING_NULLS_FIRST') }),
      { minLength: 1, maxLength: 3 },
    );

    fc.assert(
      fc.property(reducers, decimal, (list, { ir: decimalIr }) => {
        for (const element of [...SIMPLE_KINDS.map(simpleIr), decimalIr])
          expectNamed(arrayOf(element, list), `${OWNER} has property reducers, which V1 does not have.`);
      }),
      { ...RUNS, numRuns: 30 },
    );
  });

  it('compile is total on Property types near a valid one: a tag that is not a string is a refusal of the type, a field that compile reads gives a shape error that names it, and each other change gives a type or a CompileError', () => {
    const junk = fc
      .oneof(fc.jsonValue({ maxDepth: 2 }), fc.constant(undefined))
      .filter((value) => typeof value !== 'string' || !V1_TAGS.has(value));

    const bases = [
      ...OUTSIDE.map(({ ir }) => ir),
      ...SIMPLE_KINDS.map(simpleIr),
      { type: 'decimal', decimal: { precision: 10, scale: 2 } },
      arrayOf(simpleIr('string')),
      arrayOf({ type: 'decimal', decimal: { precision: 10, scale: 2 } }),
      arrayOf({ type: 'marking', marking: { markingType: 'CBAC' } }),
      structOf([
        ['a', simpleIr('string')],
        ['b', simpleIr('date')],
      ]),
    ];

    fc.assert(
      fc.property(junk, (value) => {
        for (const base of bases)
          for (let index = 0; index < slotCount(base); index += 1) expectNear(corrupt(base, index, value), value);
      }),
      { ...RUNS, numRuns: 10 },
    );

    fc.assert(
      fc.property(fc.oneof(accepted, outside), fc.nat(), junk, ({ ir }, index, value) =>
        expectNear(corrupt(ir, index, value), value),
      ),
      RUNS,
    );
  });
});

function expectNear(
  { ir, keys, before }: { ir: unknown; keys: readonly string[]; before: unknown },
  value: unknown,
): void {
  let message: string | undefined;

  try {
    compiledType(ir);
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError);

    message = (error as CompileError).message;
  }

  const changed = [TYPE_PATH, ...keys].join('.');
  const notString = typeof value !== 'string';

  if (keys.length === 1 && keys[0] === 'type' && notString) expect(message).toBe(`${OWNER} has no base type.`);
  else if ((keys.at(-1) === 'type' || keys.at(-1) === 'apiName') && notString)
    expect(message).toBe(`The IR field ${changed} is not a string.`);
  else if (isBody(keys, before) && (value === null || typeof value !== 'object'))
    expect(message).toBe(`The IR field ${changed} is not an object.`);

  const shapeField = message?.startsWith('The IR field ')
    ? message.slice('The IR field '.length).split(' is ')[0]
    : undefined;

  if (shapeField !== undefined) expect(shapeField === changed || shapeField.startsWith(`${changed}.`)).toBe(true);
}

const READ_BODIES: Readonly<Record<string, readonly string[]>> = {
  type: ['array', 'struct', 'string', 'decimal', 'marking'],
  subtype: ['string', 'decimal', 'marking'],
  fieldType: ['string', 'marking'],
};

function isBody(keys: readonly string[], before: unknown): boolean {
  if (before === null || typeof before !== 'object' || Array.isArray(before)) return false;

  const key = keys.at(-1) ?? '';
  const place = keys.length === 1 ? 'type' : (keys.at(-2) ?? '');

  return (
    key === 'subtype' || key === 'fieldType' || place === 'structFields' || (READ_BODIES[place]?.includes(key) ?? false)
  );
}

function slotCount(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;

  return Object.values(value).reduce((count: number, child) => count + 1 + slotCount(child), 0);
}

function corrupt(
  value: unknown,
  index: number,
  junk: unknown,
): { ir: unknown; keys: readonly string[]; before: unknown } {
  const ir = structuredClone(value);
  const slots: [Record<string, unknown>, string[]][] = [];

  const walk = (node: unknown, keys: string[]) => {
    if (node === null || typeof node !== 'object') return;

    for (const [key, child] of Object.entries(node)) {
      slots.push([node as Record<string, unknown>, [...keys, key]]);

      walk(child, [...keys, key]);
    }
  };

  walk(ir, []);

  const [parent, keys] = slots[index % slots.length] as [Record<string, unknown>, string[]];
  const before = parent[keys.at(-1) as string];

  parent[keys.at(-1) as string] = junk;

  return { ir, keys, before };
}
