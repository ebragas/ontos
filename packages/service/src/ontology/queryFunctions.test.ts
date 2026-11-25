import { describe, expect, it } from 'vitest';
import { type CompiledFunction, type StoredOntologyVersion } from './index.ts';
import type { DiscoveredDataType, DiscoveredFunction } from '../publish/index.ts';
import { compileOrThrow, expectRefused, NS, stored, twinFunctions, twinIr } from './stored.test-utils.ts';

const ACCOUNT = `${NS}Account`;

const CLIENT_INPUT = { name: 'client', dataType: { type: 'client', client: {} } };

function returning(
  functionName: string,
  output: DiscoveredFunction['output'],
  customTypes: Record<string, unknown> = {},
): DiscoveredFunction {
  return { locator: { type: 'typescript', typescript: { functionName } }, inputs: [CLIENT_INPUT], output, customTypes };
}

const single = (dataType: DiscoveredDataType): DiscoveredFunction['output'] => ({
  type: 'single',
  single: { dataType },
});

function withFunctions(...functions: DiscoveredFunction[]): StoredOntologyVersion {
  const twin = twinFunctions('0.4.0');

  return stored(twinIr('0.4.0'), { functions: { ...twin, discovered: [...twin.discovered, ...functions] } });
}

function compiled(fn: DiscoveredFunction): CompiledFunction | undefined {
  return compileOrThrow(withFunctions(fn)).functions.get(fn.locator.typescript?.functionName ?? '');
}

describe('the kind of a Function', () => {
  it('ontology/functions/query-functions#code: a list of ontologyEdit compiles as an edit Function, and each other output as a Query Function, with no kind field in the discovered shape', () => {
    const functions = compileOrThrow(
      withFunctions(returning('label', single({ type: 'string', string: {} }))),
    ).functions;

    expect(functions.get('closeAccount')?.kind).toBe('edit');
    expect(functions.get('label')?.kind).toBe('query');
  });
});

const string = { type: 'string', string: {} };
const date = { type: 'date', date: {} };
const decimal = { type: 'decimal', decimal: {} };
const integer = { type: 'integer', integer: {} };
const account = { type: 'object', object: { objectTypeId: ACCOUNT } };
const list = (elementsType: object) => ({ type: 'list', list: { elementsType } });
const optional = (wrappedType: object) => ({ type: 'optionalType', optionalType: { wrappedType } });
const struct = (fields: Record<string, object>) => ({ type: 'anonymousCustomType', anonymousCustomType: { fields } });

const fieldsOf = (fields: Record<string, [unknown, boolean?]>) => ({
  kind: 'struct',
  fields: new Map(Object.entries(fields).map(([name, [type, opt]]) => [name, { type, optional: opt ?? false }])),
});

describe('the output of a Query Function', () => {
  const outputs: [string, object, unknown, boolean][] = [
    ['String', string, { kind: 'string' }, false],
    ['Boolean', { type: 'boolean', boolean: {} }, { kind: 'boolean' }, false],
    ['Integer', integer, { kind: 'integer' }, false],
    ['Double', { type: 'double', double: {} }, { kind: 'double' }, false],
    ['Date', date, { kind: 'date' }, false],
    ['Timestamp', { type: 'timestamp', timestamp: {} }, { kind: 'timestamp' }, false],
    ['Decimal', decimal, { kind: 'decimal' }, false],
    ['an Object', account, { kind: 'object', objectType: ACCOUNT }, false],
    [
      'a struct with an optional field',
      struct({ label: string, note: optional(string) }),
      fieldsOf({ label: [{ kind: 'string' }], note: [{ kind: 'string' }, true] }),
      false,
    ],
    ['a list', list(string), { kind: 'list', element: { kind: 'string' } }, false],
    [
      'a list of structs',
      list(struct({ label: string })),
      { kind: 'list', element: fieldsOf({ label: [{ kind: 'string' }] }) },
      false,
    ],
    [
      'a struct with a list',
      struct({ labels: list(string) }),
      fieldsOf({ labels: [{ kind: 'list', element: { kind: 'string' } }] }),
      false,
    ],
    ['T | undefined', optional(integer), { kind: 'integer' }, true],
  ];

  it.each(outputs)(
    'ontology/functions/query-functions#outputs: compiles the output %s',
    (_name, dataType, type, isOptional) => {
      const fn = compiled(returning('answer', single(dataType as DiscoveredDataType)));

      expect(fn?.kind === 'query' ? fn.output : fn).toEqual({ type, optional: isOptional });
    },
  );

  it('ontology/functions/query-functions#outputs: a struct of a functionCustomType takes its fields from customTypes', () => {
    const customTypes = { Row: { fields: { label: string, note: optional(string) } } };

    const fn = compiled(
      returning('answer', single({ type: 'functionCustomType', functionCustomType: 'Row' }), customTypes),
    );

    expect(fn?.kind === 'query' ? fn.output.type : fn).toEqual(
      fieldsOf({ label: [{ kind: 'string' }], note: [{ kind: 'string' }, true] }),
    );
  });
});

