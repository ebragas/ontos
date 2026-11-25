import type { OntologyIr } from '@osdk/client.unstable';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertObjects, startActions, type ActionsService, type ObjectRow } from '../actions/actions.test-utils.ts';
import { groupGrants, policyPeople } from '../policiesPeople.test-utils.ts';
import {
  ACCOUNT,
  addString,
  addTyped,
  at,
  CATEGORY,
  datasourceOf,
  derivedIr,
  ENGAGEMENT,
  INVOICE,
  type Json,
  ONTOLOGY,
  ROLES,
  TRANSACTION,
} from './derived.test-utils.ts';
import {
  reference,
  typeOf,
  type Dataset,
  type Definition,
  type Expected,
  type Hidden,
  type Layers,
  type Model,
  type Observer,
  type Operation,
  type Query,
  type ResultType,
  type Row,
  type Scope,
  type ValueType,
} from './derivedReference.test-utils.ts';

const OPERATIONS = 'ontology/object-link-types/derived-properties#operations';
const TYPES_SECTION = 'ontology/object-link-types/derived-properties#types';

const RUNS = { seed: 20261120, numRuns: 60, endOnFailure: true } as const;

const STRING: ValueType = { kind: 'string' };
const INTEGER: ValueType = { kind: 'integer' };
const DOUBLE: ValueType = { kind: 'double' };
const DATE: ValueType = { kind: 'date' };
const TIMESTAMP: ValueType = { kind: 'timestamp' };
const decimal = (scale: number): ValueType => ({ kind: 'decimal', scale });

const MODEL: Model = {
  [ACCOUNT]: {
    key: 'accountId',
    properties: {
      accountId: STRING,
      name: STRING,
      status: STRING,
      credit: decimal(3),
      level: INTEGER,
      score: DOUBLE,
      openedOn: DATE,
    },
    links: {
      transactions: { target: TRANSACTION, many: true, from: 'accountId', to: 'accountId' },
      engagements: { target: ENGAGEMENT, many: true, from: 'accountId', to: 'accountId' },
    },
  },
  [TRANSACTION]: {
    key: 'transactionId',
    properties: {
      transactionId: STRING,
      accountId: STRING,
      categoryId: STRING,
      amount: decimal(2),
      units: INTEGER,
      rate: DOUBLE,
      fee: decimal(1),
      postedOn: DATE,
      postedAt: TIMESTAMP,
      status: STRING,
      owner: STRING,
      amountViewer: STRING,
    },
    links: {
      account: { target: ACCOUNT, many: false, from: 'accountId', to: 'accountId' },
      category: { target: CATEGORY, many: false, from: 'categoryId', to: 'categoryId' },
    },
  },
  [CATEGORY]: {
    key: 'categoryId',
    properties: { categoryId: STRING, name: STRING, budget: decimal(2) },
    links: { transactions: { target: TRANSACTION, many: true, from: 'categoryId', to: 'categoryId' } },
  },
  [ENGAGEMENT]: {
    key: 'engagementId',
    properties: {
      engagementId: STRING,
      accountId: STRING,
      title: STRING,
      status: STRING,
      hours: INTEGER,
      owner: STRING,
    },
    links: {
      account: { target: ACCOUNT, many: false, from: 'accountId', to: 'accountId' },
      invoices: { target: INVOICE, many: true, from: 'engagementId', to: 'engagementId' },
    },
  },
  [INVOICE]: {
    key: 'invoiceId',
    properties: { invoiceId: STRING, engagementId: STRING, total: decimal(2), status: STRING },
    links: { engagement: { target: ENGAGEMENT, many: false, from: 'engagementId', to: 'engagementId' } },
  },
};

const FOREIGN_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [TRANSACTION]: { accountId: ACCOUNT, categoryId: CATEGORY },
  [ENGAGEMENT]: { accountId: ACCOUNT },
  [INVOICE]: { engagementId: ENGAGEMENT },
};

