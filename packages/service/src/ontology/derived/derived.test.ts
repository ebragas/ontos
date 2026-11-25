import { createClient, getWireObjectSet, type ObjectTypeDefinition } from '@osdk/client';
import { describe, expect, it } from 'vitest';
import { orThrow } from '../../errors/fallible.ts';
import type { PropertyType } from '../compiled/links.ts';
import { CompileError } from '../compiled/stored.ts';
import { selectionOf, sideOf } from './ir.ts';
import { COLLECT_LIMIT, FORM_LIMITS } from './limits.ts';
import type { DerivedForm, DerivedNode, DerivedRefusal, InputRow } from './nodes.ts';
import { parseDerived } from './parse.ts';
import { resultType } from './resultType.ts';
import {
  BOOLEAN,
  DATE,
  decimal,
  DOUBLE,
  INTEGER,
  linkTypeNamed,
  objectTypeNamed,
  ONTOLOGY,
  STRING,
  TIMESTAMP,
} from './derived.test-utils.ts';

const FORMS: readonly DerivedForm[] = ['objectType', 'request'];

describe('ontology/object-link-types/derived-properties#types', () => {
  const scale2 = decimal(2);

  const array = (element: PropertyType): PropertyType => ({
    kind: 'array',
    element: element as Extract<PropertyType, { kind: 'string' }>,
  });

  it.each([
    ['count', [], INTEGER],
    ['exactDistinct', [STRING], INTEGER],
    ['approximateDistinct', [scale2], INTEGER],
    ['approximateDistinct', [array(STRING)], INTEGER],
    ['sum', [INTEGER], DOUBLE],
    ['sum', [DOUBLE], DOUBLE],
    ['avg', [INTEGER], DOUBLE],
    ['avg', [DOUBLE], DOUBLE],
    ['sum', [scale2], decimal(2, 38)],
    ['avg', [decimal(4, 10)], decimal(4, 38)],
    ['min', [INTEGER], INTEGER],
    ['max', [scale2], scale2],
    ['min', [DATE], DATE],
    ['max', [TIMESTAMP], TIMESTAMP],
    ['max', [BOOLEAN], BOOLEAN],
    ['get', [STRING], STRING],
    ['get', [array(STRING)], array(STRING)],
    ['approximatePercentile', [INTEGER], DOUBLE],
    ['approximatePercentile', [DOUBLE], DOUBLE],
    ['approximatePercentile', [scale2], DOUBLE],
    ['collectList', [STRING], array(STRING)],
    ['collectSet', [scale2], array(scale2)],
  ] as const)('ontology/object-link-types/derived-properties#types: %s of %j gives %j', (kind, operands, expected) => {
    expect(resultType(kind, operands)).toEqual(expected);
  });

  it.each([
    ['sum', [STRING]],
    ['sum', [BOOLEAN]],
    ['avg', [DATE]],
    ['min', [STRING]],
    ['max', [array(STRING)]],
    ['approximatePercentile', [STRING]],
    ['approximatePercentile', [DATE]],
    ['collectList', [array(STRING)]],
    ['sum', [undefined]],
    ['get', []],
    ['sum', [INTEGER, INTEGER]],
  ] as const)('ontology/object-link-types/derived-properties#types: %s of %j gives no type', (kind, operands) => {
    expect(resultType(kind, operands)).toBeUndefined();
  });

  it.each([
    ['add', [INTEGER, INTEGER], INTEGER],
    ['subtract', [INTEGER, INTEGER], INTEGER],
    ['multiply', [INTEGER, INTEGER], INTEGER],
    ['divide', [INTEGER, INTEGER], DOUBLE],
    ['add', [INTEGER, DOUBLE], DOUBLE],
    ['subtract', [DOUBLE, INTEGER], DOUBLE],
    ['multiply', [DOUBLE, DOUBLE], DOUBLE],
    ['divide', [INTEGER, DOUBLE], DOUBLE],
    ['add', [INTEGER, INTEGER, DOUBLE], DOUBLE],
    ['add', [decimal(2), decimal(2)], decimal(2, 38)],
    ['subtract', [decimal(2), decimal(4)], decimal(4, 38)],
    ['greatest', [decimal(4), decimal(2), decimal(3)], decimal(4, 38)],
    ['greatest', [decimal(2, 38), decimal(4, 5)], decimal(4, 38)],
    ['least', [decimal(2), decimal(2)], decimal(2, 38)],
    ['multiply', [decimal(2), decimal(4)], decimal(2, 38)],
    ['multiply', [decimal(4), decimal(2)], decimal(4, 38)],
    ['divide', [decimal(2), decimal(4)], decimal(2, 38)],
    ['multiply', [decimal(2), INTEGER], decimal(2, 38)],
    ['divide', [decimal(2), INTEGER], decimal(2, 38)],
    ['add', [decimal(2), DOUBLE], DOUBLE],
    ['subtract', [DOUBLE, decimal(2)], DOUBLE],
    ['multiply', [decimal(2), DOUBLE], DOUBLE],
    ['divide', [DOUBLE, decimal(2)], DOUBLE],
    ['greatest', [decimal(2), DOUBLE], DOUBLE],
    ['absoluteValue', [INTEGER], INTEGER],
    ['negate', [DOUBLE], DOUBLE],
    ['negate', [decimal(3)], decimal(3)],
    ['greatest', [INTEGER, INTEGER], INTEGER],
    ['least', [INTEGER, DOUBLE], DOUBLE],
    ['greatest', [DATE, DATE], DATE],
    ['least', [TIMESTAMP, TIMESTAMP], TIMESTAMP],
    ['extract', [DATE], INTEGER],
    ['extract', [TIMESTAMP], INTEGER],
  ] as const)('ontology/object-link-types/derived-properties#types: %s of %j gives %j', (kind, operands, expected) => {
    expect(resultType(kind, operands)).toEqual(expected);
  });

  it.each([
    ['add', [decimal(2), INTEGER]],
    ['subtract', [INTEGER, decimal(2)]],
    ['multiply', [INTEGER, decimal(2)]],
    ['divide', [INTEGER, decimal(2)]],
    ['greatest', [decimal(2), INTEGER]],
    ['add', [STRING, STRING]],
    ['add', [BOOLEAN, INTEGER]],
    ['greatest', [DATE, TIMESTAMP]],
    ['greatest', [DATE, INTEGER]],
    ['add', [DATE, DATE]],
    ['add', [INTEGER]],
    ['subtract', [INTEGER, INTEGER, INTEGER]],
    ['absoluteValue', [STRING]],
    ['negate', [DATE]],
    ['extract', [INTEGER]],
    ['extract', [STRING]],
    ['add', [INTEGER, undefined]],
  ] as const)('ontology/object-link-types/derived-properties#types: %s of %j gives no type', (kind, operands) => {
    expect(resultType(kind, operands)).toBeUndefined();
  });
});

