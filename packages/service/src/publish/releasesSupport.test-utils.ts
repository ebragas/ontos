import { ontologyEngineChanges } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import type { GrantsFile, JsonObject } from '../ontology/index.ts';
import { irOf, renamed, twinObjectType, USE } from '../ontology/stored.test-utils.ts';
import type { OsdkSet } from './index.ts';
import { asSnapshot, TEST_ONTOLOGY_RID, TEST_PRODUCT } from '../service.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import {
  EMPTY_BLOCK,
  firstOntology,
  IR,
  jsonOf,
  OSDK_SET,
  publishAndInstall,
  PUBLISHER,
  request,
  sql,
  modeOf,
} from './publish.test-utils.ts';

export { OSDK_SETS_FILE } from './publish.test-utils.ts';

export const LISTED_SET: OsdkSet = OSDK_SET;

export const LATER_SET: OsdkSet = { ...LISTED_SET, '@osdk/client': '999.0.0' };

export const INTERFACE_IR: JsonObject = {
  ...IR,
  ontology: { ...EMPTY_BLOCK, interfaceTypes: { 'com.example.crm.Asset': {} } },
};

const MEMBER_GRANTS: GrantsFile = {
  permissions: { [USE]: { description: 'Use the twin' } },
  objectTypes: Object.fromEntries([...firstOntology.objectTypes.keys()].map((name) => [name, USE])),
  actionTypes: {},
  defaultRoles: { member: [USE] },
};

export function irNaming(names: readonly string[]): JsonObject {
  return jsonOf(irOf(...names.map((name) => renamed(twinObjectType('Account'), name))));
}

export const FIRST_IR: JsonObject = irNaming([...firstOntology.objectTypes.keys()]);

export function publishFirst(db: Db, validateOnly: boolean, osdkSet: OsdkSet = LISTED_SET, ir: JsonObject = IR) {
  return publishAndInstall(db, {
    ...TEST_PRODUCT,
    ontology: firstOntology,
    request: { ...request(validateOnly), osdkSet, grants: MEMBER_GRANTS, ir },
    publisher: PUBLISHER,
    mode: modeOf(validateOnly),
  });
}

const ENGINE_CHANGE_COUNT = ontologyEngineChanges({ object: '', engine: '' }).length;

export async function storeVersion(db: Db, version: number, osdkSet: OsdkSet, ir: object = IR): Promise<void> {
  await db.query(
    sql(
      `INSERT INTO ontology_registry.product_versions (product, version, ir, metadata, schema_migrations, osdk_set, functions, publisher)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NULL, $7)`,
      TEST_PRODUCT.product,
      version,
      JSON.stringify(ir),
      JSON.stringify(firstOntology.metadata),
      JSON.stringify({ migrations: [] }),
      JSON.stringify(osdkSet),
      PUBLISHER,
    ),
  );

  await db.query(
    sql(
      `INSERT INTO ontology_registry.ontologies (rid, api_name, display_name, object_schema, engine_schema, product, version, organization, engine_change_count)
       VALUES ($1, $2, $2, 'ontology_1_objects', 'ontology_1_engine', $2, $3, $4, $5)
       ON CONFLICT (rid) DO UPDATE SET version = EXCLUDED.version`,
      TEST_ONTOLOGY_RID,
      TEST_PRODUCT.product,
      version,
      ORGANIZATION,
      ENGINE_CHANGE_COUNT,
    ),
  );
}

export interface StoredRow {
  readonly version: number;
  readonly osdk_set: OsdkSet;
  readonly metadata: string;
}

export function storedVersions(db: Db): Promise<StoredRow[]> {
  return db.query<StoredRow>(
    sql(
      'SELECT version, osdk_set, metadata::text AS metadata FROM ontology_registry.product_versions ORDER BY version',
    ),
  );
}

export async function workOrderTableExists(db: Db): Promise<boolean> {
  const [row] = await db.query<{ found: boolean }>(
    sql("SELECT to_regclass('ontology_1_objects.work_order') IS NOT NULL AS found"),
  );

  return row?.found ?? false;
}

export function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

export function recording(db: Db, statements: string[]): Db {
  return {
    query: (statement) => {
      statements.push(statement.text);

      return db.query(statement);
    },
    stream: (statement) => {
      statements.push(statement.text);

      return db.stream(statement);
    },
    transaction: (run) => db.transaction((tx) => run(recording(tx, statements))),
    snapshot: (run) => db.snapshot((tx) => run(asSnapshot(recording(tx, statements)))),
  };
}
