import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindReader, createPool, policySql, type Reader } from './index.ts';
import { createDb, type Db } from './promise.test-utils.ts';
import type { CompiledObjectType, PersonFact, Policy, PolicyOperator } from '../ontology/index.ts';
import { compilePolicies } from '../ontology/policies.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import { objectType, property } from '../publish/publish.test-utils.ts';
import { SCHEMAS } from '../service.test-utils.ts';
import { UserId } from '../auth/caller.ts';
import { orThrow } from '../errors/fallible.ts';

const TRUTH: CompiledObjectType = objectType('Truth', 'truth', 'id', [
  property('id', 'id', { kind: 'string' }, true),
  property('s', 's', { kind: 'string' }),
  property('a', 'a', { kind: 'array', element: { kind: 'string' } }),
  property('sa', 'sa', { kind: 'array', element: { kind: 'string' } }),
]);

const ROWS: readonly {
  readonly id: string;
  readonly s: string | null;
  readonly a: readonly (string | null)[] | null;
}[] = [
  { id: 'null', s: null, a: null },
  { id: 'empty array', s: null, a: [] },
  { id: 'array of null', s: null, a: [null] },
  { id: 'empty String', s: '', a: [''] },
  { id: 'x', s: 'x', a: ['x'] },
  { id: 'y', s: 'y', a: ['y'] },
  { id: 'x and null', s: 'x', a: ['x', null] },
  { id: 'x and y', s: null, a: ['x', 'y'] },
  { id: 'x, x, and y', s: null, a: ['x', 'x', 'y'] },
];

let postgres: TestPostgres;
let db: Db;
let end: () => Promise<void>;

beforeAll(async () => {
  postgres = await startPostgres();

  const pool = createPool(postgres.url);

  db = createDb(pool);

  end = () => pool.end();

  await db.query({ text: `CREATE SCHEMA ${SCHEMAS.object}`, values: [] });

  await db.query({
    text: `CREATE TABLE ${SCHEMAS.object}.truth (id text PRIMARY KEY, s text, a text[], sa text[] GENERATED ALWAYS AS (ARRAY[s]) STORED)`,
    values: [],
  });

  for (const row of ROWS)
    await db.query({ text: `INSERT INTO ${SCHEMAS.object}.truth VALUES ($1, $2, $3)`, values: [row.id, row.s, row.a] });
});

afterAll(async () => {
  await end?.();

  await postgres?.stop();
});

function personWith(values: readonly string[]): Reader {
  return bindReader(SCHEMAS, {
    userId: UserId.parse('person-1'),
    permissions: [],
    attributes: new Map([['set', values]]),
  }).reader;
}

const SET: PersonFact = { kind: 'attribute', name: 'set' };

function compare(column: 's' | 'a' | 'sa', operator: PolicyOperator, person: PersonFact = SET): Policy {
  return { kind: 'compare', object: { kind: 'property', property: column }, operator, person };
}

async function passing(policy: Policy, reader: Reader): Promise<string[]> {
  const values: unknown[] = [];
  const condition = policySql(policy, TRUTH, 't', reader, { add: (value) => `$${values.push(value)}` });

  const rows = await db.query<{ id: string; pass: boolean | null }>({
    text: `SELECT t.id, ${condition} AS pass FROM ${SCHEMAS.object}.truth AS t ORDER BY t.id COLLATE "C"`,
    values,
  });

  expect(rows.filter((row) => row.pass === null).map((row) => row.id)).toEqual([]);

  return rows.filter((row) => row.pass === true).map((row) => row.id);
}