function inputOf(objectType: string, derived: Readonly<Record<string, PropertyType>> = {}): InputRow {
  const type = objectTypeNamed(objectType);

  return {
    objectType: type,
    property: (apiName) => {
      const stored = type.properties.get(apiName);

      if (stored) return { type: stored.type };

      const other = derived[apiName];

      return other ? { type: other } : undefined;
    },
  };
}

const parse = (
  definition: unknown,
  objectType: string,
  form: DerivedForm,
  derived?: Readonly<Record<string, PropertyType>>,
) => parseDerived(definition, inputOf(objectType, derived), ONTOLOGY, form);

const methodInput = { type: 'methodInput' } as const;
const around = (objectSet: unknown, link: string) => ({ type: 'searchAround', objectSet, link });

const filtered = (objectSet: unknown) => ({
  type: 'filter',
  objectSet,
  where: { type: 'eq', field: 'status', value: 'cleared' },
});

const selection = (objectSet: unknown, operation: unknown) => ({ type: 'selection', objectSet, operation });
const propertyOp = (type: string, selectedPropertyApiName: string) => ({ type, selectedPropertyApiName });

const balance = selection(around(methodInput, 'transactions'), propertyOp('sum', 'amount'));

function accepted(result: ReturnType<typeof parseDerived>): DerivedNode {
  if (!result.ok) throw new Error(`Expected a node, got ${JSON.stringify(result.refusal)}.`);

  return result.node;
}

function refused(result: ReturnType<typeof parseDerived>): DerivedRefusal {
  if (result.ok) throw new Error('Expected a refusal.');

  return result.refusal;
}

