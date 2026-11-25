import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import { seedClient } from '../actions/actions.test-utils.ts';
import { irOf, twinBlock, twinIr } from '../ontology/stored.test-utils.ts';
import { NS, startObjectSets, type ObjectSetsService } from './objectSets.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

const IR = irOf(twinBlock('0.6.3', ACCOUNT), twinBlock('0.6.3', ENGAGEMENT));
const LINK = twinIr('0.6.3').ontology.linkTypes['account-to-engagements'];

if (!LINK) throw new Error('The twin 0.6.3 IR has no Link Type account-to-engagements.');

IR.ontology.linkTypes['account-to-engagements'] = structuredClone(LINK);

let service: ObjectSetsService;

beforeAll(async () => {
  service = await startObjectSets(IR);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

function recording(): { db: ObjectSetsService['db']; statements: Sql[] } {
  const statements: Sql[] = [];

  const db: ObjectSetsService['db'] = {
    query: (sql) => service.db.query(sql),
    stream: (sql) => {
      statements.push(sql);

      return service.db.stream(sql);
    },
    transaction: (run) => service.db.transaction(run),
    snapshot: (run) => service.db.snapshot(run),
  };

  return { db, statements };
}

const base = (objectType: string) => ({ type: 'base', objectType });
const filter = (objectSet: unknown, where: unknown) => ({ type: 'filter', objectSet, where });

const load = (objectSet: unknown, fields: Record<string, unknown> = {}) => ({
  objectSet,
  select: [],
  excludeRid: true,
  ...fields,
});

const CUSTOMERS = filter(base(ACCOUNT), { type: 'eq', field: 'phase', value: 'customer' });
const ACME = filter(base(ACCOUNT), { type: 'eq', field: 'accountId', value: 'acc-1' });
const ENGAGEMENTS = { type: 'searchAround', objectSet: CUSTOMERS, link: 'engagements' };

const LOADS = {
  'the load of each Property': load(base(ACCOUNT)),
  'the load of named Properties': load(base(ACCOUNT), { select: ['name'] }),
  'a where of each query kind': load(
    filter(base(ENGAGEMENT), {
      type: 'and',
      value: [
        { type: 'gt', field: 'amount', value: 5000 },
        { type: 'not', value: { type: 'eq', field: 'status', value: 'lost' } },
        { type: 'in', propertyIdentifier: { type: 'property', apiName: 'status' }, value: ['open', 'won'] },
        { type: 'isNull', field: 'title', value: false },
        { type: 'containsAnyTerm', field: 'title', value: 'build' },
      ],
    }),
  ),
  'union, intersect, and subtract': load({
    type: 'subtract',
    objectSets: [
      { type: 'union', objectSets: [CUSTOMERS, ACME] },
      { type: 'intersect', objectSets: [CUSTOMERS, ACME] },
    ],
  }),
  'a filter after a searchAround': load(filter(ENGAGEMENTS, { type: 'lt', field: 'amount', value: 40000 })),
};

describe('the read statement of each member and each read compiler', () => {
  for (const [name, body] of Object.entries(LOADS)) {
    it(`ontology/ontology-sdk/object-sets#members: ${name} has the same statement text`, async () => {
      const { db, statements } = recording();

      expect((await service.loadObjects(body, db)).status).toBe(200);

      expect(statements).toMatchSnapshot();
    });
  }

  it('ontology/ontology-sdk/object-sets#members: an orderBy and the page token of the next page have the same statement text', async () => {
    const { db, statements } = recording();

    const body = load(base(ENGAGEMENT), {
      select: ['title'],
      orderBy: { fields: [{ field: 'status', direction: 'desc' }, { field: 'amount' }] },
      pageSize: 2,
    });

    const first = await service.loadObjects(body, db);

    const token = (first.body as { nextPageToken?: unknown }).nextPageToken;

    expect(typeof token).toBe('string');

    expect((await service.loadObjects({ ...body, pageToken: token }, db)).status).toBe(200);

    expect(statements).toMatchSnapshot();
  });

  it('ontology/ontology-sdk/object-sets#members: the metrics with no group-by have the same statement text', async () => {
    const { db, statements } = recording();

    const body = {
      objectSet: ENGAGEMENTS,
      aggregation: [
        { type: 'count' },
        { type: 'sum', field: 'amount' },
        { type: 'avg', field: 'amount' },
        { type: 'min', field: 'createdAt' },
        { type: 'max', propertyIdentifier: { type: 'property', apiName: 'amount' } },
        { type: 'exactDistinct', field: 'status' },
      ],
      groupBy: [],
    };

    expect((await service.aggregate(body, db)).status).toBe(200);

    expect(statements).toMatchSnapshot();
  });

  it('ontology/ontology-sdk/object-sets#members: each group-by kind has the same statement text', async () => {
    const { db, statements } = recording();

    const bodies = [
      [{ type: 'exact', field: 'status', defaultValue: 'none' }],
      [{ type: 'fixedWidth', field: 'amount', fixedWidth: 10000 }],
      [{ type: 'ranges', field: 'amount', ranges: [{ startValue: 0, endValue: 10000 }] }],
      [{ type: 'duration', field: 'createdAt', value: 1, unit: 'DAYS' }],
    ].map((groupBy) => ({
      objectSet: base(ENGAGEMENT),
      aggregation: [{ type: 'count' }, { type: 'max', field: 'amount', direction: 'DESC' }],
      groupBy,
    }));

    for (const body of bodies) expect((await service.aggregate(body, db)).status).toBe(200);

    expect(statements).toMatchSnapshot();
  });
});