describe('ontology/object-security-policies#conditions: each operator on a String array Property', () => {
  it.each<[PolicyOperator, readonly string[], readonly string[]]>([
    ['intersects', ['x'], ['x', 'x and null', 'x and y', 'x, x, and y']],
    ['intersects', ['x', 'y'], ['x', 'x and null', 'x and y', 'x, x, and y', 'y']],
    ['intersects', [''], ['empty String']],
    ['subsetOf', ['x'], ['x', 'x and null']],
    ['subsetOf', ['x', 'y'], ['x', 'x and null', 'x and y', 'x, x, and y', 'y']],
    ['supersetOf', ['x'], ['x', 'x and null', 'x and y', 'x, x, and y']],
    ['supersetOf', ['x', 'y'], ['x and y', 'x, x, and y']],
  ])(
    'ontology/object-security-policies#conditions: a %s %j passes on exactly these rows',
    async (operator, person, rows) => {
      expect(await passing(compare('a', operator), personWith(person))).toEqual(rows);
    },
  );

  it.each<[readonly string[], readonly string[]]>([
    [['x'], ['x', 'x and null']],
    [
      ['x', 'y'],
      ['x and y', 'x, x, and y'],
    ],
    [
      ['y', 'x', 'y'],
      ['x and y', 'x, x, and y'],
    ],
    [[''], ['empty String']],
  ])(
    'ontology/object-security-policies#conditions: equals %j passes when the 2 sets hold the same values',
    async (person, rows) => {
      expect(await passing(compare('a', 'equal'), personWith(person))).toEqual(rows);
    },
  );
});

describe('ontology/object-security-policies#conditions: each operator on a String Property, which is a set of 0 or 1 value', () => {
  it.each<[PolicyOperator, readonly string[], readonly string[]]>([
    ['equal', ['x'], ['x', 'x and null']],
    ['equal', ['x', 'y'], []],
    ['equal', [''], ['empty String']],
    ['intersects', ['x'], ['x', 'x and null']],
    ['intersects', ['x', 'y'], ['x', 'x and null', 'y']],
    ['subsetOf', ['x'], ['x', 'x and null']],
    ['subsetOf', ['x', 'y'], ['x', 'x and null', 'y']],
    ['supersetOf', ['x'], ['x', 'x and null']],
    ['supersetOf', ['x', 'y'], []],
    ['supersetOf', ['x', 'x'], ['x', 'x and null']],
  ])(
    'ontology/object-security-policies#conditions: a %s %j passes on exactly these rows',
    async (operator, person, rows) => {
      expect(await passing(compare('s', operator), personWith(person))).toEqual(rows);
    },
  );

  it('ontology/object-security-policies#conditions: a String Property and a String array Property of the same set give the same answer for each operator and person', async () => {
    const same = new Set(['null', 'empty String', 'x', 'y', 'x and null']);

    for (const operator of ['equal', 'intersects', 'subsetOf', 'supersetOf'] as const) {
      for (const person of [[], ['x'], ['y'], ['x', 'y'], ['']]) {
        const reader = personWith(person);

        const [scalar, array] = [
          await passing(compare('s', operator), reader),
          await passing(compare('a', operator), reader),
        ];

        expect({ operator, person, rows: scalar }).toEqual({
          operator,
          person,
          rows: array.filter((id) => same.has(id)),
        });
      }
    }
  });
});

describe('ontology/object-security-policies#conditions: the String form agrees with the array form on each row', () => {
  it('ontology/object-security-policies#conditions: on each row, a String Property and the array of its 1 value pass for the same operators and people', async () => {
    for (const operator of ['equal', 'intersects', 'subsetOf', 'supersetOf'] as const) {
      for (const person of [[], [''], ['x'], ['y'], ['x', 'y'], ['x', 'x']]) {
        const reader = personWith(person);

        expect({ operator, person, rows: await passing(compare('s', operator), reader) }).toEqual({
          operator,
          person,
          rows: await passing(compare('sa', operator), reader),
        });
      }
    }

    const held = (reader: Reader, column: 's' | 'sa') =>
      passing(compare(column, 'intersects', { kind: 'permissions' }), reader);

    const noPermission = bindReader(SCHEMAS, {
      userId: UserId.parse('person-1'),
      permissions: [],
      attributes: new Map(),
    }).reader;

    expect([await held(noPermission, 's'), await held(noPermission, 'sa')]).toEqual([[], []]);
  });

  it('a policy that reads a Property that the Object Type does not have throws', () => {
    const other: Policy = {
      kind: 'compare',
      object: { kind: 'property', property: 'ownerId' },
      operator: 'equal',
      person: { kind: 'userId' },
    };

    expect(() => policySql(other, TRUTH, 't', personWith([]), { add: () => '$1' })).toThrow('does not have');
  });
});