describe('ontology/object-link-types/derived-properties#limits', () => {
  const hops = (count: number) =>
    Array.from({ length: count }).reduce<unknown>((set) => around(set, 'reports'), methodInput);

  it('ontology/object-link-types/derived-properties#limits: the table holds the 2 forms', () => {
    expect(FORM_LIMITS.objectType).toEqual({ maxHops: 3, filters: false, expressions: false, percentile: false });
    expect(FORM_LIMITS.request).toEqual({ maxHops: Infinity, filters: true, expressions: true, percentile: true });
  });

  it('ontology/object-link-types/derived-properties#limits: the Object Type form takes 1 to 3 hops and refuses a 4th', () => {
    for (const count of [1, 2, 3]) {
      expect(accepted(parse(selection(hops(count), { type: 'count' }), 'Person', 'objectType'))).toMatchObject({
        kind: 'selection',
        path: { hops: count },
      });
    }

    expect(refused(parse(selection(hops(4), { type: 'count' }), 'Person', 'objectType')).kind).toBe('shape');
  });

  it('ontology/object-link-types/derived-properties#limits: the request form takes 4 hops and more', () => {
    for (const count of [4, 7]) {
      expect(accepted(parse(selection(hops(count), { type: 'count' }), 'Person', 'request'))).toMatchObject({
        kind: 'selection',
        type: INTEGER,
        path: { hops: count },
      });
    }
  });

  it('ontology/object-link-types/derived-properties#limits: refuses a selection with no hop in both forms', () => {
    for (const form of FORMS)
      expect(refused(parse(selection(methodInput, { type: 'count' }), 'Account', form)).kind).toBe('shape');
  });

  it('ontology/object-link-types/derived-properties#limits: refuses a filter on a hop in the Object Type form, and takes it in the request form', () => {
    const cleared = selection(filtered(around(methodInput, 'transactions')), propertyOp('sum', 'amount'));

    expect(refused(parse(cleared, 'Account', 'objectType')).kind).toBe('shape');

    expect(accepted(parse(cleared, 'Account', 'request'))).toMatchObject({
      kind: 'selection',
      type: decimal(2, 38),
      path: { hops: 1 },
    });
  });

  it('ontology/object-link-types/derived-properties#limits: a filter has a where clause, and a filter with no hop gets the hop count refusal', () => {
    expect(refused(parse(selection(filtered(methodInput), { type: 'count' }), 'Account', 'request'))).toMatchObject({
      kind: 'shape',
      detail: expect.stringContaining('1 hop'),
    });

    expect(
      refused(
        parse(
          selection({ type: 'filter', objectSet: around(methodInput, 'transactions') }, { type: 'count' }),
          'Account',
          'request',
        ),
      ).kind,
    ).toBe('shape');
  });

  it('ontology/object-link-types/derived-properties#limits: the request form takes the wire of where, then pivotTo, then aggregate', () => {
    const client = createClient('https://ontology.test', 'ri.ontology.main.ontology.test', async () => 'token');
    const account: ObjectTypeDefinition = { type: 'object', apiName: 'Account' };

    const wire = getWireObjectSet(
      client(account).withProperties({
        cleared: (builder) => builder.where({ name: 'x' }).pivotTo('transactions').aggregate('$count'),
      }),
    );

    const sent = (
      wire as { derivedProperties: Record<string, { objectSet: { type: string; objectSet: { type: string } } }> }
    ).derivedProperties['cleared'];

    expect(sent?.objectSet.type).toBe('searchAround');
    expect(sent?.objectSet.objectSet.type).toBe('filter');

    expect(accepted(parse(sent, 'Account', 'request'))).toMatchObject({
      kind: 'selection',
      type: INTEGER,
      operation: { kind: 'count' },
      path: { hops: 1 },
    });

    expect(refused(parse(sent, 'Account', 'objectType')).kind).toBe('shape');
  });

  it('ontology/object-link-types/derived-properties#limits: the Object Type form refuses each top-level type that is not a selection', () => {
    const read = { type: 'property', apiName: 'budget' };

    const definitions = [
      read,
      { type: 'property', apiName: 'missing' },
      { type: 'negate', property: read },
      { type: 'add', properties: [read, read] },
      { type: 'extract' },
    ];

    for (const definition of definitions)
      expect(refused(parse(definition, 'Account', 'objectType')).kind).toBe('shape');
  });

  it('ontology/object-link-types/derived-properties#limits: refuses an expression in the Object Type form, and takes it in the request form', () => {
    const available = { type: 'subtract', left: balance, right: { type: 'property', apiName: 'budget' } };

    expect(refused(parse(available, 'Account', 'objectType')).kind).toBe('shape');

    expect(accepted(parse(available, 'Account', 'request'))).toMatchObject({
      kind: 'binary',
      op: 'subtract',
      type: decimal(2, 38),
    });
  });

  it('ontology/object-link-types/derived-properties#limits: the request form takes each expression of the spec', () => {
    const quantity = { type: 'property', apiName: 'quantity' };
    const ratio = { type: 'property', apiName: 'ratio' };
    const day = { type: 'property', apiName: 'day' };

    const cases: readonly [unknown, PropertyType][] = [
      [{ type: 'add', properties: [quantity, quantity] }, INTEGER],
      [{ type: 'multiply', properties: [quantity, ratio, quantity] }, DOUBLE],
      [{ type: 'divide', left: quantity, right: quantity }, DOUBLE],
      [{ type: 'greatest', properties: [day, day] }, DATE],
      [{ type: 'least', properties: [quantity, ratio] }, DOUBLE],
      [{ type: 'absoluteValue', property: quantity }, INTEGER],
      [{ type: 'negate', property: ratio }, DOUBLE],
      [{ type: 'extract', property: day, part: 'QUARTERS' }, INTEGER],
    ];

    for (const [definition, type] of cases)
      expect(accepted(parse(definition, 'Transaction', 'request'))).toMatchObject({ type });
  });

  it('ontology/object-link-types/derived-properties#limits: refuses an expression that has no result type, or a malformed expression', () => {
    const amount = { type: 'property', apiName: 'amount' };
    const quantity = { type: 'property', apiName: 'quantity' };
    const name = { type: 'property', apiName: 'status' };

    expect(refused(parse({ type: 'add', properties: [amount, quantity] }, 'Transaction', 'request')).kind).toBe(
      'shape',
    );

    expect(refused(parse({ type: 'add', properties: [name, name] }, 'Transaction', 'request')).kind).toBe('shape');
    expect(refused(parse({ type: 'add', properties: [quantity] }, 'Transaction', 'request')).kind).toBe('shape');

    expect(
      refused(
        parse(
          { type: 'extract', property: { type: 'property', apiName: 'day' }, part: 'HOURS' },
          'Transaction',
          'request',
        ),
      ).kind,
    ).toBe('shape');

    expect(
      refused(parse({ type: 'negate', property: { type: 'property', apiName: 'missing' } }, 'Transaction', 'request')),
    ).toEqual({ kind: 'notFound', linkOrProperty: 'missing' });
  });

  it('ontology/object-link-types/derived-properties#limits: refuses approximatePercentile in the Object Type form, and takes it in the request form', () => {
    const p95 = selection(around(methodInput, 'transactions'), {
      type: 'approximatePercentile',
      selectedPropertyApiName: 'amount',
      approximatePercentile: 0.95,
    });

    expect(refused(parse(p95, 'Account', 'objectType')).kind).toBe('shape');

    expect(accepted(parse(p95, 'Account', 'request'))).toMatchObject({
      kind: 'selection',
      type: DOUBLE,
      operation: { kind: 'approximatePercentile', percentile: 0.95 },
    });
  });

  it.each([-0.1, 1.1, Number.NaN, '0.5'])(
    'ontology/object-link-types/derived-properties#limits: refuses the percentile %j',
    (percentile) => {
      const definition = selection(around(methodInput, 'transactions'), {
        type: 'approximatePercentile',
        selectedPropertyApiName: 'amount',
        approximatePercentile: percentile,
      });

      expect(refused(parse(definition, 'Account', 'request')).kind).toBe('shape');
    },
  );

  it('ontology/object-link-types/derived-properties#limits: refuses a read of another derived property in the Object Type form, and takes it in the request form', () => {
    const derived = { balance: decimal(2) };
    const read = { type: 'property', apiName: 'balance' };

    expect(refused(parse(read, 'Account', 'objectType', derived)).kind).toBe('shape');

    expect(accepted(parse(read, 'Account', 'request', derived))).toEqual({
      kind: 'property',
      apiName: 'balance',
      type: decimal(2),
    });

    const doubled = { type: 'add', properties: [read, read] };

    expect(accepted(parse(doubled, 'Account', 'request', derived))).toMatchObject({
      kind: 'nary',
      op: 'add',
      type: decimal(2, 38),
    });
  });

  it('ontology/object-link-types/derived-properties#limits: a selected Property is a stored Property, so a selection never reads a derived value', () => {
    const definition = selection(around(methodInput, 'transactions'), propertyOp('sum', 'balance'));

    for (const form of FORMS)
      expect(refused(parse(definition, 'Account', form, { balance: decimal(2) }))).toEqual({
        kind: 'notFound',
        linkOrProperty: 'balance',
      });
  });

  it('ontology/object-link-types/derived-properties#limits: refuses a member that is not methodInput, searchAround, or filter', () => {
    const union = { type: 'union', objectSets: [methodInput] };

    for (const form of FORMS) {
      expect(refused(parse(selection(union, { type: 'count' }), 'Account', form)).kind).toBe('shape');

      expect(
        refused(parse(selection({ type: 'base', objectType: 'Transaction' }, { type: 'count' }), 'Account', form)).kind,
      ).toBe('shape');

      expect(refused(parse({ type: 'literal', value: 1 }, 'Account', form)).kind).toBe('shape');
      expect(refused(parse('balance', 'Account', form)).kind).toBe('shape');

      expect(
        refused(parse(selection(around(methodInput, 'transactions'), { type: 'median' }), 'Account', form)).kind,
      ).toBe('shape');
    }
  });

  it('ontology/object-link-types/derived-properties#limits: a missing Link side or Property gives notFound', () => {
    for (const form of FORMS) {
      expect(refused(parse(selection(around(methodInput, 'missing'), { type: 'count' }), 'Account', form))).toEqual({
        kind: 'notFound',
        linkOrProperty: 'missing',
      });

      expect(
        refused(parse(selection(around(methodInput, 'transactions'), propertyOp('sum', 'missing')), 'Account', form)),
      ).toEqual({ kind: 'notFound', linkOrProperty: 'missing' });
    }
  });

  it('ontology/object-link-types/derived-properties#limits: refuses an operation that does not take the type of its Property', () => {
    for (const form of FORMS) {
      expect(
        refused(parse(selection(around(methodInput, 'transactions'), propertyOp('sum', 'status')), 'Account', form))
          .kind,
      ).toBe('shape');

      expect(
        refused(parse(selection(around(methodInput, 'transactions'), propertyOp('avg', 'day')), 'Account', form)).kind,
      ).toBe('shape');
    }
  });

  it.each([
    ['count', { type: 'count' }, 'Transaction', INTEGER],
    ['sum of an Integer', propertyOp('sum', 'quantity'), 'Transaction', DOUBLE],
    ['avg of a Decimal', propertyOp('avg', 'rate'), 'Transaction', decimal(4, 38)],
    ['min of a Date', propertyOp('min', 'day'), 'Transaction', DATE],
    ['exactDistinct', propertyOp('exactDistinct', 'status'), 'Transaction', INTEGER],
    ['approximateDistinct', propertyOp('approximateDistinct', 'tags'), 'Transaction', INTEGER],
  ] as const)(
    'ontology/object-link-types/derived-properties#limits: parses %s over a hop in both forms',
    (_name, operation, _target, type) => {
      for (const form of FORMS) {
        expect(
          accepted(parse(selection(around(methodInput, 'transactions'), operation), 'Account', form)),
        ).toMatchObject({
          kind: 'selection',
          type,
          path: { hops: 1, single: false, target: { apiName: 'Transaction' } },
        });
      }
    },
  );

  it('ontology/object-link-types/derived-properties#limits: keeps the wire tree in the path, so the read compiler compiles it', () => {
    const tree = filtered(around(methodInput, 'transactions'));
    const node = accepted(parse(selection(tree, { type: 'count' }), 'Account', 'request'));

    expect(node).toMatchObject({ kind: 'selection', path: { objectSet: tree } });
  });

  describe('collect limit', () => {
    const collect = (type: string, limit: unknown) =>
      selection(around(methodInput, 'transactions'), { type, selectedPropertyApiName: 'status', limit });

    it.each([0, -1, 101, 1000, 1.5])(
      'ontology/object-link-types/derived-properties#limits: refuses the collect limit %d in both forms as collectLimit',
      (limit) => {
        for (const form of FORMS) {
          for (const type of ['collectList', 'collectSet'])
            expect(refused(parse(collect(type, limit), 'Account', form))).toEqual({ kind: 'collectLimit', limit });
        }
      },
    );

    it.each([COLLECT_LIMIT.min, 10, COLLECT_LIMIT.max])(
      'ontology/object-link-types/derived-properties#limits: takes the collect limit %d in both forms',
      (limit) => {
        for (const form of FORMS) {
          for (const type of ['collectList', 'collectSet']) {
            expect(accepted(parse(collect(type, limit), 'Account', form))).toMatchObject({
              kind: 'selection',
              type: { kind: 'array', element: STRING },
              operation: { kind: type, limit },
            });
          }
        }
      },
    );

    it('ontology/object-link-types/derived-properties#limits: refuses a collect with no limit as shape', () => {
      for (const form of FORMS)
        expect(refused(parse(collect('collectList', undefined), 'Account', form)).kind).toBe('shape');
    });

    it('ontology/object-link-types/derived-properties#limits: refuses a collect of an array Property, which has no result type', () => {
      const tags = selection(around(methodInput, 'transactions'), {
        type: 'collectList',
        selectedPropertyApiName: 'tags',
        limit: 10,
      });

      for (const form of FORMS) expect(refused(parse(tags, 'Account', form)).kind).toBe('shape');
    });
  });
});

