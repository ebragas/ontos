import type { QueryTypeV2 } from '@osdk/foundry.ontologies';
import { describe, expect, it } from 'vitest';
import { orThrow } from '../errors/fallible.ts';
import { ApiError } from '../errors/index.ts';
import {
  emptyOntology,
  type CompiledFunction,
  type CompiledOntology,
  type CompiledParameter,
  type EditFunction,
  type QueryFunction,
} from '../ontology/index.ts';
import { businessMap } from './describe.ts';
import { describeQuery, queriesByObjectType, typeText } from './queries.ts';

const TOOLS = 'service/ontology-mcp#tools';
const PLAN = 'com.acme.Plan';
const ACCOUNT = 'com.acme.Account';

function parameter(id: string, type: CompiledParameter['type'], required = true): CompiledParameter {
  return { id, type, required, allowed: { kind: 'boolean' } };
}

function query(
  apiName: string,
  parameters: CompiledParameter[],
  output: QueryFunction['output'],
  description?: string,
  descriptions: Record<string, string> = {},
): QueryFunction {
  return {
    kind: 'query',
    apiName,
    rid: `ri.function-registry.main.function.${apiName}`,
    version: '1.0.0',
    parameters: new Map(parameters.map((entry) => [entry.id, entry])),
    descriptions: new Map(Object.entries(descriptions)),
    description,
    output,
  };
}

const REQUIRED_PAYMENTS = query(
  'requiredPayments',
  [
    parameter('plan', { kind: 'object', objectType: PLAN }),
    parameter('days', { kind: 'integer' }),
    parameter('note', { kind: 'string' }, false),
  ],
  {
    type: {
      kind: 'list',
      element: {
        kind: 'struct',
        fields: new Map([
          ['account', { type: { kind: 'object', objectType: ACCOUNT }, optional: false }],
          ['amount', { type: { kind: 'decimal' }, optional: false }],
          ['note', { type: { kind: 'string' }, optional: true }],
        ]),
      },
    },
    optional: false,
  },
  'The payments of a plan.\nEach one is due in the window.',
  { plan: 'The plan to read.', days: 'The length of the window, in days.' },
);

const AMOUNT_LEFT = query(
  'amountLeft',
  [
    parameter('plans', { kind: 'objectList', objectType: PLAN }),
    parameter('accounts', { kind: 'objectList', objectType: ACCOUNT }),
  ],
  { type: { kind: 'decimal' }, optional: true },
  'The amount left.',
);

const TODAY = query('today', [], { type: { kind: 'date' }, optional: false });

const UNLISTED = query(
  'unlisted',
  [],
  { type: { kind: 'string' }, optional: false },
  'The stored metadata does not list it.',
);

const EDIT: EditFunction = {
  kind: 'edit',
  apiName: 'editPlan',
  rid: 'ri.function-registry.main.function.editPlan',
  version: '1.0.0',
  parameters: new Map(),
  descriptions: new Map(),
  provenance: { objectTypes: new Set([PLAN]), linkTypes: new Set() },
};

function ontologyOf(functions: readonly CompiledFunction[], listed: readonly string[]): CompiledOntology {
  const empty = emptyOntology('ri.ontology.main.ontology.test');

  return {
    ...empty,
    metadata: { ...empty.metadata, queryTypes: Object.fromEntries(listed.map((name) => [name, {} as QueryTypeV2])) },
    functions: new Map(functions.map((fn) => [fn.apiName, fn])),
  };
}

const ONTOLOGY = ontologyOf(
  [REQUIRED_PAYMENTS, AMOUNT_LEFT, TODAY, UNLISTED, EDIT],
  ['requiredPayments', 'amountLeft', 'today'],
);

function refused(answer: () => unknown): unknown {
  try {
    answer();
  } catch (error) {
    if (error instanceof ApiError)
      return { status: error.status, errorName: error.errorName, parameters: error.parameters };

    throw error;
  }

  throw new Error('The answer gave no ApiError.');
}

