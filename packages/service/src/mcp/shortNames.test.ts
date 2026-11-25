import { describe, expect, it } from 'vitest';
import { orThrow } from '../errors/fallible.ts';
import { ApiError, settle } from '../errors/index.ts';
import type { JsonValue } from '../ontology/index.ts';
import { objectTypeResolver, resolveObjectSet } from './shortNames.ts';

const TOOLS = 'service/ontology-mcp#tools/0433a01e';

const SALES = ['com.acme.Account', 'com.acme.Engagement'];
const base = (objectType: string) => ({ type: 'base', objectType });

function resolverOf(apiNames: string[]): (name: string) => string {
  const resolve = objectTypeResolver(apiNames);

  return (name) => orThrow(resolve(name));
}

describe('objectTypeResolver', () => {
  it(`${TOOLS}: a short name that 1 API name ends with gives that API name`, () => {
    expect(resolverOf(SALES)('Engagement')).toBe('com.acme.Engagement');
  });

  it(`${TOOLS}: an API name stays the same, and so does a name that no API name ends with`, () => {
    const resolve = resolverOf(SALES);

    expect(resolve('com.acme.Engagement')).toBe('com.acme.Engagement');
    expect(resolve('Nonesuch')).toBe('Nonesuch');
  });

  it(`${TOOLS}: a short name is the text after the last dot, so a part of an API name with a dot, or a part of a word, is no short name`, () => {
    const resolve = resolverOf(SALES);

    expect(resolve('acme.Engagement')).toBe('acme.Engagement');
    expect(resolve('Engage')).toBe('Engage');
    expect(resolve('engagement')).toBe('engagement');
    expect(resolve('')).toBe('');
  });

  it(`${TOOLS}: a short name that 2 API names end with gives a 400 that lists them in code point order`, () => {
    const resolve = objectTypeResolver(['org.two.Item', 'org.one.Item', 'org.one.Widget']);
    const refused = settle(resolve('Item'));

    expect(refused).toEqual({ ok: false, error: expect.any(ApiError) });

    expect(!refused.ok && refused.error).toMatchObject({
      status: 400,
      errorName: 'Default:InvalidArgument',
      parameters: { objectType: 'Item', matches: ['org.one.Item', 'org.two.Item'] },
    });
  });

  it(`${TOOLS}: an API name wins over the short name of another type`, () => {
    const resolve = resolverOf(['Item', 'org.Item', 'org.Widget']);

    expect(resolve('Item')).toBe('Item');
    expect(resolve('Widget')).toBe('org.Widget');
  });

  it(`${TOOLS}: a name that Object.prototype holds is no short name`, () => {
    expect(resolverOf(SALES)('constructor')).toBe('constructor');
    expect(resolverOf(SALES)('__proto__')).toBe('__proto__');
  });

  it(`${TOOLS}: only the names that it gets count, so a type of another caller's view makes no match and no ambiguity`, () => {
    expect(resolverOf(['org.one.Item'])('Item')).toBe('org.one.Item');
    expect(resolverOf([])('Item')).toBe('Item');
  });
});