function differentialIr(): OntologyIr {
  const ir: Json = JSON.parse(JSON.stringify(derivedIr()));
  const block = (objectType: string) => at(ir, 'ontology', 'objectTypes', objectType);

  const column = (objectType: string, apiName: string, type: ValueType, template: string) => {
    const irType =
      type.kind === 'decimal'
        ? { type: 'decimal', decimal: { precision: 12 + type.scale, scale: type.scale } }
        : { type: type.kind, [type.kind]: {} };

    addTyped(block(objectType), apiName, irType, at(block(objectType), 'objectType', 'propertyTypes', template));

    at(datasourceOf(block(objectType), 'datasetV2'), 'propertyMapping')[apiName] = { type: 'column', column: apiName };
  };

  const groups = (objectType: string) =>
    at(datasourceOf(block(objectType), 'datasetV2'), 'propertySecurityGroups')['groups'] as Json[];

  const secure = (objectType: string, index: number, ...names: string[]) => {
    const group = groups(objectType)[index];

    if (!group) throw new Error(`The derived IR has no policy group ${index} on ${objectType}.`);

    (group['properties'] as string[]).push(...names);
  };

  addString(block(ACCOUNT), 'status');

  column(ACCOUNT, 'credit', decimal(3), 'name');

  column(ACCOUNT, 'level', INTEGER, 'name');

  column(ACCOUNT, 'score', DOUBLE, 'name');

  column(ACCOUNT, 'openedOn', DATE, 'name');

  addString(block(TRANSACTION), 'status');

  column(TRANSACTION, 'rate', DOUBLE, 'amount');

  column(TRANSACTION, 'fee', decimal(1), 'amount');

  secure(TRANSACTION, 0, 'status', 'fee');

  secure(TRANSACTION, 1, 'rate');

  column(CATEGORY, 'budget', decimal(2), 'name');

  addString(block(ENGAGEMENT), 'status');

  column(ENGAGEMENT, 'hours', INTEGER, 'title');

  secure(ENGAGEMENT, 0, 'status', 'hours');

  addString(block(INVOICE), 'status');

  return JSON.parse(JSON.stringify(ir)) as OntologyIr;
}

const IR = differentialIr();

const READERS = {
  admin: { sub: 'user_one', role: 'admin' },
  two: { sub: 'user_two', role: 'member' },
  three: { sub: 'user_three', role: 'member' },
} as const;

type Reader = keyof typeof READERS;

const PEOPLE = policyPeople(READERS, ROLES);

function hiddenOf(data: Dataset, reader: Reader): Hidden {
  const objects = new Set<string>();
  const values = new Set<string>();
  const sub = READERS[reader].sub;
  const admin = reader === 'admin';

  for (const objectType of [TRANSACTION, ENGAGEMENT]) {
    const key = MODEL[objectType]?.key ?? '';

    for (const row of data[objectType] ?? [])
      if (row['owner'] === null || (!admin && row['owner'] !== sub)) objects.add(`${objectType}/${String(row[key])}`);
  }

  for (const row of data[TRANSACTION] ?? []) {
    if (!admin && row['amountViewer'] !== sub)
      for (const property of ['amount', 'rate'])
        values.add(`${TRANSACTION}/${String(row['transactionId'])}/${property}`);
  }

  return { objects, values };
}

const WORDS = ['alpha', 'beta', 'gamma'];
const PEOPLE_IDS = ['user_two', 'user_three', 'user_x'];
const OWNERS = ['user_two', 'user_three', 'user_two', 'user_three', 'user_x'];

const integers = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: -3, max: 9 }) },
  { weight: 1, arbitrary: fc.constantFrom(2_147_483_647, -2_147_483_648, 46_341, 65_536) },
);

const doubles = fc.oneof(
  fc.integer({ min: -40, max: 40 }).map((n) => n / 4),
  fc.constantFrom(0.1, 1_000_000.5),
);

const decimals = (scale: number) =>
  fc
    .oneof(
      { weight: 4, arbitrary: fc.integer({ min: -30, max: 30 }) },
      { weight: 1, arbitrary: fc.integer({ min: -99_999_999, max: 99_999_999 }) },
    )
    .map((units) => {
      const digits = String(Math.abs(units)).padStart(scale + 1, '0');

      return `${units < 0 ? '-' : ''}${digits.slice(0, digits.length - scale)}${scale > 0 ? `.${digits.slice(digits.length - scale)}` : ''}`;
    });

const dates = fc.constantFrom('2025-12-31', '2026-01-31', '2026-02-15', '2026-04-01', '2026-11-30');

const timestamps = fc.constantFrom(
  '2025-12-31T23:59:59Z',
  '2026-01-01T00:00:00Z',
  '2026-03-31T23:30:00Z',
  '2026-07-04T12:00:00Z',
);

const LARGE_AMOUNTS = ['45035996273704.97', '90071992547409.93', '-45035996273704.96'];

function valuesOf(property: string, type: ValueType): fc.Arbitrary<string | number> {
  if (property === 'amount')
    return fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...LARGE_AMOUNTS) }, { weight: 2, arbitrary: decimals(2) });

  if (property === 'owner') return fc.constantFrom(...OWNERS);

  switch (type.kind) {
    case 'string':
      return fc.constantFrom(...(property === 'amountViewer' ? PEOPLE_IDS : WORDS));
    case 'integer':
      return integers;
    case 'double':
      return doubles;
    case 'decimal':
      return decimals(type.scale);
    case 'date':
      return dates;
    case 'timestamp':
      return timestamps;
  }
}