describe('typeText', () => {
  it(`${TOOLS}: says "Decimal", never string, for a Decimal, and names the Object Type of an Object`, () => {
    expect(typeText({ kind: 'decimal' })).toBe('Decimal');
    expect(typeText({ kind: 'decimal', precision: 10, scale: 2 })).toBe('Decimal');
    expect(typeText({ kind: 'object', objectType: PLAN })).toBe(PLAN);
  });

  it(`${TOOLS}: gives each base type by its name`, () => {
    const kinds = ['string', 'boolean', 'integer', 'double', 'date', 'timestamp'] as const;

    expect(kinds.map((kind) => typeText({ kind }))).toEqual([
      'String',
      'Boolean',
      'Integer',
      'Double',
      'Date',
      'Timestamp',
    ]);
  });

  it(`${TOOLS}: gives a list, a list of Objects, and a struct with an optional field`, () => {
    expect(typeText({ kind: 'list', element: { kind: 'decimal' } })).toBe('list of Decimal');
    expect(typeText({ kind: 'objectList', objectType: PLAN })).toBe(`list of ${PLAN}`);

    expect(
      typeText({
        kind: 'struct',
        fields: new Map([
          ['amount', { type: { kind: 'decimal' }, required: true }],
          ['note', { type: { kind: 'string' }, required: false }],
        ]),
      }),
    ).toBe('{ amount: Decimal, note?: String }');
  });
});

describe('describeQuery', () => {
  it(`${TOOLS}: with no name, lists each Query Function of the view that the metadata lists, in API name order, with its full description, and no edit Function`, () => {
    expect(orThrow(describeQuery(ONTOLOGY, undefined))).toEqual({
      queries: [
        'amountLeft: The amount left.',
        'requiredPayments: The payments of a plan.\nEach one is due in the window.',
        'today',
      ],
    });
  });

  it(`${TOOLS}: with a name, gives each input with its type, required flag, and description, and the output type`, () => {
    expect(orThrow(describeQuery(ONTOLOGY, 'requiredPayments'))).toEqual({
      apiName: 'requiredPayments',
      description: 'The payments of a plan.\nEach one is due in the window.',
      inputs: [
        { id: 'plan', type: PLAN, required: true, description: 'The plan to read.' },
        { id: 'days', type: 'Integer', required: true, description: 'The length of the window, in days.' },
        { id: 'note', type: 'String', required: false },
      ],
      output: `list of { account: ${ACCOUNT}, amount: Decimal, note?: String }`,
    });
  });

  it(`${TOOLS}: an optional output is its type or null`, () => {
    expect(orThrow(describeQuery(ONTOLOGY, 'amountLeft'))).toMatchObject({ output: 'Decimal or null' });
  });

  it.each(['noSuchQuery', 'editPlan', 'unlisted'])(
    `${TOOLS}: %s gets the 404 QueryNotFound of an unknown name`,
    (name) => {
      expect(refused(() => orThrow(describeQuery(ONTOLOGY, name)))).toEqual({
        status: 404,
        errorName: 'QueryNotFound',
        parameters: { query: name },
      });
    },
  );
});

describe('queriesByObjectType', () => {
  it(`${TOOLS}: puts each Query Function under each Object Type that an input takes, and each other one in other, in API name order`, () => {
    const { byObjectType, other } = queriesByObjectType(ONTOLOGY);

    expect(
      Object.fromEntries(
        [...byObjectType].map(([objectType, queries]) => [objectType, queries.map((fn) => fn.apiName)]),
      ),
    ).toEqual({
      [PLAN]: ['amountLeft', 'requiredPayments'],
      [ACCOUNT]: ['amountLeft'],
    });

    expect(other.map((fn) => fn.apiName)).toEqual(['today']);
  });
});

describe('the Query Functions of the business map', () => {
  it(`${TOOLS}: give the first line of the description, and count in the 25,000 characters of the map`, () => {
    const long = query(
      'long',
      [],
      { type: { kind: 'string' }, optional: false },
      `${'q'.repeat(25_000)}\nThe second line.`,
    );

    expect(businessMap(ontologyOf([TODAY], ['today']))).toEqual({
      objectTypes: {},
      linkTypes: {},
      otherActionTypes: [],
      otherQueryFunctions: ['today'],
    });

    expect(businessMap(ontologyOf([long], ['long']))).toMatchObject({
      otherQueryFunctions: [`long: ${'q'.repeat(25_000)}`],
      detail: expect.stringContaining('This map leaves out'),
    });
  });
});