describe('ontology/object-link-types/derived-properties#operations', () => {
  it('ontology/object-link-types/derived-properties#operations: refuses a get after a hop with cardinality MANY in both forms', () => {
    const name = propertyOp('get', 'amount');
    const manyThenOne = selection(around(around(methodInput, 'transactions'), 'category'), propertyOp('get', 'name'));
    const manyThenMany = selection(around(around(methodInput, 'engagements'), 'invoices'), propertyOp('get', 'total'));
    const oneThenMany = selection(around(around(methodInput, 'account'), 'transactions'), name);

    for (const form of FORMS) {
      expect(refused(parse(selection(around(methodInput, 'transactions'), name), 'Account', form)).kind).toBe('shape');
      expect(refused(parse(manyThenOne, 'Account', form)).kind).toBe('shape');
      expect(refused(parse(manyThenMany, 'Account', form)).kind).toBe('shape');
      expect(refused(parse(oneThenMany, 'Transaction', form)).kind).toBe('shape');

      expect(
        accepted(
          parse(
            selection(around(around(methodInput, 'account'), 'transactions'), { type: 'count' }),
            'Transaction',
            form,
          ),
        ),
      ).toMatchObject({ path: { hops: 2, single: false } });
    }
  });

  it('ontology/object-link-types/derived-properties#operations: takes a get after hops that each have cardinality ONE', () => {
    const entity = selection(around(methodInput, 'category'), propertyOp('get', 'name'));
    const invoiceAccount = selection(around(around(methodInput, 'engagement'), 'account'), propertyOp('get', 'name'));

    for (const form of FORMS) {
      expect(accepted(parse(entity, 'Transaction', form))).toMatchObject({
        kind: 'selection',
        type: STRING,
        path: { hops: 1, single: true },
      });

      expect(accepted(parse(invoiceAccount, 'Invoice', form))).toMatchObject({
        kind: 'selection',
        type: STRING,
        path: { hops: 2, single: true, target: { apiName: 'Account' } },
      });
    }
  });

  it('ontology/object-link-types/derived-properties#operations: an aggregation takes a hop with cardinality MANY, and a get keeps the type of the Property', () => {
    expect(
      accepted(parse(selection(around(methodInput, 'category'), propertyOp('get', 'name')), 'Transaction', 'request')),
    ).toMatchObject({ type: STRING });

    expect(
      accepted(
        parse(selection(around(methodInput, 'transactions'), propertyOp('max', 'amount')), 'Account', 'objectType'),
      ),
    ).toMatchObject({ type: decimal(2), path: { single: false } });
  });
});