describe('resolveObjectSet', () => {
  const resolve = objectTypeResolver(['com.acme.Account', 'com.acme.Engagement']);
  const resolved = (tree: JsonValue) => orThrow(resolveObjectSet(resolve, tree));

  it(`${TOOLS}: a base Object Set gets the API name`, () => {
    expect(resolved(base('Account'))).toEqual(base('com.acme.Account'));
  });

  it.each([
    [
      'filter',
      (inner: JsonValue) => ({
        type: 'filter',
        objectSet: inner,
        where: { type: 'eq', field: 'phase', value: 'active' },
      }),
    ],
    ['searchAround', (inner: JsonValue) => ({ type: 'searchAround', objectSet: inner, link: 'engagements' })],
    ['withProperties', (inner: JsonValue) => ({ type: 'withProperties', objectSet: inner, derivedProperties: {} })],
    ['union', (inner: JsonValue, other: JsonValue) => ({ type: 'union', objectSets: [inner, other] })],
    ['intersect', (inner: JsonValue, other: JsonValue) => ({ type: 'intersect', objectSets: [other, inner] })],
    ['subtract', (inner: JsonValue, other: JsonValue) => ({ type: 'subtract', objectSets: [inner, other] })],
  ])(`${TOOLS}: each base inside a %s member gets the API name`, (_type, around) => {
    expect(resolved(around(base('Account'), base('Engagement')))).toEqual(
      around(base('com.acme.Account'), base('com.acme.Engagement')),
    );
  });

  it(`${TOOLS}: a base 4 members down gets the API name, and the sets around it keep their other fields`, () => {
    const tree = {
      type: 'filter',
      objectSet: {
        type: 'union',
        objectSets: [{ type: 'searchAround', objectSet: base('Account'), link: 'engagements' }, base('Engagement')],
      },
      where: { type: 'isNull', field: 'title' },
    };

    expect(resolved(tree)).toEqual({
      type: 'filter',
      objectSet: {
        type: 'union',
        objectSets: [
          { type: 'searchAround', objectSet: base('com.acme.Account'), link: 'engagements' },
          base('com.acme.Engagement'),
        ],
      },
      where: { type: 'isNull', field: 'title' },
    });
  });

  it(`${TOOLS}: a base inside a selection of a derived definition gets the API name, and each other value there stays`, () => {
    const selection = (objectSet: JsonValue) => ({ type: 'selection', objectSet, operation: { type: 'count' } });

    const derived = (objectSet: JsonValue) => ({
      type: 'withProperties',
      objectSet: base('Account'),
      derivedProperties: {
        n: selection(objectSet),
        sum: { type: 'add', operands: [selection(objectSet), { type: 'property', apiName: 'Account' }] },
      },
    });

    const hops = (name: string) => ({
      type: 'union',
      objectSets: [{ type: 'searchAround', objectSet: { type: 'methodInput' }, link: 'engagements' }, base(name)],
    });

    expect(resolved(derived(hops('Engagement')))).toEqual({
      type: 'withProperties',
      objectSet: base('com.acme.Account'),
      derivedProperties: {
        n: selection(hops('com.acme.Engagement')),
        sum: {
          type: 'add',
          operands: [selection(hops('com.acme.Engagement')), { type: 'property', apiName: 'Account' }],
        },
      },
    });
  });

  it(`${TOOLS}: a value that looks like a base Object Set in a where clause stays as it is`, () => {
    const tree = {
      type: 'filter',
      objectSet: base('Account'),
      where: { type: 'eq', field: 'note', value: base('Engagement') },
    };

    expect(resolved(tree)).toEqual({
      type: 'filter',
      objectSet: base('com.acme.Account'),
      where: { type: 'eq', field: 'note', value: base('Engagement') },
    });
  });

  it(`${TOOLS}: the call changes no part of its input`, () => {
    const tree = {
      type: 'union',
      objectSets: [base('Account'), { type: 'filter', objectSet: base('Engagement'), where: {} }],
    };

    const before = JSON.stringify(tree);

    resolved(tree);

    expect(JSON.stringify(tree)).toBe(before);
  });

  it.each([
    null,
    5,
    'Account',
    [],
    {},
    { type: 'base' },
    { type: 'base', objectType: 5 },
    { type: 'filter' },
    { type: 'union', objectSets: 'x' },
    { type: 'unknownKind', objectType: 'Account' },
  ] as JsonValue[])(`${TOOLS}: a tree of another shape, %j, stays as it is, for the engine to refuse`, (tree) => {
    expect(resolved(tree)).toEqual(tree);
  });

  it(`${TOOLS}: a short name of 2 API names in a nested member gives the 400 of the list`, () => {
    const clash = objectTypeResolver(['org.one.Item', 'org.two.Item']);

    expect(
      settle(
        resolveObjectSet(clash, {
          type: 'filter',
          objectSet: { type: 'union', objectSets: [base('Item')] },
          where: {},
        }),
      ),
    ).toEqual({ ok: false, error: expect.any(ApiError) });
  });
});
