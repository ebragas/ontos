import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, afterEach } from 'vitest';
import { createPool } from '../db/index.ts';
import { applyEngineChanges, createDb, type Db } from '../db/promise.test-utils.ts';
import type { OntologyIr } from '@osdk/client.unstable';
import type { JsonObject } from '../ontology/index.ts';

import type { CheckedRequest } from './index.ts';
import { installOntology } from '../install.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  APPLY,
  expectAllOnNewest,
  NO_GRANTS,
  objectType,
  onNewConnection,
  ontology,
  property,
  publishAndInstall,
  PUBLISHER,
  publishOntology,
  request,
  sql,
} from './publish.test-utils.ts';
import { TEST_PRODUCT } from '../service.test-utils.ts';
import {
  convertOrThrow,
  irOf,
  ONTOLOGY_RID,
  stored,
  stringProperty,
  twinObjectType,
  unchecked,
} from '../ontology/stored.test-utils.ts';

const SERVICE_ROLE = 'ontology_service_role';
const OTHER_ROLE = 'other_app_role';
const DATABASE = 'ordinary_role';
const SERVICE_PASSWORD = 'service-role-test-only';
const OTHER_PASSWORD = 'other-role-test-only';

const job = ontology({
  objectTypes: [
    objectType('com.example.crm.Job', 'job', 'jobId', [
      property('jobId', 'job_id', { kind: 'string' }, true),
      { ...property('title', 'title', { kind: 'string' }), searchable: true },
    ]),
  ],
});

let postgres: TestPostgres;
let serviceUrl: string;
let otherUrl: string;
let pool: pg.Pool;
let db: Db;

function urlAs(user: string, password: string): string {
  const url = new URL(postgres.url);

  url.username = user;
  url.password = password;
  url.pathname = `/${DATABASE}`;

  return url.toString();
}