describe('the 7 output shapes ', () => {
  const decimalType = { kind: 'decimal' };
  const dateType = { kind: 'date' };
  const point = struct({ date, debtBalance: decimal, cashOnHand: decimal });

  const shapes: [string, object, unknown, boolean][] = [
    [
      'a list of structs with Decimal and Date fields (scenario comparison)',
      list(struct({ days: integer, cashHeld: decimal, interestPerMonth: decimal, runwayDate: date })),
      {
        kind: 'list',
        element: fieldsOf({
          days: [{ kind: 'integer' }],
          cashHeld: [decimalType],
          interestPerMonth: [decimalType],
          runwayDate: [dateType],
        }),
      },
      false,
    ],
    [
      'a struct (order comparison)',
      struct({ payoffMonth: date, totalInterest: decimal, requiredCashPerMonth: decimal }),
      fieldsOf({ payoffMonth: [dateType], totalInterest: [decimalType], requiredCashPerMonth: [decimalType] }),
      false,
    ],
    [
      'a struct of lists of structs (scenario chart)',
      struct({ days30: list(point), days60: list(point), days90: list(point) }),
      fieldsOf(
        Object.fromEntries(
          ['days30', 'days60', 'days90'].map((name) => [
            name,
            [
              {
                kind: 'list',
                element: fieldsOf({ date: [dateType], debtBalance: [decimalType], cashOnHand: [decimalType] }),
              },
            ],
          ]),
        ),
      ),
      false,
    ],
    [
      'a list of structs with an Object field (required payments)',
      list(struct({ account, dueDate: date, amount: decimal })),
      {
        kind: 'list',
        element: fieldsOf({
          account: [{ kind: 'object', objectType: ACCOUNT }],
          dueDate: [dateType],
          amount: [decimalType],
        }),
      },
      false,
    ],
    [
      'a struct with Decimals and a list (feed Account check)',
      struct({ mismatch: decimal, unexplained: decimal, staleEntries: list(string) }),
      fieldsOf({
        mismatch: [decimalType],
        unexplained: [decimalType],
        staleEntries: [{ kind: 'list', element: { kind: 'string' } }],
      }),
      false,
    ],
    ['an Object (classification suggestion)', account, { kind: 'object', objectType: ACCOUNT }, false],
    ['Decimal | undefined (amount left)', optional(decimal), decimalType, true],
  ];

  it.each(shapes)('ontology/functions/query-functions#outputs: compiles %s', (_name, dataType, type, isOptional) => {
    const fn = compiled(returning('answer', single(dataType as DiscoveredDataType)));

    expect(fn?.kind === 'query' ? fn.output : fn).toEqual({ type, optional: isOptional });
  });
});

describe('the outputs that a Query Function does not have', () => {
  const refused: [string, DiscoveredFunction['output'], string][] = [
    ['void', { type: 'void', void: {} }, 'void'],
    ['an Object Set', single({ type: 'objectSet', objectSet: { objectTypeId: ACCOUNT } }), 'objectSet'],
    ['a Map', single({ type: 'map', map: { keyType: string, valueType: string } }), 'map'],
    ['a Set', single({ type: 'set', set: { elementsType: string } }), 'set'],
    ['a Long', single({ type: 'long', long: {} }), 'long'],
    ['a Float', single({ type: 'float', float: {} }), 'float'],
    ['an Interface', single({ type: 'interface', interface: { interfaceTypeId: `${NS}Party` } }), 'interface'],
    ['another union', single({ type: 'union', union: { unionTypes: [string, integer] } }), 'union'],
    ['a Long in a list', single(list({ type: 'long', long: {} })), 'long'],
    ['an optional element of a list', single(list(optional(string))), 'optionalType'],
  ];

  it.each(refused)(
    'ontology/functions/query-functions#outputs: refuses the output %s, and the text names the type and the Function',
    (_name, output, type) => {
      expectRefused(
        withFunctions(returning('answer', output)),
        `Function answer has the output type ${type}, which a Query Function does not have.`,
      );
    },
  );

  it('ontology/functions/query-functions#outputs: refuses an Object of an Object Type that the Ontology does not have', () => {
    expectRefused(
      withFunctions(returning('answer', single({ type: 'object', object: { objectTypeId: `${NS}Nothing` } }))),
      'Function answer',
      `${NS}Nothing`,
    );
  });
});

describe('a Function rule', () => {
  it('ontology/functions/functions#function-backed-actions: a Function rule that names a Query Function gets CompileError, because a function-backed Action runs an edit Function', () => {
    const twin = twinFunctions('0.4.0');
    const query = twin.discovered.map((fn) => ({ ...fn, output: single(string) }));

    expectRefused(
      stored(twinIr('0.4.0'), { functions: { ...twin, discovered: query } }),
      `Action Type ${NS}close-account-action has a Function rule for closeAccount, which returns a value. A function-backed Action runs an edit Function, which returns a list of edits.`,
    );
  });
});