describe('ontology/object-security-policies#conditions ontology/object-security-policies#empty-values: an empty side fails each operator', () => {
  it.each(['equal', 'intersects', 'subsetOf', 'supersetOf'] as const)(
    'ontology/object-security-policies#empty-values: %s fails on null, an empty array, and an array of null, and passes on an empty String',
    async (operator) => {
      const passed = await passing(compare('a', operator), personWith(['']));

      expect(passed).toEqual(['empty String']);

      expect(await passing(compare('s', operator), personWith(['']))).toEqual(['empty String']);
    },
  );

  it.each(['equal', 'intersects', 'subsetOf', 'supersetOf'] as const)(
    'ontology/object-security-policies#conditions: %s fails on each row for a person whose value is the empty set',
    async (operator) => {
      expect(await passing(compare('a', operator), personWith([]))).toEqual([]);

      expect(await passing(compare('s', operator), personWith([]))).toEqual([]);
    },
  );

  it.each<[PolicyOperator, 's' | 'a', readonly string[]]>([
    ['equal', 's', []],
    ['equal', 'a', []],
    ['supersetOf', 's', []],
    ['supersetOf', 'a', []],
    ['intersects', 's', ['x', 'x and null']],
    ['intersects', 'a', ['x', 'x and null', 'x and y', 'x, x, and y']],
    ['subsetOf', 's', ['x', 'x and null']],
    ['subsetOf', 'a', ['x', 'x and null']],
  ])(
    'ontology/object-security-policies#conditions: %s on %s for the person set [U+0000, x] passes on exactly these rows',
    async (operator, column, rows) => {
      expect(await passing(compare(column, operator), personWith(['\u0000', 'x']))).toEqual(rows);

      expect(await passing(compare(column, operator), personWith(['x\u0000']))).toEqual([]);
    },
  );

  it.each(['equal', 'intersects', 'subsetOf', 'supersetOf'] as const)(
    'ontology/object-security-policies#conditions: %s matches nothing for a User ID and a permission that hold U+0000',
    async (operator) => {
      const own: Policy = {
        kind: 'compare',
        object: { kind: 'property', property: 's' },
        operator,
        person: { kind: 'userId' },
      };

      const held: Policy = {
        kind: 'compare',
        object: { kind: 'property', property: 'a' },
        operator,
        person: { kind: 'permissions' },
      };

      const reader = bindReader(SCHEMAS, {
        userId: UserId.parse('x\u0000'),
        permissions: ['x\u0000'],
        attributes: new Map(),
      }).reader;

      const fixed: Policy = {
        kind: 'compare',
        object: { kind: 'constant', values: ['admin'] },
        operator,
        person: { kind: 'permissions' },
      };

      expect([await passing(own, reader), await passing(held, reader), await passing(fixed, reader)]).toEqual([
        [],
        [],
        [],
      ]);
    },
  );

  it('ontology/object-security-policies#conditions: subset of an empty Property fails, though the empty set is a subset of each set', async () => {
    expect(await passing(compare('a', 'subsetOf'), personWith(['x', 'y']))).not.toContain('empty array');

    expect(await passing(compare('a', 'subsetOf'), personWith(['x', 'y']))).not.toContain('array of null');
  });
});