const step = (linkType: string, linkTypeSide: 'SOURCE' | 'TARGET') => ({
  type: 'searchAround',
  searchAround: { linkTypeIdentifier: { type: 'linkType', linkType }, linkTypeSide },
});

const multiHop = (...steps: ReturnType<typeof step>[]) => ({ type: 'multiHopLink', multiHopLink: { steps } });
const property = (name: string) => ({ type: 'propertyType', propertyType: name });

const aggregated = (linkDefinition: unknown, propertyTypeMapping: unknown) => ({
  type: 'derived',
  derived: {
    definition: { type: 'aggregatedProperties', aggregatedProperties: { linkDefinition, propertyTypeMapping } },
  },
});

const linked = (linkDefinition: unknown, propertyTypeMapping: unknown) => ({
  type: 'derived',
  derived: { definition: { type: 'linkedProperties', linkedProperties: { linkDefinition, propertyTypeMapping } } },
});

function converted(datasource: unknown, objectType: string) {
  if (typeof datasource !== 'object' || datasource === null) throw new Error('A datasource is an object.');

  return orThrow(selectionOf(Object.fromEntries(Object.entries(datasource)), objectTypeNamed(objectType), ONTOLOGY));
}

describe('ontology/object-link-types/derived-properties#forms', () => {
  const accountTransactions = multiHop(step('account-transactions', 'SOURCE'));

  it('ontology/object-link-types/derived-properties#forms: converts each maker datasource kind to 1 selection for each Property', () => {
    const selections = converted(
      aggregated(accountTransactions, {
        balance: { type: 'sum', sum: property('amount') },
        average: { type: 'avg', avg: property('amount') },
        smallest: { type: 'min', min: property('amount') },
        largest: { type: 'max', max: property('amount') },
        transactionCount: { type: 'count', count: {} },
        statusCount: { type: 'approximateCardinality', approximateCardinality: property('status') },
        exactStatusCount: { type: 'exactCardinality', exactCardinality: property('status') },
        statuses: { type: 'collectSet', collectSet: { linkedProperty: property('status'), limit: 5 } },
        statusList: { type: 'collectList', collectList: { linkedProperty: property('status'), limit: 100 } },
      }),
      'Account',
    );

    const around = { type: 'searchAround', objectSet: methodInput, link: 'transactions' };
    const of = (operation: unknown) => ({ type: 'selection', objectSet: around, operation });

    expect(Object.fromEntries(selections)).toEqual({
      balance: of({ type: 'sum', selectedPropertyApiName: 'amount' }),
      average: of({ type: 'avg', selectedPropertyApiName: 'amount' }),
      smallest: of({ type: 'min', selectedPropertyApiName: 'amount' }),
      largest: of({ type: 'max', selectedPropertyApiName: 'amount' }),
      transactionCount: of({ type: 'count' }),
      statusCount: of({ type: 'approximateDistinct', selectedPropertyApiName: 'status' }),
      exactStatusCount: of({ type: 'exactDistinct', selectedPropertyApiName: 'status' }),
      statuses: of({ type: 'collectSet', selectedPropertyApiName: 'status', limit: 5 }),
      statusList: of({ type: 'collectList', selectedPropertyApiName: 'status', limit: 100 }),
    });
  });

  it('ontology/object-link-types/derived-properties#forms: converts linkedProperties to get, over 1 hop and over 2 hops', () => {
    const entity = converted(
      linked(
        { type: 'linkTypeLink', linkTypeLink: step('category-transactions', 'TARGET').searchAround },
        { categoryName: property('name') },
      ),
      'Transaction',
    );

    expect(entity.get('categoryName')).toEqual({
      type: 'selection',
      objectSet: { type: 'searchAround', objectSet: methodInput, link: 'category' },
      operation: { type: 'get', selectedPropertyApiName: 'name' },
    });

    const invoiceAccount = converted(
      linked(multiHop(step('engagement-invoices', 'TARGET'), step('account-engagements', 'TARGET')), {
        accountName: property('name'),
      }),
      'Invoice',
    );

    expect(invoiceAccount.get('accountName')).toEqual({
      type: 'selection',
      objectSet: {
        type: 'searchAround',
        objectSet: { type: 'searchAround', objectSet: methodInput, link: 'engagement' },
        link: 'account',
      },
      operation: { type: 'get', selectedPropertyApiName: 'name' },
    });
  });

  it('ontology/object-link-types/derived-properties#forms: gives the Link side API name of each SOURCE and TARGET step on its Object Type', () => {
    const selections = converted(
      aggregated(multiHop(step('account-engagements', 'SOURCE'), step('engagement-invoices', 'SOURCE')), {
        invoiceCount: { type: 'count', count: {} },
      }),
      'Account',
    );

    expect(selections.get('invoiceCount')?.objectSet).toEqual({
      type: 'searchAround',
      objectSet: { type: 'searchAround', objectSet: methodInput, link: 'engagements' },
      link: 'invoices',
    });
  });

  it.each([
    ['a one-to-many self-link from its SOURCE', 'person-reports', 'SOURCE', 'reports'],
    ['a one-to-many self-link from its TARGET', 'person-reports', 'TARGET', 'manager'],
    ['a many-to-many self-link from its SOURCE', 'person-friends', 'SOURCE', 'friends'],
    ['a many-to-many self-link from its TARGET', 'person-friends', 'TARGET', 'friendOf'],
  ] as const)('ontology/object-link-types/derived-properties#forms: converts %s', (_name, linkType, side, expected) => {
    const selections = converted(
      aggregated(multiHop(step(linkType, side)), { people: { type: 'count', count: {} } }),
      'Person',
    );

    expect(selections.get('people')?.objectSet).toEqual({
      type: 'searchAround',
      objectSet: methodInput,
      link: expected,
    });
  });

  it('ontology/object-link-types/derived-properties#forms: resolves the Link Type by its kebab case ID or its API name', () => {
    const byApiName = converted(
      aggregated(multiHop(step('accountTransactions', 'SOURCE')), { n: { type: 'count', count: {} } }),
      'Account',
    );

    expect(byApiName.get('n')?.objectSet).toEqual({
      type: 'searchAround',
      objectSet: methodInput,
      link: 'transactions',
    });
  });

  it('ontology/object-link-types/derived-properties#forms: sideOf gives the side of each step, and refuses a step that does not connect', () => {
    const account = objectTypeNamed('Account');
    const transaction = objectTypeNamed('Transaction');
    const link = linkTypeNamed('accountTransactions');

    expect(orThrow(sideOf(account, link, 'SOURCE'))).toBe('transactions');
    expect(orThrow(sideOf(transaction, link, 'TARGET'))).toBe('account');
    expect(() => orThrow(sideOf(account, link, 'TARGET'))).toThrow(CompileError);

    expect(() => orThrow(sideOf(transaction, link, 'SOURCE'))).toThrow(
      /Link Type accountTransactions does not connect to Object Type Transaction/,
    );

    const partners = linkTypeNamed('accountPartners');

    expect(orThrow(sideOf(account, partners, 'SOURCE'))).toBe('partners');
    expect(orThrow(sideOf(objectTypeNamed('Engagement'), partners, 'TARGET'))).toBe('partnerAccounts');
  });

  it('ontology/object-link-types/derived-properties#forms: refuses a datasource that does not convert, with a CompileError that names the Object Type', () => {
    const count = { n: { type: 'count', count: {} } };

    const refusals: readonly [string, unknown, string][] = [
      ['no hop', aggregated(multiHop(), count), 'no hop'],
      [
        'a side that does not connect',
        aggregated(multiHop(step('account-transactions', 'TARGET')), count),
        'does not connect',
      ],
      [
        'a Link Type that is not in the Ontology',
        aggregated(multiHop(step('missing-link', 'SOURCE')), count),
        'no Link Type missing-link',
      ],
      [
        'a deleted definition',
        { type: 'derived', derived: { definition: { type: 'deleted', deleted: {} } } },
        'deleted',
      ],
      ['an unknown aggregation', aggregated(accountTransactions, { n: { type: 'median', median: {} } }), 'median'],
      ['a datasource that is not derived', { type: 'datasetV3', datasetV3: {} }, 'not a derived datasource'],
    ];

    for (const [, datasource, message] of refusals) {
      expect(() => converted(datasource, 'Account')).toThrow(CompileError);
      expect(() => converted(datasource, 'Account')).toThrow(/Object Type Account/);
      expect(() => converted(datasource, 'Account')).toThrow(message);
    }
  });

  it('ontology/object-link-types/derived-properties#forms: parseDerived of each converted tree keeps its hops and its operation', () => {
    const selections = converted(
      aggregated(multiHop(step('account-engagements', 'SOURCE'), step('engagement-invoices', 'SOURCE')), {
        invoiceTotal: { type: 'sum', sum: property('total') },
        invoiceCount: { type: 'count', count: {} },
        invoiceIds: { type: 'collectList', collectList: { linkedProperty: property('id'), limit: 7 } },
      }),
      'Account',
    );

    const nodes = [...selections].map(
      ([name, stored]) => [name, accepted(parse(stored, 'Account', 'objectType'))] as const,
    );

    expect(
      Object.fromEntries(
        nodes.map(([name, node]) => [
          name,
          node.kind === 'selection' ? [node.path.hops, node.operation.kind, node.type] : null,
        ]),
      ),
    ).toEqual({
      invoiceTotal: [2, 'sum', decimal(2, 38)],
      invoiceCount: [2, 'count', INTEGER],
      invoiceIds: [2, 'collectList', { kind: 'array', element: STRING }],
    });
  });

  it('ontology/object-link-types/derived-properties#forms: a converted get after a MANY hop is refused by parseDerived', () => {
    const selections = converted(linked(accountTransactions, { amount: property('amount') }), 'Account');
    const stored = selections.get('amount');

    expect(refused(parse(stored, 'Account', 'objectType')).kind).toBe('shape');
  });

  it('ontology/object-link-types/derived-properties#forms: converts the maker README example to the selection that the stock client sends', () => {
    const readme = aggregated(multiHop(step('flight-to-passengers-link', 'SOURCE')), {
      passengersList: { type: 'collectList', collectList: { linkedProperty: property('name'), limit: 100 } },
    });

    const stored = converted(readme, 'Flight').get('passengersList');

    const client = createClient('https://ontology.test', 'ri.ontology.main.ontology.test', async () => 'token');
    const flight: ObjectTypeDefinition = { type: 'object', apiName: 'Flight' };

    const wire = getWireObjectSet(
      client(flight).withProperties({
        passengersList: (builder) =>
          builder.pivotTo('passengersFromFlight').aggregate('name:collectList', { limit: 100 }),
      }),
    );

    expect(wire).toEqual({
      type: 'withProperties',
      objectSet: { type: 'base', objectType: 'Flight' },
      derivedProperties: { passengersList: stored },
    });

    const fromMaker = accepted(parse(stored, 'Flight', 'objectType'));
    const fromClient = accepted(parse(stored, 'Flight', 'request'));

    expect(fromMaker).toMatchObject({
      kind: 'selection',
      path: { hops: 1, single: false, target: { apiName: 'Passenger' } },
      operation: { kind: 'collectList', limit: 100 },
      type: { kind: 'array', element: STRING },
    });

    expect(fromClient).toEqual(fromMaker);
  });
});
