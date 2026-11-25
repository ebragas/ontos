import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bindReader, createPool, type Sql } from '../../db/index.ts';
import { createDb, type Db } from '../../db/promise.test-utils.ts';
import { orThrow } from '../../errors/fallible.ts';
import type { PolicyOperator } from '../../ontology/index.ts';
import { DerivedUses } from './derived.ts';
import { compileObjectSet } from './objectSet.ts';
import { objectReader } from './objects.ts';
import { sortKeys } from './order.ts';
import { pageSql } from './page.ts';
import { readLoadObjectsRequest } from './request.ts';
import { planChanges } from '../../publish/plan.ts';
import { startPostgres, type TestPostgres } from '../../postgres.test-utils.ts';
import { objectType, ontology, property, sql } from '../../publish/publish.test-utils.ts';
import { UserId } from '../../auth/caller.ts';

const SCHEMAS = { object: 'ontology_1_objects', engine: 'ontology_1_engine' };
const INDEX = 'policy_account_allowed_teams_d5a27a94';
const ACCOUNTS = 50_000;

let postgres: TestPostgres;
let pool: pg.Pool;
let db: Db;

function account(operator: PolicyOperator) {
  const type = objectType('Account', 'account', 'accountId', [
    property('accountId', 'account_id', { kind: 'string' }, true),
    property('allowedTeams', 'allowed_teams', { kind: 'array', element: { kind: 'string' } }),
  ]);

  return ontology({
    objectTypes: [
      {
        ...type,
        policy: {
          kind: 'compare',
          object: { kind: 'property', property: 'allowedTeams' },
          operator,
          person: { kind: 'attribute', name: 'teams' as never },
        },
      },
    ],
  });
}

function loadObjects(operator: PolicyOperator): Sql {
  const compiled = account(operator);

  const { reader } = bindReader(SCHEMAS, {
    userId: UserId.parse('user_ann'),
    permissions: ['member'],
    attributes: new Map([['teams', ['t007', 't042']]]),
  });

  const request = orThrow(
    readLoadObjectsRequest({ objectSet: { type: 'base', objectType: 'Account' }, pageSize: 100 }),
  );

  const set = orThrow(compileObjectSet(reader, request.objectSet, compiled, new DerivedUses()));

  const columns = orThrow(
    objectReader(set, request.select, { excludeRid: request.excludeRid, ontologyRid: compiled.productRid }),
  );

  return pageSql(set, columns, orThrow(sortKeys(set, request.orderBy)), request.pageSize);
}

beforeAll(async () => {
  postgres = await startPostgres();

  pool = createPool(postgres.url);

  db = createDb(pool);

  await db.query(sql(`CREATE SCHEMA ${SCHEMAS.object}`));

  for (const change of planChanges(SCHEMAS, account('intersects')))
    for (const statement of change.statements) await db.query(statement);

  await db.query(
    sql(
      `INSERT INTO ${SCHEMAS.object}.account (account_id, allowed_teams)
       SELECT 'acc-' || lpad(i::text, 6, '0'), CASE WHEN i % 50 = 0 THEN NULL
         ELSE ARRAY(SELECT 't' || lpad(((i * 7919 + k * 104729) % 500)::text, 3, '0') FROM generate_series(1, 1 + i % 3) AS k) END
       FROM generate_series(1, $1::int) AS i`,
      ACCOUNTS,
    ),
  );

  await db.query(sql(`ANALYZE ${SCHEMAS.object}.account`));
});

afterAll(async () => {
  await pool?.end();

  await postgres?.stop();
});

function nodesOf(plan: unknown): Record<string, unknown>[] {
  if (Array.isArray(plan)) return plan.flatMap(nodesOf);

  if (typeof plan !== 'object' || plan === null) return [];

  const node = plan as Record<string, unknown>;

  return [...('Node Type' in node ? [node] : []), ...Object.values(node).flatMap(nodesOf)];
}

it.each(['equal', 'intersects', 'subsetOf', 'supersetOf'] as const)(
  'service/storage#indexes: the count and the page of a person who is not an admin scan the policy index for %s, and do no Seq Scan on account',
  async (operator) => {
    const statement = loadObjects(operator);

    const [explained] = await db.query<{ 'QUERY PLAN': unknown }>({
      text: `EXPLAIN (FORMAT JSON) ${statement.text}`,
      values: statement.values,
    });

    const nodes = nodesOf(explained?.['QUERY PLAN']);

    expect(nodes.filter((node) => node['Node Type'] === 'Bitmap Index Scan').map((node) => node['Index Name'])).toEqual(
      [INDEX, INDEX],
    );

    expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'account')).toEqual([]);
  },
);