describe('ontology/object-security-policies#conditions: and, or, and a fixed Object side', () => {
  const held: Policy = {
    kind: 'compare',
    object: { kind: 'constant', values: ['admin'] },
    operator: 'intersects',
    person: { kind: 'permissions' },
  };

  const own: Policy = {
    kind: 'compare',
    object: { kind: 'property', property: 's' },
    operator: 'equal',
    person: { kind: 'userId' },
  };

  const userX = bindReader(SCHEMAS, {
    userId: UserId.parse('x'),
    permissions: ['member'],
    attributes: new Map(),
  }).reader;

  const admin = bindReader(SCHEMAS, {
    userId: UserId.parse('x'),
    permissions: ['admin'],
    attributes: new Map(),
  }).reader;

  const noRole = bindReader(SCHEMAS, { userId: UserId.parse('y'), permissions: [], attributes: new Map() }).reader;
  const all = ROWS.map((row) => row.id).sort();

  it('ontology/object-security-policies#conditions: or passes when 1 condition passes, and and passes when each passes', async () => {
    expect(await passing({ kind: 'or', conditions: [held, own] }, userX)).toEqual(['x', 'x and null']);

    expect(await passing({ kind: 'or', conditions: [held, own] }, admin)).toEqual(all);

    expect(await passing({ kind: 'and', conditions: [held, own] }, admin)).toEqual(['x', 'x and null']);

    expect(await passing({ kind: 'and', conditions: [held, own] }, userX)).toEqual([]);

    expect(await passing({ kind: 'or', conditions: [held, own] }, noRole)).toEqual(['y']);
  });

  it('ontology/object-security-policies#conditions: a fixed list of Strings is an Object side', async () => {
    const twoRoles: Policy = {
      kind: 'compare',
      object: { kind: 'constant', values: ['admin', 'member'] },
      operator: 'intersects',
      person: { kind: 'permissions' },
    };

    expect(await passing(twoRoles, userX)).toEqual(all);

    expect(await passing(twoRoles, noRole)).toEqual([]);

    const none: Policy = {
      kind: 'compare',
      object: { kind: 'constant', values: [] },
      operator: 'subsetOf',
      person: { kind: 'permissions' },
    };

    expect(await passing(none, admin)).toEqual([]);
  });

  it('ontology/object-security-policies#conditions: an and of no condition passes, and an or of no condition fails', async () => {
    expect(await passing({ kind: 'and', conditions: [] }, userX)).toEqual(all);

    expect(await passing({ kind: 'or', conditions: [] }, userX)).toEqual([]);
  });

  it('ontology/object-security-policies#conditions user.id is a set of 1, and user.permissions a set of 0 or more', async () => {
    const ownArray: Policy = {
      kind: 'compare',
      object: { kind: 'property', property: 'a' },
      operator: 'supersetOf',
      person: { kind: 'userId' },
    };

    expect(await passing(ownArray, userX)).toEqual(['x', 'x and null', 'x and y', 'x, x, and y']);

    const heldArray: Policy = {
      kind: 'compare',
      object: { kind: 'property', property: 'a' },
      operator: 'subsetOf',
      person: { kind: 'permissions' },
    };

    const holding = (permissions: readonly string[]) =>
      bindReader(SCHEMAS, { userId: UserId.parse('z'), permissions, attributes: new Map() }).reader;

    expect(await passing(heldArray, holding(['x']))).toEqual(['x', 'x and null']);

    expect(await passing(heldArray, holding(['x', 'y']))).toEqual(['x', 'x and null', 'x and y', 'x, x, and y', 'y']);

    expect(await passing(heldArray, noRole)).toEqual([]);
  });

  it('each person value goes in the values, never in the SQL text', () => {
    const values: unknown[] = [];

    const text = policySql({ kind: 'or', conditions: [held, own] }, TRUTH, 't', admin, {
      add: (value) => `$${values.push(value)}`,
    });

    expect(text).not.toContain('admin');
    expect(values).toEqual([['admin'], ['admin'], ['x']]);
  });
});

function oracle(
  operator: PolicyOperator,
  left: readonly (string | null)[],
  right: readonly (string | null)[],
): boolean {
  const [l, r] = [new Set(left.filter((value) => value !== null)), new Set(right.filter((value) => value !== null))];

  if (l.size === 0 || r.size === 0) return false;

  const within = (a: Set<string>, b: Set<string>) => [...a].every((value) => b.has(value));

  return {
    equal: within(l, r) && within(r, l),
    intersects: [...l].some((value) => r.has(value)),
    subsetOf: within(l, r),
    supersetOf: within(r, l),
  }[operator];
}

function datasources(condition: unknown): unknown {
  const security = {
    type: 'granular',
    granular: {
      viewPolicy: {
        granularPolicyCondition: condition,
        additionalMandatory: { markings: {}, assumedMarkings: [], assumedMarkingsV2: {} },
      },
    },
  };

  return [
    {
      datasource: {
        type: 'datasetV3',
        datasetV3: {
          propertySecurityGroups: {
            groups: [{ rid: 'p', security, type: { type: 'primaryKey', primaryKey: {} }, properties: [] }],
          },
        },
      },
    },
  ];
}

const OPERATORS = ['equal', 'intersects', 'subsetOf', 'supersetOf'] as const;