const PREFIX: Readonly<Record<string, string>> = {
  [ACCOUNT]: 'a',
  [TRANSACTION]: 't',
  [CATEGORY]: 'c',
  [ENGAGEMENT]: 'e',
  [INVOICE]: 'i',
};

const MOST: Readonly<Record<string, number>> = {
  [ACCOUNT]: 3,
  [TRANSACTION]: 6,
  [CATEGORY]: 2,
  [ENGAGEMENT]: 3,
  [INVOICE]: 3,
};

const TYPES = Object.keys(MODEL);

const idsOf = (objectType: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${PREFIX[objectType] ?? ''}${index + 1}`);

function rowsOf(objectType: string, counts: Readonly<Record<string, number>>): fc.Arbitrary<Row[]> {
  const model = MODEL[objectType];

  if (!model) throw new Error(`No model for ${objectType}.`);

  const row = (id: string) =>
    fc.record(
      Object.fromEntries(
        Object.entries(model.properties).map(([property, type]) => {
          if (property === model.key) return [property, fc.constant(id)];

          const target = FOREIGN_KEYS[objectType]?.[property];
          const pool = target ? idsOf(target, counts[target] ?? 0) : undefined;

          if (pool)
            return [
              property,
              pool.length === 0 ? fc.constant(null) : fc.option(fc.constantFrom(...pool), { nil: null, freq: 6 }),
            ];

          return [
            property,
            fc.option(valuesOf(property, type), { nil: null, freq: SELDOM_NULL.has(type.kind) ? 12 : 4 }),
          ];
        }),
      ),
    );

  return fc.tuple(...idsOf(objectType, counts[objectType] ?? 0).map(row));
}

const SELDOM_NULL: ReadonlySet<string> = new Set(['decimal', 'date', 'timestamp']);

const datasets: fc.Arbitrary<Dataset> = fc
  .record(
    Object.fromEntries(TYPES.map((objectType) => [objectType, fc.integer({ min: 1, max: MOST[objectType] ?? 1 })])),
  )
  .chain((counts) =>
    fc.record(Object.fromEntries(TYPES.map((objectType) => [objectType, rowsOf(objectType, counts)]))),
  );

function queriesOf(objectType: string, depth: number): fc.Arbitrary<Query> {
  const properties = Object.entries(MODEL[objectType]?.properties ?? {});

  const atom = fc.constantFrom(...properties).chain(([field, type]): fc.Arbitrary<Query> => {
    const value = valuesOf(field, type);

    return fc.oneof(
      fc.record({ type: fc.constantFrom('eq', 'gt', 'gte', 'lt', 'lte'), field: fc.constant(field), value }),
      fc.record({ type: fc.constant('isNull'), field: fc.constant(field), value: fc.boolean() }),
      fc.record({ type: fc.constant('in'), field: fc.constant(field), value: fc.array(value, { maxLength: 2 }) }),
    );
  });

  if (depth === 0) return atom;

  const nested = queriesOf(objectType, depth - 1);

  return fc.oneof(
    { weight: 3, arbitrary: atom },
    { weight: 1, arbitrary: nested.map((value): Query => ({ type: 'not', value })) },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constantFrom('and', 'or'),
        value: fc.array(nested, { minLength: 1, maxLength: 2 }),
      }),
    },
  );
}

const maybeFilter = (objectType: string) => fc.option(queriesOf(objectType, 1), { nil: undefined, freq: 2 });

type Hop = {
  readonly link: string;
  readonly target: string;
  readonly many: boolean;
  readonly where: Query | undefined;
};

function hopsFrom(objectType: string, most: number): fc.Arbitrary<Hop[]> {
  const links = Object.entries(MODEL[objectType]?.links ?? {});

  return fc.constantFrom(...links).chain(([link, side]) =>
    fc
      .record({
        where: maybeFilter(side.target),
        rest: most > 1 ? fc.oneof(fc.constant([]), hopsFrom(side.target, most - 1)) : fc.constant([]),
      })
      .map(({ where, rest }) => [{ link, target: side.target, many: side.many, where }, ...rest]),
  );
}

function operationsOf(objectType: string, oneObject: boolean): fc.Arbitrary<Operation> {
  const properties = Object.entries(MODEL[objectType]?.properties ?? {});

  const named = (test: (type: ValueType) => boolean) =>
    properties.filter(([, type]) => test(type)).map(([name]) => name);

  const decimals = named((type) => type.kind === 'decimal');

  const numericProperties = fc.constantFrom(
    ...named((type) => type.kind === 'integer' || type.kind === 'double' || type.kind === 'decimal'),
    ...decimals,
  );

  const orderedProperties = fc.constantFrom(...named((type) => type.kind !== 'string'), ...decimals);
  const anyProperty = fc.constantFrom(...named(() => true));
  const limit = fc.integer({ min: 1, max: 4 });

  const choices: fc.Arbitrary<Operation>[] = [
    fc.constant({ type: 'count' }),
    ...(['sum', 'avg'] as const).map((type) =>
      fc.record({ type: fc.constant(type), selectedPropertyApiName: numericProperties }),
    ),
    ...(['min', 'max'] as const).map((type) =>
      fc.record({ type: fc.constant(type), selectedPropertyApiName: orderedProperties }),
    ),
    ...(['exactDistinct', 'approximateDistinct'] as const).map((type) =>
      fc.record({ type: fc.constant(type), selectedPropertyApiName: anyProperty }),
    ),
    fc.record({
      type: fc.constant('approximatePercentile'),
      selectedPropertyApiName: numericProperties,
      approximatePercentile: fc.constantFrom(0, 0.25, 0.5, 0.9, 1),
    }),
    ...(['collectList', 'collectList', 'collectSet', 'collectSet'] as const).map((type) =>
      fc.record({ type: fc.constant(type), selectedPropertyApiName: anyProperty, limit }),
    ),
  ];

  if (oneObject)
    choices.push(
      ...Array.from({ length: 4 }, () => fc.record({ type: fc.constant('get'), selectedPropertyApiName: anyProperty })),
    );

  return fc.oneof(...choices);
}

function selectionsOf(root: string): fc.Arbitrary<Definition> {
  return fc.record({ input: maybeFilter(root), hops: hopsFrom(root, 3) }).chain(({ input, hops }) => {
    const last = hops.at(-1);

    if (!last) throw new Error('A selection has at least 1 hop.');

    return operationsOf(
      last.target,
      hops.every((hop) => !hop.many),
    ).map((operation): Definition => {
      let objectSet: Extract<Definition, { type: 'selection' }>['objectSet'] = { type: 'methodInput' };

      if (input) objectSet = { type: 'filter', objectSet, where: input };

      for (const hop of hops) {
        objectSet = { type: 'searchAround', objectSet, link: hop.link };

        if (hop.where) objectSet = { type: 'filter', objectSet, where: hop.where };
      }

      return { type: 'selection', objectSet, operation };
    });
  });
}

const scalar = (type: ResultType | undefined): boolean =>
  type !== undefined && type.kind !== 'array' && type.kind !== 'string';

function definitionsOf(root: string, scope: Scope, depth: number): fc.Arbitrary<Definition> {
  const names = Object.keys(scope);
  const property = fc.constantFrom(...names).map((apiName): Definition => ({ type: 'property', apiName }));

  if (depth === 0) return fc.oneof({ weight: 2, arbitrary: selectionsOf(root) }, { weight: 1, arbitrary: property });

  const operand = definitionsOf(root, scope, depth - 1).filter((definition) =>
    scalar(typeOf(MODEL, root, scope, definition)),
  );

  return fc.oneof(
    { weight: 3, arbitrary: definitionsOf(root, scope, 0) },
    {
      weight: 2,
      arbitrary: fc.record({
        type: fc.constantFrom('add', 'multiply', 'greatest', 'least'),
        properties: fc.array(operand, { minLength: 2, maxLength: 3 }),
      }),
    },
    { weight: 2, arbitrary: fc.record({ type: fc.constantFrom('subtract', 'divide'), left: operand, right: operand }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constantFrom('absoluteValue', 'negate'), property: operand }) },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('extract'),
        property: operand,
        part: fc.constantFrom('DAYS', 'MONTHS', 'QUARTERS', 'YEARS'),
      }),
    },
  );
}

const NUMERIC: ReadonlySet<string> = new Set(['integer', 'double', 'decimal']);
const TEMPORAL: readonly ReadonlySet<string>[] = [new Set(['date']), new Set(['timestamp'])];

function leavesOf(root: string, scope: Scope, kinds: ReadonlySet<string>): Definition[] {
  const leaves: Definition[] = [];

  for (const [apiName, type] of Object.entries(scope))
    if (kinds.has(type.kind))
      leaves.push(
        ...Array.from({ length: type.kind === 'decimal' ? 3 : 1 }, (): Definition => ({ type: 'property', apiName })),
      );

  for (const [link, side] of Object.entries(MODEL[root]?.links ?? {})) {
    for (const [property, type] of Object.entries(MODEL[side.target]?.properties ?? {})) {
      if (!kinds.has(type.kind)) continue;

      const operations: ('get' | 'min' | 'max' | 'sum' | 'avg')[] = side.many ? ['min', 'max'] : ['get'];

      if (side.many && NUMERIC.has(type.kind)) operations.push('sum', 'avg');

      for (const operation of operations)
        leaves.push({
          type: 'selection',
          objectSet: { type: 'searchAround', objectSet: { type: 'methodInput' }, link },
          operation: { type: operation, selectedPropertyApiName: property },
        });
    }
  }

  return leaves;
}

const POOLS: readonly { readonly weight: number; readonly kinds: ReadonlySet<string> }[] = [
  { weight: 3, kinds: new Set(['decimal']) },
  { weight: 3, kinds: new Set(['integer']) },
  { weight: 2, kinds: new Set(['double']) },
  { weight: 2, kinds: new Set(['integer', 'double']) },
  { weight: 2, kinds: NUMERIC },
];

function focusedOf(root: string, scope: Scope, depth: number): fc.Arbitrary<Definition> {
  const choices: fc.WeightedArbitrary<Definition>[] = [];

  for (const { weight, kinds } of POOLS) {
    const leaves = leavesOf(root, scope, kinds);

    if (leaves.length === 0) continue;

    const leaf = fc.constantFrom(...leaves);

    const operand =
      depth === 0
        ? leaf
        : fc.oneof({ weight: 3, arbitrary: leaf }, { weight: 1, arbitrary: focusedOf(root, scope, depth - 1) });

    const list = fc.oneof(
      fc.array(operand, { minLength: 2, maxLength: 2 }),
      fc.array(operand, { minLength: 3, maxLength: 3 }),
    );

    choices.push(
      {
        weight: 4 * weight,
        arbitrary: fc.record({ type: fc.constantFrom('add', 'multiply', 'greatest', 'least'), properties: list }),
      },
      {
        weight: 2 * weight,
        arbitrary: fc.record({ type: fc.constantFrom('subtract', 'divide'), left: operand, right: operand }),
      },
      { weight, arbitrary: fc.record({ type: fc.constantFrom('absoluteValue', 'negate'), property: operand }) },
      {
        weight,
        arbitrary: fc
          .tuple(fc.array(leaf, { minLength: 2, maxLength: 3 }), fc.array(operand, { minLength: 1, maxLength: 2 }))
          .map(([inner, rest]): Definition => ({
            type: 'multiply',
            properties: [{ type: 'multiply', properties: inner }, ...rest],
          })),
      },
    );
  }

  for (const kinds of TEMPORAL) {
    const leaves = leavesOf(root, scope, kinds);

    if (leaves.length === 0) continue;

    const temporal = fc.constantFrom(...leaves);

    choices.push({
      weight: 10,
      arbitrary: fc.record({
        type: fc.constantFrom('greatest', 'least'),
        properties: fc.array(temporal, { minLength: 2, maxLength: 3 }),
      }),
    });

    choices.push({
      weight: 2,
      arbitrary: fc.record({
        type: fc.constant('extract'),
        property: temporal,
        part: fc.constantFrom('DAYS', 'MONTHS', 'QUARTERS', 'YEARS'),
      }),
    });
  }

  return fc.oneof(...choices);
}

const operandsOf = (definition: Definition): readonly Definition[] =>
  'properties' in definition
    ? definition.properties
    : 'left' in definition
      ? [definition.left, definition.right]
      : 'property' in definition
        ? [definition.property]
        : [];

function refusedMix(root: string, scope: Scope, definition: Definition): boolean {
  const operands = operandsOf(definition);
  const types = operands.map((each) => typeOf(MODEL, root, scope, each));
  const kinds = new Set(types.map((type) => type?.kind));

  if (
    operands.length >= 2 &&
    !kinds.has(undefined) &&
    kinds.has('decimal') &&
    kinds.has('integer') &&
    typeOf(MODEL, root, scope, definition) === undefined
  )
    return true;

  return operands.some((each) => refusedMix(root, scope, each));
}

function directOf(root: string): Definition[] {
  return Object.entries(MODEL[root]?.links ?? {}).flatMap(([link, side]) =>
    Object.keys(MODEL[side.target]?.properties ?? {}).flatMap((property): Definition[] => {
      const objectSet = { type: 'searchAround', objectSet: { type: 'methodInput' }, link } as const;

      if (!side.many)
        return [{ type: 'selection', objectSet, operation: { type: 'get', selectedPropertyApiName: property } }];

      return (['collectList', 'collectSet'] as const).map((type): Definition => ({
        type: 'selection',
        objectSet,
        operation: { type, selectedPropertyApiName: property, limit: 3 },
      }));
    }),
  );
}

function layerOf(root: string, scope: Scope, prefix: string): fc.Arbitrary<Record<string, Definition>> {
  const typed = (each: Definition) => typeOf(MODEL, root, scope, each) !== undefined;
  const focused = focusedOf(root, scope, 1);

  const definition = fc.oneof(
    { weight: 10, arbitrary: definitionsOf(root, scope, 2).filter(typed) },
    { weight: 16, arbitrary: focused.filter(typed) },
    { weight: 8, arbitrary: selectionsOf(root) },
    { weight: 3, arbitrary: fc.constantFrom(...directOf(root)) },
    { weight: 1, arbitrary: focused.filter((each) => !typed(each) && refusedMix(root, scope, each)) },
  );

  return fc
    .array(definition, { minLength: 1, maxLength: 3 })
    .map((definitions) => Object.fromEntries(definitions.map((each, index) => [`${prefix}${index}`, each])));
}

function layersOf(root: string): fc.Arbitrary<Layers> {
  const scope = MODEL[root]?.properties ?? {};

  return layerOf(root, scope, 'p').chain((first) => {
    const inner: Record<string, ResultType> = {};

    for (const [name, definition] of Object.entries(first)) {
      const type = typeOf(MODEL, root, scope, definition);

      if (type) inner[name] = type;
    }

    return fc.oneof(
      fc.constant([first]),
      layerOf(root, { ...scope, ...inner }, 'q').map((second) => [first, second]),
    );
  });
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(IR, undefined, groupGrants(IR, ROLES));
});

afterAll(() => service?.stop());

async function seed(data: Dataset): Promise<void> {
  await service.clear();

  for (const objectType of TYPES) {
    const rows = (data[objectType] ?? []).map(
      (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as ObjectRow,
    );

    await insertObjects(service.db, objectType, rows);
  }
}

function requestOf(root: string, layers: Layers): object {
  let objectSet: object = { type: 'base', objectType: root };

  for (const derivedProperties of layers) objectSet = { type: 'withProperties', objectSet, derivedProperties };

  return { objectSet, select: [], pageSize: 1000, excludeRid: true };
}

function doublesOf(root: string, layers: Layers): Set<string> {
  const names = new Set<string>();
  const scope: Record<string, ResultType> = { ...MODEL[root]?.properties };

  for (const layer of layers) {
    const types: Record<string, ResultType> = {};

    for (const [name, definition] of Object.entries(layer)) {
      const type = typeOf(MODEL, root, scope, definition);

      if (!type) continue;

      types[name] = type;

      if (type.kind === 'double') names.add(name);
    }

    Object.assign(scope, types);
  }

  return names;
}

const close = (actual: unknown, expected: unknown): boolean =>
  typeof actual === 'number' &&
  typeof expected === 'number' &&
  Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));

function answerOf(
  status: number,
  body: unknown,
  expected: Expected,
  names: readonly string[],
  doubles: ReadonlySet<string>,
): unknown {
  if (status !== 200) return { status, errorName: (body as { errorName?: unknown }).errorName };

  const objects: Record<string, Record<string, unknown>> = {};

  for (const object of (body as { data: Record<string, unknown>[] }).data) {
    const key = String(object['__primaryKey']);
    const want: Readonly<Record<string, unknown>> = expected.status === 200 ? (expected.objects[key] ?? {}) : {};

    objects[key] = Object.fromEntries(
      names
        .filter((name) => name in object)
        .map((name) => [name, doubles.has(name) && close(object[name], want[name]) ? want[name] : object[name]]),
    );
  }

  return { status: 200, objects };
}

const counts = new Map<string, number>();
const bump = (key: string, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by);
const PAST_2_53 = 2n ** 53n;

const keysOf: Observer = (definition, type, value) => {
  if (value === null) return;

  const keys: string[] = [];

  if (definition.type === 'selection') keys.push(`${definition.operation.type} ${type.kind}`);
  else if (definition.type !== 'property') keys.push(`${definition.type} ${type.kind}`);

  if ('properties' in definition && definition.properties.length >= 3) keys.push(`${definition.type} of 3 operands`);

  if (definition.type === 'multiply' && definition.properties.some((each) => each.type === 'multiply'))
    keys.push('multiply in a multiply');

  if (type.kind === 'decimal' && typeof value === 'string' && BigInt(value.replace(/[-.]/g, '')) > PAST_2_53)
    keys.push('Decimal past 2^53');

  for (const key of keys) bump(key);
};

const FLOORS: Readonly<Record<string, number>> = {
  'Decimal past 2^53': 25,
  'absoluteValue decimal': 30,
  'absoluteValue double': 10,
  'absoluteValue integer': 25,
  'add decimal': 15,
  'add double': 10,
  'add integer': 5,
  'add of 3 operands': 15,
  'approximateDistinct integer': 125,
  'approximatePercentile double': 25,
  'avg decimal': 30,
  'avg double': 60,
  'collectList array': 30,
  'collectSet array': 35,
  'count integer': 110,
  'divide decimal': 5,
  'divide double': 35,
  'exactDistinct integer': 95,
  'extract integer': 25,
  'get date': 35,
  'get decimal': 30,
  'get double': 40,
  'get integer': 125,
  'get string': 30,
  'greatest date': 20,
  'greatest decimal': 25,
  'greatest double': 55,
  'greatest integer': 15,
  'greatest of 3 operands': 40,
  'greatest timestamp': 20,
  'least date': 25,
  'least decimal': 30,
  'least double': 65,
  'least integer': 20,
  'least of 3 operands': 65,
  'least timestamp': 5,
  'loads that expect 200': 400,
  'loads that expect Default:InvalidArgument': 10,
  'loads that expect InvalidDerivedPropertyDefinition': 35,
  'loads where a hidden Object in a hop changes the answer': 120,
  'loads where a hidden value changes the answer': 25,
  'max date': 20,
  'max decimal': 25,
  'max double': 10,
  'max integer': 20,
  'max timestamp': 15,
  'min date': 25,
  'min decimal': 20,
  'min double': 10,
  'min integer': 30,
  'min timestamp': 15,
  'multiply decimal': 55,
  'multiply double': 45,
  'multiply in a multiply': 35,
  'multiply integer': 35,
  'multiply of 3 operands': 50,
  'negate decimal': 35,
  'negate double': 5,
  'negate integer': 30,
  'subtract decimal': 15,
  'subtract double': 20,
  'subtract integer': 20,
  'sum decimal': 25,
  'sum double': 45,
  'values present': 740,
};

const shortfalls = (): string[] =>
  Object.entries(FLOORS).flatMap(([key, least]) =>
    (counts.get(key) ?? 0) < least ? [`${key}: ${counts.get(key) ?? 0} < ${least}`] : [],
  );

function countLoad(root: string, data: Dataset, hidden: Hidden, layers: Layers, expected: Expected): void {
  bump(expected.status === 200 ? 'loads that expect 200' : `loads that expect ${expected.errorName}`);

  if (expected.status !== 200) return;

  bump(
    'values present',
    Object.values(expected.objects).reduce((total, object) => total + Object.keys(object).length, 0),
  );

  const answer = JSON.stringify(expected);

  if (JSON.stringify(reference(MODEL, data, { objects: hidden.objects, values: new Set() }, root, layers)) !== answer)
    bump('loads where a hidden value changes the answer');

  const inHops = new Set([...hidden.objects].filter((object) => !object.startsWith(`${root}/`)));

  if (
    JSON.stringify(
      reference(
        MODEL,
        data,
        { objects: new Set([...hidden.objects].filter((object) => !inHops.has(object))), values: hidden.values },
        root,
        layers,
      ),
    ) !== answer
  ) {
    bump('loads where a hidden Object in a hop changes the answer');
  }
}

function within38Digits(root: string, data: Dataset, layers: Layers): boolean {
  let fits = true;

  for (const reader of Object.keys(READERS) as Reader[]) {
    reference(MODEL, data, hiddenOf(data, reader), root, layers, (_, type, value) => {
      if (
        type.kind === 'decimal' &&
        typeof value === 'string' &&
        value.replace(/[-.]/g, '').replace(/^0+/, '').length > 38
      )
        fits = false;
    });
  }

  return fits;
}

async function check(root: string, data: Dataset, layers: Layers): Promise<void> {
  await seed(data);

  const names = layers.flatMap((layer) => Object.keys(layer));
  const doubles = doublesOf(root, layers);
  const request = requestOf(root, layers);

  for (const reader of Object.keys(READERS) as Reader[]) {
    const hidden = hiddenOf(data, reader);
    const observed: Parameters<Observer>[] = [];
    const expected = reference(MODEL, data, hidden, root, layers, (...value) => observed.push(value));

    countLoad(root, data, hidden, layers, expected);

    if (expected.status === 200) for (const value of observed) keysOf(...value);

    const answer = await service.call('POST', `${ONTOLOGY}/objectSets/loadObjects`, request, PEOPLE[reader]);

    const body = JSON.parse(answer.text) as unknown;

    expect(
      answerOf(answer.status, body, expected, names, doubles),
      `reader ${reader}, request ${JSON.stringify(request)}`,
    ).toEqual(expected);
  }
}

describe(`${OPERATIONS}: each request derived value equals the reference, for each reader`, () => {
  it.each(TYPES)(
    `${OPERATIONS}: generated datasets, definitions, and 3 readers on the root %s give the values of the reference`,
    async (root) => {
      const property = fc.asyncProperty(datasets, layersOf(root), (data, layers) => {
        fc.pre(within38Digits(root, data, layers));

        return check(root, data, layers);
      });

      await fc.assert(property, RUNS);
    },
  );

  it(`${OPERATIONS}: the generated cases of the 5 roots reach the floor of each operation, expression, type, and load`, () => {
    console.log(`counts ${JSON.stringify(Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1))))}`);

    expect(shortfalls()).toEqual([]);
  });
});

const ACCOUNT_ROW: Row = {
  accountId: 'a1',
  name: null,
  status: null,
  credit: null,
  level: null,
  score: null,
  openedOn: null,
};

const transaction = (transactionId: string, values: Row): Row => ({
  transactionId,
  accountId: 'a1',
  owner: 'user_two',
  amountViewer: 'user_two',
  ...values,
});

const dataOf = (transactions: readonly Row[]): Dataset => ({
  [ACCOUNT]: [ACCOUNT_ROW],
  [TRANSACTION]: transactions,
  [CATEGORY]: [],
  [ENGAGEMENT]: [],
  [INVOICE]: [],
});

const property = (apiName: string): Definition => ({ type: 'property', apiName });

const overTransactions = (operation: Operation): Definition => ({
  type: 'selection',
  objectSet: { type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'transactions' },
  operation,
});

const FIXED: readonly {
  readonly name: string;
  readonly root: string;
  readonly data: Dataset;
  readonly value: Definition;
  readonly key: string;
  readonly want: string;
}[] = [
  {
    name: 'avg of 0.01 and 0.04 on scale 2: 0.025 rounds half away from zero to "0.03"',
    root: ACCOUNT,
    data: dataOf([transaction('t1', { amount: '0.01' }), transaction('t2', { amount: '0.04' })]),
    value: overTransactions({ type: 'avg', selectedPropertyApiName: 'amount' }),
    key: 'a1',
    want: '0.03',
  },
  {
    name: 'avg of -0.01 and -0.04 on scale 2: -0.025 rounds half away from zero to "-0.03"',
    root: ACCOUNT,
    data: dataOf([transaction('t1', { amount: '-0.01' }), transaction('t2', { amount: '-0.04' })]),
    value: overTransactions({ type: 'avg', selectedPropertyApiName: 'amount' }),
    key: 'a1',
    want: '-0.03',
  },
  {
    name: 'divide of -2.00 by 3: -0.666... rounds to "-0.67"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '-2.00', units: 3 })]),
    value: { type: 'divide', left: property('amount'), right: property('units') },
    key: 't1',
    want: '-0.67',
  },
  {
    name: '1.25 * 0.5 on scale 2: 0.625 rounds to "0.63"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '1.25', fee: '0.5' })]),
    value: { type: 'multiply', properties: [property('amount'), property('fee')] },
    key: 't1',
    want: '0.63',
  },
  {
    name: '-1.25 * 0.5 on scale 2: -0.625 rounds to "-0.63"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '-1.25', fee: '0.5' })]),
    value: { type: 'multiply', properties: [property('amount'), property('fee')] },
    key: 't1',
    want: '-0.63',
  },
  {
    name: '0.07 * 0.07 on scale 2: 0.0049 rounds 1 time to "0.00"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '0.07' })]),
    value: { type: 'multiply', properties: [property('amount'), property('amount')] },
    key: 't1',
    want: '0.00',
  },
  {
    name: 'multiply of 1.25, 0.5, and 0.5 is 1 operation: 0.3125 rounds 1 time to "0.31"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '1.25', fee: '0.5' })]),
    value: { type: 'multiply', properties: [property('amount'), property('fee'), property('fee')] },
    key: 't1',
    want: '0.31',
  },
  {
    name: 'multiply of 1.25, 3, and 3 takes the scale of the first operand: "11.25"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '1.25', units: 3 })]),
    value: { type: 'multiply', properties: [property('amount'), property('units'), property('units')] },
    key: 't1',
    want: '11.25',
  },
  {
    name: 'multiply of (1.25 * 0.5) and 0.5 is 2 operations: 0.63 * 0.5 = 0.315 rounds to "0.32"',
    root: TRANSACTION,
    data: dataOf([transaction('t1', { amount: '1.25', fee: '0.5' })]),
    value: {
      type: 'multiply',
      properties: [{ type: 'multiply', properties: [property('amount'), property('fee')] }, property('fee')],
    },
    key: 't1',
    want: '0.32',
  },
  {
    name: 'sum of 90071992547409.93 and 0.01 keeps each digit past 2^53: "90071992547409.94"',
    root: ACCOUNT,
    data: dataOf([transaction('t1', { amount: '90071992547409.93' }), transaction('t2', { amount: '0.01' })]),
    value: overTransactions({ type: 'sum', selectedPropertyApiName: 'amount' }),
    key: 'a1',
    want: '90071992547409.94',
  },
];

describe(`${TYPES_SECTION}: a Decimal value at a known tie equals the value by hand and the reference`, () => {
  it.each(FIXED)(`${TYPES_SECTION}: $name`, async ({ root, data, value, key, want }) => {
    const layers: Layers = [{ v: value }];

    expect(reference(MODEL, data, hiddenOf(data, 'admin'), root, layers)).toMatchObject({
      status: 200,
      objects: { [key]: { v: want } },
    });

    await check(root, data, layers);
  });
});
