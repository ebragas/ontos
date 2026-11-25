import type { OntologyIr, OntologyIrLinkTypeBlockDataV2, OntologyIrObjectTypeBlockDataV2 } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  compileOrThrow,
  irOf,
  NS,
  renamed,
  stored,
  stringProperty,
  twinObjectType,
} from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  columnsOf,
  jsonOf,
  manyToManyLink,
  newDatabase,
  NO_GRANTS,
  OSDK_SET,
  publishAndInstall,
  PUBLISHER,
  sql,
  type TestDatabase,
  APPLY,
  expectAllOnNewest,
} from './publish.test-utils.ts';
import { TEST_PRODUCT } from '../service.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const TECHNICIAN = `${NS}Technician`;
const CERTIFICATION = `${NS}Certification`;

let postgres: TestPostgres;
let database: TestDatabase;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(() => postgres?.stop());

beforeEach(async () => {
  database = await newDatabase(postgres.url);
});

afterEach(async () => {
  await expectAllOnNewest(database.db);

  await database.end();
});

function keyedOnId(name: string, primaryKey: string, apiName: string): OntologyIrObjectTypeBlockDataV2 {
  const block = renamed(twinObjectType(name), apiName);
  const others = Object.entries(block.objectType.propertyTypes).filter(([key]) => key !== primaryKey);

  block.objectType.propertyTypes = { ...Object.fromEntries(others), id: stringProperty('id') };
  block.objectType.primaryKeys = ['id'];

  return block;
}

async function publish(
  objectTypes: OntologyIrObjectTypeBlockDataV2[],
  link: OntologyIrLinkTypeBlockDataV2,
): Promise<void> {
  const ir: OntologyIr = irOf(...objectTypes);

  ir.ontology.linkTypes[link.linkType.id] = link;

  await publishAndInstall(database.db, {
    ...TEST_PRODUCT,
    ontology: compileOrThrow(stored(ir)),
    request: {
      ir: jsonOf(ir),
      product: 'twin',
      schemaMigrations: { migrations: [] },
      osdkSet: OSDK_SET,
      grants: NO_GRANTS,
      validateOnly: false,
    },
    publisher: PUBLISHER,
    mode: APPLY,
  });
}

async function columnNames(table: string): Promise<string[]> {
  return (await columnsOf(database.db, table)).map((column) => column.column_name);
}

async function indexesOf(table: string): Promise<{ primary: boolean; method: string; columns: string[] }[]> {
  return database.db.query(
    sql(
      `SELECT i.indisprimary AS primary, am.amname AS method,
         array(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.n) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_am am ON am.oid = c.relam
       WHERE i.indrelid = to_regclass($1)
       ORDER BY i.indisprimary DESC, columns`,
      `ontology_1_objects.${table}`,
    ),
  );
}

async function primaryKeyOf(table: string): Promise<string[] | undefined> {
  return (await indexesOf(table)).find((index) => index.primary)?.columns;
}

const ACCOUNT_ENGAGEMENTS = manyToManyLink(
  'account-engagements',
  { type: ACCOUNT, key: 'accountId', side: 'engagements' },
  { type: ENGAGEMENT, key: 'engagementId', side: 'accounts' },
);

describe('the 2 columns of a join table', () => {
  it('service/storage#links: 2 Object Types with different primary key names give the columns a_account_id and b_engagement_id', async () => {
    await publish([twinObjectType('Account'), twinObjectType('Engagement')], ACCOUNT_ENGAGEMENTS);

    expect(await columnNames('account_engagements')).toEqual(['a_account_id', 'b_engagement_id']);

    expect(await primaryKeyOf('account_engagements')).toEqual(['a_account_id', 'b_engagement_id']);
  });

  it('service/storage#links: side A gives the a_ column also when its Object Type sorts last by API name', async () => {
    await publish(
      [twinObjectType('Account'), twinObjectType('Engagement')],
      manyToManyLink(
        'engagement-accounts',
        { type: ENGAGEMENT, key: 'engagementId', side: 'accounts' },
        { type: ACCOUNT, key: 'accountId', side: 'engagements' },
      ),
    );

    expect(await columnNames('engagement_accounts')).toEqual(['a_engagement_id', 'b_account_id']);

    expect(await primaryKeyOf('engagement_accounts')).toEqual(['a_engagement_id', 'b_account_id']);
  });

  it('service/storage#links: a self-link gives the 2 different columns a_account_id and b_account_id', async () => {
    await publish(
      [twinObjectType('Account')],
      manyToManyLink(
        'account-partners',
        { type: ACCOUNT, key: 'accountId', side: 'partners' },
        { type: ACCOUNT, key: 'accountId', side: 'partnerOf' },
      ),
    );

    expect(await columnNames('account_partners')).toEqual(['a_account_id', 'b_account_id']);

    expect(await primaryKeyOf('account_partners')).toEqual(['a_account_id', 'b_account_id']);
  });

  it('service/storage#links: 2 primary keys with the same name id give the columns a_id and b_id', async () => {
    await publish(
      [keyedOnId('Account', 'accountId', TECHNICIAN), keyedOnId('Engagement', 'engagementId', CERTIFICATION)],
      manyToManyLink(
        'technician-certifications',
        { type: TECHNICIAN, key: 'id', side: 'certifications' },
        { type: CERTIFICATION, key: 'id', side: 'technicians' },
      ),
    );

    expect(await columnNames('technician_certifications')).toEqual(['a_id', 'b_id']);

    expect(await primaryKeyOf('technician_certifications')).toEqual(['a_id', 'b_id']);
  });
});

describe('the indexes of a join table', () => {
  it('service/storage#indexes: the primary key (a, b) indexes the a column, and a btree indexes the b column', async () => {
    await publish([twinObjectType('Account'), twinObjectType('Engagement')], ACCOUNT_ENGAGEMENTS);

    expect(await indexesOf('account_engagements')).toEqual([
      { primary: true, method: 'btree', columns: ['a_account_id', 'b_engagement_id'] },
      { primary: false, method: 'btree', columns: ['b_engagement_id'] },
    ]);
  });
});