const IR_OPERATOR = {
  equal: 'EQUAL',
  intersects: 'INTERSECTS',
  subsetOf: 'SUBSET_OF',
  supersetOf: 'SUPERSET_OF',
} as const;

const MANY = Array.from({ length: 10_000 }, (_, index) => `k${index}`);

const PERSON_SETS: readonly (readonly (string | null)[])[] = [
  [],
  ['x'],
  ['y'],
  [''],
  ['x', 'y'],
  ['x', 'x'],
  ['x', null],
  [null],
  ['', 'x'],
  ['x', 'y', 'z'],
  ['\u0000', 'x'],
  [...MANY, 'x', 'y'],
];

describe('ontology/object-security-policies#conditions: a Person attribute is a set of Strings on each side, for each operator', () => {
  const attribute = {
    type: 'userProperty',
    userProperty: { type: 'userAttributes', userAttributes: { attributeKey: 'set' } },
  };

  const side = (column: string) => ({ type: 'property', property: column });

  it.each(OPERATORS)(
    'ontology/object-security-policies#conditions: %s on the String and the array column, with the attribute on the right and on the left, equals the set answer on each row',
    async (operator) => {
      for (const person of PERSON_SETS) {
        const reader = personWith(person as readonly string[]);

        for (const column of ['s', 'a'] as const) {
          const right = orThrow(
            compilePolicies(
              datasources({
                type: 'comparison',
                comparison: { left: side(column), operator: IR_OPERATOR[operator], right: attribute },
              }),
              TRUTH,
            ),
          ).policy;

          const left = orThrow(
            compilePolicies(
              datasources({
                type: 'comparison',
                comparison: { left: attribute, operator: IR_OPERATOR[operator], right: side(column) },
              }),
              TRUTH,
            ),
          ).policy;

          if (!right || !left) throw new Error('The comparison compiled to no policy.');

          const expected = (personLeft: boolean) =>
            ROWS.filter((row) => {
              const object = column === 's' ? [row.s] : (row.a ?? []);

              return personLeft ? oracle(operator, person, object) : oracle(operator, object, person);
            })
              .map((row) => row.id)
              .sort((a, b) => (a < b ? -1 : 1));

          const label = { operator, column, person: person.length > 20 ? `${person.length} values` : person };

          expect({ ...label, order: 'person right', rows: await passing(right, reader) }).toEqual({
            ...label,
            order: 'person right',
            rows: expected(false),
          });

          expect({ ...label, order: 'person left', rows: await passing(left, reader) }).toEqual({
            ...label,
            order: 'person left',
            rows: expected(true),
          });
        }
      }
    },
  );

  const allFixedRows = ROWS.map((row) => row.id).sort((a, b) => (a < b ? -1 : 1));
  const fixedConstants = [[], ['x'], ['x', 'y'], ['', 'x']] as const;

  const fixedCases = OPERATORS.map(
    (operator) =>
      [
        operator,
        fixedConstants.flatMap((constant) =>
          PERSON_SETS.map((person) => ({
            constant,
            person,
            rows: oracle(operator, constant, person) ? allFixedRows : [],
          })),
        ),
      ] as const,
  );

  it.each(fixedCases)(
    'ontology/object-security-policies#conditions: %s with a fixed Object side equals the set answer for each person set',
    async (operator, cases) => {
      for (const { constant, person, rows } of cases) {
        const policy: Policy = {
          kind: 'compare',
          object: { kind: 'constant', values: constant },
          operator,
          person: SET,
        };

        const label = { operator, constant, person: person.length > 20 ? `${person.length} values` : person };

        expect({ ...label, rows: await passing(policy, personWith(person as readonly string[])) }).toEqual({
          ...label,
          rows,
        });
      }
    },
  );

  it('ontology/object-security-policies#person-attributes: an attribute with no entry in the person reads as the empty set, so each comparison fails', async () => {
    const reader = bindReader(SCHEMAS, {
      userId: UserId.parse('x'),
      permissions: ['admin'],
      attributes: new Map(),
    }).reader;

    for (const operator of OPERATORS) {
      expect(await passing(compare('a', operator), reader)).toEqual([]);

      expect(await passing(compare('s', operator), reader)).toEqual([]);
    }
  });

  it('ontology/object-security-policies#conditions: in an or, the admin branch passes for a person whose attribute is empty', async () => {
    const admin: Policy = {
      kind: 'compare',
      object: { kind: 'constant', values: ['admin'] },
      operator: 'intersects',
      person: { kind: 'permissions' },
    };

    const reader = bindReader(SCHEMAS, {
      userId: UserId.parse('x'),
      permissions: ['admin'],
      attributes: new Map([['set', []]]),
    }).reader;

    expect(await passing({ kind: 'or', conditions: [admin, compare('a', 'subsetOf')] }, reader)).toEqual(
      ROWS.map((row) => row.id).sort((a, b) => (a < b ? -1 : 1)),
    );

    expect(await passing({ kind: 'and', conditions: [admin, compare('a', 'subsetOf')] }, reader)).toEqual([]);
  });
});