beforeAll(async () => {
  postgres = await startPostgres();

  const admin = new pg.Client({ connectionString: postgres.url });

  await admin.connect();

  try {
    await admin.query(
      `CREATE ROLE ${SERVICE_ROLE} LOGIN PASSWORD '${SERVICE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );

    await admin.query(
      `CREATE ROLE ${OTHER_ROLE} LOGIN PASSWORD '${OTHER_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );

    await admin.query(`CREATE DATABASE ${DATABASE}`);

    await admin.query(`GRANT CREATE ON DATABASE ${DATABASE} TO ${SERVICE_ROLE}`);
  } finally {
    await admin.end();
  }

  serviceUrl = urlAs(SERVICE_ROLE, SERVICE_PASSWORD);

  otherUrl = urlAs(OTHER_ROLE, OTHER_PASSWORD);

  pool = createPool(serviceUrl);

  db = createDb(pool);

  await applyEngineChanges(db);

  await publishAndInstall(db, {
    ...TEST_PRODUCT,
    ontology: job,
    request: request(false),
    publisher: PUBLISHER,
    mode: APPLY,
  });
});

afterAll(async () => {
  await pool?.end();

  await postgres?.stop();
});

afterEach(() => expectAllOnNewest(db));

async function otherRoleError(text: string): Promise<string | undefined> {
  return onNewConnection(otherUrl, text).then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

describe('an ordinary role', () => {
  it('service/storage#schema-and-access: the role of the Ontology service runs the engine changes and an applied publish with no superuser and no BYPASSRLS', async () => {
    const [role] = await db.query(
      sql(
        `SELECT r.rolsuper, r.rolbypassrls,
           (SELECT d.datdba = r.oid FROM pg_database d WHERE d.datname = current_database()) AS owns_database,
           has_database_privilege(current_user, current_database(), 'CREATE') AS can_create
         FROM pg_roles r WHERE r.rolname = current_user`,
      ),
    );

    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owns_database: false, can_create: true });

    const versions = await db.query(sql('SELECT version FROM ontology_registry.product_versions'));

    expect(versions).toEqual([{ version: 1 }]);
  });

  it('service/storage#ownership: the engine changes create the trusted extension pg_trgm with only the CREATE privilege, and the text search index uses it', async () => {
    const extensions = await db.query(
      sql(
        `SELECT e.extname, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'pg_trgm'`,
      ),
    );

    expect(extensions).toEqual([{ extname: 'pg_trgm', schema: 'ontology_registry' }]);

    const indexes = await db.query<{ indexdef: string }>(
      sql(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'ontology_1_objects' AND tablename = 'job' AND indexdef LIKE '%USING gin%'",
      ),
    );

    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toMatch(/ USING gin \(title ontology_registry\.gin_trgm_ops\)$/);
  });

  it('service/storage#ownership service/storage#registry: with only CREATE, install makes an Ontology with its text indexes, and a publish that adds a Searchable Property builds its index', async () => {
    const publishIr = async (ir: OntologyIr) => {
      const checked: CheckedRequest = {
        product: 'roles',
        ir: unchecked<JsonObject>(ir),
        schemaMigrations: { migrations: [] },
        osdkSet: stored(ir).osdkSet,
        grants: NO_GRANTS,
        validateOnly: false,
      };

      return publishOntology(db, {
        product: 'roles',
        productRid: ONTOLOGY_RID,
        ontology: convertOrThrow(checked, ONTOLOGY_RID, 1),
        request: checked,
        publisher: PUBLISHER,
        mode: APPLY,
      });
    };

    const account = twinObjectType('Account');

    await publishIr(irOf(account));

    const { schemas } = await installOntology(db, {
      rid: 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111',
      product: 'roles',
      apiName: 'roles',
      displayName: 'roles',
      organization: 'org_01TEST0RG00000000000000001',
    });

    account.objectType.propertyTypes['notes'] = stringProperty('notes');

    expect((await publishIr(irOf(account))).version).toBe(2);

    const indexes = await db.query(
      sql(
        "SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1 AND indexdef LIKE '% ontology_registry.gin_trgm_ops)' ORDER BY 1",
        schemas.object,
      ),
    );

    expect([schemas.object, indexes]).toEqual([
      'ontology_2_objects',
      [
        { name: 'trgm_account_account_id_1287ecd9' },
        { name: 'trgm_account_name_42403a5e' },
        { name: 'trgm_account_notes_ce0ac767' },
        { name: 'trgm_account_phase_21379d9a' },
      ],
    ]);
  });

  it('service/storage#connection: ALTER ROLE CURRENT_USER SET of the publish reaches a new session of the role', async () => {
    const fresh = await onNewConnection(
      serviceUrl,
      `SELECT current_setting('statement_timeout') AS statement_timeout,
         current_setting('idle_in_transaction_session_timeout') AS idle`,
    );

    expect(fresh).toEqual([{ statement_timeout: '1min', idle: '90s' }]);
  });

  it('service/storage#schema-and-access: with row-level security on, the role reads and writes its rows', async () => {
    const tables = await db.query(
      sql(
        `SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' AND n.nspname IN ('ontology_registry', 'ontology_1_objects', 'ontology_1_engine') ORDER BY 1, 2`,
      ),
    );

    expect(tables).toEqual([
      { schema: 'ontology_1_engine', table: 'edit_history', rls: true },
      { schema: 'ontology_1_objects', table: 'job', rls: true },
      { schema: 'ontology_registry', table: 'engine_changes', rls: true },
      { schema: 'ontology_registry', table: 'ontologies', rls: true },
      { schema: 'ontology_registry', table: 'product_versions', rls: true },
    ]);

    const policies = await db.query(
      sql(
        `SELECT schemaname AS schema, tablename AS table, cmd, array_to_string(roles, ',') AS roles, qual, with_check
         FROM pg_policies WHERE schemaname IN ('ontology_registry', 'ontology_1_objects', 'ontology_1_engine') ORDER BY 1, 2`,
      ),
    );

    const policy = (schema: string, table: string) => ({
      schema,
      table,
      cmd: 'ALL',
      roles: SERVICE_ROLE,
      qual: 'true',
      with_check: 'true',
    });

    expect(policies).toEqual([
      policy('ontology_1_engine', 'edit_history'),
      policy('ontology_1_objects', 'job'),
      policy('ontology_registry', 'engine_changes'),
      policy('ontology_registry', 'ontologies'),
      policy('ontology_registry', 'product_versions'),
    ]);

    await db.query(sql("INSERT INTO ontology_1_objects.job (job_id, title) VALUES ('job-1', 'Fix the pump')"));

    await db.query(sql("UPDATE ontology_1_objects.job SET title = 'Fix the main pump' WHERE job_id = 'job-1'"));

    const rows = await db.query(sql('SELECT job_id, title FROM ontology_1_objects.job'));

    expect(rows).toEqual([{ job_id: 'job-1', title: 'Fix the main pump' }]);
  });

  it('service/storage#schema-and-access: a second ordinary role cannot use the 3 schemas', async () => {
    const [privileges] = await onNewConnection(
      otherUrl,
      `SELECT has_schema_privilege('ontology_1_objects', 'USAGE') AS objects_usage,
         has_schema_privilege('ontology_1_engine', 'USAGE') AS engine_usage,
         has_schema_privilege('ontology_registry', 'USAGE') AS registry_usage,
         has_schema_privilege('ontology_1_objects', 'CREATE') AS objects_create,
         has_schema_privilege('ontology_1_engine', 'CREATE') AS engine_create,
         has_schema_privilege('ontology_registry', 'CREATE') AS registry_create`,
    );

    expect(privileges).toEqual({
      objects_usage: false,
      engine_usage: false,
      registry_usage: false,
      objects_create: false,
      engine_create: false,
      registry_create: false,
    });

    expect(await otherRoleError('SELECT * FROM ontology_1_objects.job')).toBe('42501');

    expect(await otherRoleError('SELECT * FROM ontology_registry.product_versions')).toBe('42501');

    expect(await otherRoleError("INSERT INTO ontology_1_objects.job (job_id, title) VALUES ('job-2', 'x')")).toBe(
      '42501',
    );
  });
});