describe('user.permissions in a policy, for a caller with 0, 1, and 2 permissions', () => {
  const CONDITIONS = 'ontology/object-security-policies#conditions';

  const ALL = [
    'array of null',
    'empty String',
    'empty array',
    'null',
    'x',
    'x and null',
    'x and y',
    'x, x, and y',
    'y',
  ];

  const group = (operator: 'INTERSECTS' | 'SUPERSET_OF', objectSide: unknown): Policy => {
    const policy = orThrow(
      compilePolicies(
        datasources({
          type: 'comparison',
          comparison: {
            left: { type: 'userProperty', userProperty: { type: 'groupIds', groupIds: {} } },
            operator,
            right: objectSide,
          },
        }),
        TRUTH,
      ),
    ).policy;

    if (!policy) throw new Error('The comparison compiled to no policy.');

    return policy;
  };

  const caller = (permissions: readonly string[]) =>
    bindReader(SCHEMAS, { userId: UserId.parse('person-1'), permissions, attributes: new Map() }).reader;

  const column = (name: string) => ({ type: 'property', property: name });
  const constant = { type: 'constant', constant: { type: 'strings', strings: ['x', 'y'] } };

  it.each<
    [string, 'INTERSECTS' | 'SUPERSET_OF', unknown, readonly [readonly string[], readonly string[], readonly string[]]]
  >([
    [
      'holds 1 of the values of a String array Property',
      'INTERSECTS',
      column('a'),
      [[], ['x', 'x and null', 'x and y', 'x, x, and y'], ['x', 'x and null', 'x and y', 'x, x, and y', 'y']],
    ],
    [
      'holds each value of a String array Property',
      'SUPERSET_OF',
      column('a'),
      [[], ['x', 'x and null'], ['x', 'x and null', 'x and y', 'x, x, and y', 'y']],
    ],
    [
      'holds the value of a String Property',
      'INTERSECTS',
      column('s'),
      [[], ['x', 'x and null'], ['x', 'x and null', 'y']],
    ],
    [
      'holds each value of a String Property',
      'SUPERSET_OF',
      column('s'),
      [[], ['x', 'x and null'], ['x', 'x and null', 'y']],
    ],
    ['holds 1 of the fixed values x and y', 'INTERSECTS', constant, [[], ALL, ALL]],
    ['holds each of the fixed values x and y', 'SUPERSET_OF', constant, [[], [], ALL]],
  ])(
    `${CONDITIONS}/d16df19e ${CONDITIONS}/590eb04b: the caller %s, with no permission, with x, and with x and y`,
    async (_ask, operator, objectSide, [none, one, two]) => {
      const policy = group(operator, objectSide);

      expect(await passing(policy, caller([]))).toEqual(none);

      expect(await passing(policy, caller(['x']))).toEqual(one);

      expect(await passing(policy, caller(['x', 'y']))).toEqual(two);
    },
  );

  it(`${CONDITIONS}/d16df19e: a reader with no permissions reads user.permissions as the empty set, never as the User ID`, async () => {
    const policy = group('INTERSECTS', { type: 'constant', constant: { type: 'strings', strings: ['admin'] } });

    expect(
      await passing(
        policy,
        bindReader(SCHEMAS, { userId: UserId.parse('admin'), permissions: [], attributes: new Map() }).reader,
      ),
    ).toEqual([]);

    expect(await passing(policy, caller(['admin']))).toEqual(ALL);
  });
});
