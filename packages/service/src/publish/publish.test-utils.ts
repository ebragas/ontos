import type { LinkTypeMetadata, OntologyIrLinkTypeBlockDataV2 } from '@osdk/client.unstable';
import type {
  ActionTypeV2,
  LinkTypeSideV2,
  ObjectPropertyType,
  ObjectTypeFullMetadata,
  OntologyFullMetadata,
} from '@osdk/foundry.ontologies';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect } from 'vitest';
import { createPool, quoteName, type Sql } from '../db/index.ts';
import { createDb, fallibleOf, type Db } from '../db/promise.test-utils.ts';
import { ApiError, settle, type AsyncFallible } from '../errors/index.ts';
import type {
  CompiledActionType,
  CompiledFunction,
  CompiledLinkType,
  CompiledObjectType,
  CompiledOntology,
  CompiledProperty,
  JsonObject,
  JsonValue,
  ListedOsdkSet,
  PropertyType,
} from '../ontology/index.ts';
import { columnName, emptyOntology, publishedActionTypeNames, tableName, type GrantsFile } from '../ontology/index.ts';
import type { CheckedRequest, OsdkSet, PublishResponse } from './index.ts';
import * as install from './install.ts';
import { isInstalled } from '../install.test-utils.ts';
import * as publishing from './publishOntology.ts';
import type { PublishInput, PublishMode } from './publishOntology.ts';
import * as request_ from './pure/request.ts';
import * as reconciling from './workos/reconcile.ts';
import * as upgrading from './upgrade.ts';
import * as versions from './versions.ts';
import * as osdkSets from './pure/osdkSets.ts';
import * as restoring from './restore.ts';
import { testSettings } from '../service.test-utils.ts';
import { engineTemplate } from '../postgres.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';

export const OSDK_SETS_FILE = JSON.parse(
  readFileSync(new URL('../../osdk-sets.json', import.meta.url), 'utf8'),
) as ListedOsdkSet[];

export const OSDK_SET: OsdkSet = OSDK_SETS_FILE[0]?.packages ?? {};

export const NAMESPACE = 'com.example.crm.';

export function property(apiName: string, column: string, type: PropertyType, required = false): CompiledProperty {
  return {
    apiName,
    rid: `ri.ontology.main.property.${apiName}`,
    status: { type: 'experimental' },
    display: {
      displayName: apiName,
      description: undefined,
      visibility: 'NORMAL',
      typeClasses: [],
      structFields: new Map(),
    },
    column,
    type,
    required,
    noEmptyCollections: false,
    searchable: false,
  };
}

export function objectType(
  apiName: string,
  table: string,
  primaryKey: string,
  properties: readonly CompiledProperty[],
): CompiledObjectType {
  const byName = new Map(properties.map((p) => [p.apiName, p]));

  return {
    apiName,
    rid: `ri.ontology.main.object-type.${apiName}`,
    status: 'experimental',
    display: {
      displayName: apiName,
      pluralDisplayName: apiName,
      description: undefined,
      icon: { color: '#4C90F0', locator: 'cube' },
      visibility: 'NORMAL',
    },
    table,
    primaryKey: propertyIn(apiName, byName, primaryKey),
    titleKey: primaryKey,
    properties: byName,
    derived: new Map(),
    links: new Map(),
    joinTables: [],
    uniqueness: [],
  };
}

export function withPrimaryKey(type: CompiledObjectType, apiName: string): CompiledObjectType {
  return { ...type, primaryKey: propertyIn(type.apiName, type.properties, apiName) };
}

export function foreignKey(
  manySide: CompiledObjectType,
  property: string,
  oneSide: CompiledObjectType,
): CompiledLinkType['storage'] {
  return {
    kind: 'foreignKey',
    manySide: manySide.apiName,
    property: propertyIn(manySide.apiName, manySide.properties, property),
    oneSide: oneSide.apiName,
    table: manySide.table,
  };
}

function propertyIn(
  objectType: string,
  properties: ReadonlyMap<string, CompiledProperty>,
  apiName: string,
): CompiledProperty {
  const found = properties.get(apiName);

  if (!found) throw new Error(`The test Object Type ${objectType} has no Property ${apiName}.`);

  return found;
}

export interface OntologyParts {
  readonly objectTypes: readonly CompiledObjectType[];
  readonly linkTypes?: readonly CompiledLinkType[];
  readonly actionTypes?: readonly CompiledActionType[];
  readonly functions?: readonly CompiledFunction[];
}

function dataType(type: PropertyType): ObjectPropertyType {
  switch (type.kind) {
    case 'decimal':
      return { type: 'decimal', precision: type.precision, scale: type.scale };
    case 'array':
      return { type: 'array', subType: dataType(type.element), reducers: [] };
    case 'struct':
      return {
        type: 'struct',
        structFieldTypes: [...type.fields].map(([apiName, field]) => ({
          apiName,
          rid: `ri.ontology.main.struct-field.${apiName}`,
          dataType: dataType(field),
          typeClasses: [],
        })),
      };
    default:
      return { type: type.kind };
  }
}

function linkSides(type: CompiledObjectType, linkTypes: readonly CompiledLinkType[]): LinkTypeSideV2[] {
  const sides: LinkTypeSideV2[] = [];

  const side = (
    link: CompiledLinkType,
    target: string,
    cardinality: 'ONE' | 'MANY',
    foreignKey?: string,
  ): LinkTypeSideV2 => ({
    apiName: link.apiName,
    displayName: link.apiName,
    status: 'EXPERIMENTAL',
    objectTypeApiName: target,
    cardinality,
    ...(foreignKey ? { foreignKeyPropertyApiName: foreignKey } : {}),
    linkTypeRid: link.rid,
  });

  for (const link of linkTypes) {
    const { storage } = link;

    if (storage.kind === 'joinTable') {
      if (storage.a.objectType === type.apiName) sides.push(side(link, storage.b.objectType, 'MANY'));

      if (storage.b.objectType === type.apiName) sides.push(side(link, storage.a.objectType, 'MANY'));
    } else {
      if (storage.manySide === type.apiName) sides.push(side(link, storage.oneSide, 'ONE', storage.property.apiName));

      if (storage.oneSide === type.apiName) sides.push(side(link, storage.manySide, 'MANY'));
    }
  }

  return sides;
}

function objectTypeMetadata(type: CompiledObjectType, linkTypes: readonly CompiledLinkType[]): ObjectTypeFullMetadata {
  return {
    objectType: {
      apiName: type.apiName,
      displayName: type.apiName,
      status: 'EXPERIMENTAL',
      pluralDisplayName: type.apiName,
      icon: { type: 'blueprint', name: 'cube', color: '#4C90F0' },
      primaryKey: type.primaryKey.apiName,
      properties: Object.fromEntries(
        [...type.properties.values()].map((p) => [
          p.apiName,
          { dataType: dataType(p.type), rid: p.rid, status: { type: 'experimental' }, typeClasses: [] },
        ]),
      ),
      rid: type.rid,
      titleProperty: type.titleKey,
      aliases: [],
      datasources: [],
    },
    linkTypes: linkSides(type, linkTypes),
    implementsInterfaces: [],
    implementsInterfaces2: {},
    sharedPropertyTypeMapping: {},
  };
}

function actionTypeMetadata(type: CompiledActionType): ActionTypeV2 {
  const parameters: ActionTypeV2['parameters'] = {};

  for (const parameter of type.parameters.values()) {
    if (parameter.type.kind !== 'object') throw new Error('Only Object parameters in these tests.');

    const objectApiName = parameter.type.objectType;

    parameters[parameter.id] = {
      displayName: parameter.id,
      dataType: { type: 'object', objectApiName, objectTypeApiName: objectApiName },
      required: parameter.required,
      typeClasses: [],
    };
  }

  return { apiName: type.apiName, status: 'ACTIVE', parameters, rid: type.rid, operations: [] };
}

function metadataOf(parts: OntologyParts): OntologyFullMetadata {
  const empty = emptyOntology(testSettings.productRid).metadata;

  return {
    ...empty,
    objectTypes: Object.fromEntries(
      parts.objectTypes.map((t) => [t.apiName, objectTypeMetadata(t, parts.linkTypes ?? [])]),
    ),
    actionTypes: Object.fromEntries((parts.actionTypes ?? []).map((t) => [t.apiName, actionTypeMetadata(t)])),
  };
}

export function ontology(parts: OntologyParts): CompiledOntology {
  return {
    version: 1,
    productRid: testSettings.productRid,
    metadata: metadataOf(parts),
    objectTypes: new Map(parts.objectTypes.map((t) => [t.apiName, t])),
    linkTypes: new Map((parts.linkTypes ?? []).map((t) => [t.apiName, t])),
    actionTypes: new Map((parts.actionTypes ?? []).map((t) => [t.apiName, t])),
    publishedActionTypeNames: publishedActionTypeNames((parts.actionTypes ?? []).map((t) => t.apiName)),
    functions: new Map((parts.functions ?? []).map((f) => [f.apiName, f])),
  };
}

export const LONG_PROPERTY = 'estimatedCompletionTimeForTheScheduledPreventiveMaintenanceVisitInHours';
export const LONG_COLUMN = 'estimated_completion_time_for_the_scheduled_preventive_maintena';

export const workOrder = objectType(`${NAMESPACE}WorkOrder`, 'work_order', 'workOrderId', [
  property('workOrderId', 'work_order_id', { kind: 'string' }, true),
  property('title', 'title', { kind: 'string' }, true),
  property('startDate', 'start_date', { kind: 'date' }),
  property('tags', 'tags', { kind: 'array', element: { kind: 'string' } }),
  property(LONG_PROPERTY, LONG_COLUMN, { kind: 'double' }),
]);

export const technician = objectType(`${NAMESPACE}Technician`, 'technician', 'technicianId', [
  property('technicianId', 'technician_id', { kind: 'string' }, true),
  property('name', 'name', { kind: 'string' }, true),
]);

const technicianWorkOrders: CompiledLinkType = {
  apiName: 'technicianWorkOrders',
  rid: 'ri.ontology.main.relation.technicianWorkOrders',
  status: 'experimental',
  storage: {
    kind: 'joinTable',
    table: 'technician_work_orders',
    a: { objectType: technician.apiName, column: 'technician_id' },
    b: { objectType: workOrder.apiName, column: 'work_order_id' },
  },
};

export function actionTypeDisplay(apiName: string): CompiledActionType['display'] {
  return { displayName: apiName, description: undefined, parameters: new Map() };
}

export const firstOntology = ontology({ objectTypes: [workOrder] });

export const linkedOntology = ontology({ objectTypes: [workOrder, technician], linkTypes: [technicianWorkOrders] });

export const completeWorkOrder: CompiledActionType = {
  apiName: 'completeWorkOrder',
  rid: 'ri.actions.main.action-type.completeWorkOrder',
  status: 'active',
  display: actionTypeDisplay('completeWorkOrder'),
  parameters: new Map([
    [
      'workOrder',
      {
        id: 'workOrder',
        type: { kind: 'object', objectType: `${NAMESPACE}WorkOrder` },
        required: true,
        allowed: { kind: 'objectQuery' },
      },
    ],
  ]),
  criteria: [{ condition: { kind: 'true' }, failureMessage: '' }],
  logic: { kind: 'function', function: 'completeWorkOrder' },
};

export const completeWorkOrderFunction: CompiledFunction = {
  kind: 'edit',
  apiName: 'completeWorkOrder',
  rid: 'ri.function-registry.main.function.completeWorkOrder',
  version: '1.0.0',
  parameters: completeWorkOrder.parameters,
  descriptions: new Map(),
  provenance: { objectTypes: new Set([workOrder.apiName]), linkTypes: new Set() },
};

export const EMPTY_BLOCK = {
  actionTypes: {},
  interfaceTypes: {},
  linkTypes: {},
  objectTypes: {},
  sharedPropertyTypes: {},
};

export const IR: JsonObject = {
  ontology: EMPTY_BLOCK,
  importedOntology: EMPTY_BLOCK,
  valueTypes: { valueTypes: [] },
  importedValueTypes: { valueTypes: [] },
};

export function jsonOf(value: object): JsonObject {
  const json: JsonObject = JSON.parse(JSON.stringify(value));

  return json;
}

export const NO_GRANTS: GrantsFile = { permissions: {}, objectTypes: {}, actionTypes: {}, defaultRoles: {} };

export function request(validateOnly: boolean): CheckedRequest {
  return {
    ir: IR,
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: OSDK_SET,
    grants: NO_GRANTS,
    validateOnly,
  };
}

export const PUBLISHER = 'repo:example/test-app:environment:publish-staging';

export const APPLY: PublishMode = { kind: 'apply' };

export const CHECK: PublishMode = { kind: 'check', scope: 'product' };

export function modeOf(validateOnly: boolean): PublishMode {
  return validateOnly ? CHECK : APPLY;
}

function rejection(failure: unknown): unknown {
  return typeof failure === 'object' && failure !== null && 'kind' in failure && 'error' in failure
    ? failure.error
    : failure;
}

export async function rejecting<T>(run: AsyncFallible<T, unknown>): Promise<T> {
  const ran = await settle(run);

  if (ran.ok) return ran.value;

  throw rejection(ran.error);
}

export { type Db };

export const publishOntology = (db: Db, input: PublishInput): Promise<PublishResponse> =>
  rejecting(publishing.publishOntology(fallibleOf(db), input));

const lockProductVersions = (db: Db) => rejecting(install.lockProductVersions(fallibleOf(db)));
export const lockInstallation = (db: Db, rid: string) => rejecting(install.lockInstallation(fallibleOf(db), rid));

const installIn = (db: Db, ...rest: DropFirst<Parameters<typeof install.installIn>>) =>
  rejecting(install.installIn(fallibleOf(db), ...rest));

export const readNewestVersion = (db: Db, product: string) =>
  rejecting(versions.readNewestVersion(fallibleOf(db), product));

export const readProductVersion = (db: Db, product: string, version: number) =>
  rejecting(upgrading.readProductVersion(fallibleOf(db), product, version));

export const planStep = (db: Db, ...rest: DropFirst<Parameters<typeof upgrading.planStep>>) =>
  rejecting(upgrading.planStep(fallibleOf(db), ...rest));

export const runChain = (db: Db, ...rest: DropFirst<Parameters<typeof upgrading.runChain>>) =>
  rejecting(upgrading.runChain(fallibleOf(db), ...rest));

export const restoreSwitch = (db: Db, ...rest: DropFirst<Parameters<typeof restoring.restoreSwitch>>) =>
  rejecting(restoring.restoreSwitch(fallibleOf(db), ...rest));

export const dropSchema = (db: Db, ...rest: DropFirst<Parameters<typeof restoring.dropSchema>>) =>
  rejecting(restoring.dropSchema(fallibleOf(db), ...rest));

export const readSettledRow = (db: Db, ...rest: DropFirst<Parameters<typeof restoring.readSettledRow>>) =>
  rejecting(restoring.readSettledRow(fallibleOf(db), ...rest));

export const switchInstallation = (db: Db, ...rest: DropFirst<Parameters<typeof restoring.switchInstallation>>) =>
  rejecting(restoring.switchInstallation(fallibleOf(db), ...rest));

export const reconcile = (db: Db, ...rest: DropFirst<Parameters<typeof reconciling.reconcile>>) =>
  rejecting(reconciling.reconcile(fallibleOf(db), ...rest));

type DropFirst<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never;

export function readRequest(body: Parameters<typeof request_.readRequest>[0]): CheckedRequest {
  const ran = settle(request_.readRequest(body));

  if (!ran.ok) throw ran.error;

  return ran.value;
}

export function checkOsdkSet(
  ...args: Parameters<typeof osdkSets.checkOsdkSet>
): ReturnType<typeof osdkSets.checkOsdkSet> extends Generator<unknown, infer T, never> ? T : never {
  const ran = settle(osdkSets.checkOsdkSet(...args));

  if (!ran.ok) throw ran.error;

  return ran.value;
}

export async function publishAndInstall(db: Db, input: PublishInput): Promise<PublishResponse> {
  const response = await publishOntology(db, input);

  const { productRid: rid, product, ontology } = input;

  if (response.version === undefined || (await isInstalled(db, rid))) return response;

  await db.transaction(async (tx) =>
    installIn(
      tx,
      await lockProductVersions(tx),
      { rid, product, apiName: product, displayName: product, organization: ORGANIZATION },
      ontology,
    ),
  );

  return response;
}

export async function expectAllOnNewest(db: Db): Promise<void> {
  const [registry] = await db.query<{ ready: boolean }>(
    sql("SELECT to_regclass('ontology_registry.ontologies') IS NOT NULL AS ready"),
  );

  if (!registry?.ready) return;

  const behind = await db.query<{ rid: string }>(
    sql(`SELECT o.rid FROM ontology_registry.ontologies o
         WHERE o.version < (SELECT max(v.version) FROM ontology_registry.product_versions v WHERE v.product = o.product)`),
  );

  expect(behind).toEqual([]);
}

export interface TestDatabase {
  readonly url: string;
  readonly db: Db;
  end(): Promise<void>;
}

export interface NewDatabaseOptions {
  readonly empty?: boolean;
  readonly template?: string;
}

let databases = 0;

export async function newDatabaseUrl(adminUrl: string, options?: NewDatabaseOptions): Promise<string> {
  const name = `${new URL(adminUrl).username}_publish_${++databases}`;
  const admin = new pg.Client({ connectionString: adminUrl });

  await admin.connect();

  try {
    await admin.query(
      options?.empty
        ? `CREATE DATABASE ${name} TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'und'`
        : `CREATE DATABASE ${name} TEMPLATE ${options?.template ?? engineTemplate()}`,
    );
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);

  url.pathname = `/${name}`;

  return url.toString();
}

export async function newDatabase(adminUrl: string, options?: NewDatabaseOptions): Promise<TestDatabase> {
  const url = await newDatabaseUrl(adminUrl, options);

  const name = new URL(url).pathname.slice(1);
  const pool = createPool(url);

  return {
    url,
    db: createDb(pool),
    end: async () => {
      await pool.end();

      await onNewConnection(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

export async function onNewConnection<Row extends object>(url: string, text: string): Promise<Row[]> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();

  try {
    return (await client.query<Row>(text)).rows;
  } finally {
    await client.end();
  }
}

export async function waitForLockWaits(db: Db, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await db.query<{ waiting: number }>(
          sql(
            "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          ),
        );

        return row?.waiting ?? 0;
      },
      { timeout: 10_000, interval: 20 },
    )
    .toBeGreaterThanOrEqual(count);
}

export function sql(text: string, ...values: unknown[]): Sql {
  return { text, values };
}

export async function tablesOf(db: Db, schema: string): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    sql('SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', schema),
  );

  return rows.map((row) => row.name);
}

export interface Column {
  readonly column_name: string;
  readonly is_nullable: 'YES' | 'NO';
  readonly data_type: string;
  readonly udt_name: string;
}

export function columnsOf(db: Db, table: string): Promise<Column[]> {
  return db.query<Column>(
    sql(
      `SELECT column_name, is_nullable, data_type, udt_name FROM information_schema.columns
       WHERE table_schema = 'ontology_1_objects' AND table_name = $1 ORDER BY ordinal_position`,
      table,
    ),
  );
}

export async function columnTypes(db: Db, table: string): Promise<Record<string, string>> {
  const rows = await db.query<{ column: string; type: string }>(
    sql(
      `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
       WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      `ontology_1_objects.${table}`,
    ),
  );

  return Object.fromEntries(rows.map((row) => [row.column, row.type]));
}

export async function droppedColumns(db: Db, table: string): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    sql(
      'SELECT count(*)::int AS count FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND attisdropped',
      `ontology_1_objects.${table}`,
    ),
  );

  return row?.count ?? -1;
}

export async function refusal(publishing: Promise<unknown>): Promise<ApiError> {
  const error = await publishing.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(ApiError);

  return error as ApiError;
}

export async function roleDefaults(db: Db): Promise<string[]> {
  const rows = await db.query<{ setconfig: string[] }>(
    sql(
      `SELECT setconfig FROM pg_db_role_setting
       WHERE setdatabase = 0 AND setrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
    ),
  );

  return rows.flatMap((row) => row.setconfig);
}

export const EDIT_HISTORY_COLUMNS = ['object_type', 'primary_key', 'entry'] as const;

export type ObjectRow = Readonly<Record<string, JsonValue>>;

export async function insertObjects(db: Db, objectType: string, objects: readonly ObjectRow[]): Promise<void> {
  for (const object of objects) {
    const entries = Object.entries(object);
    const columns = entries.map(([property]) => quoteName(columnName(property)));
    const values = entries.map(([, value]) => (isStruct(value) ? JSON.stringify(value) : value));
    const placeholders = values.map((_, index) => `$${index + 1}`);

    await db.query({
      text: `INSERT INTO ontology_1_objects.${quoteName(tableName(objectType))} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values,
    });
  }
}

function isStruct(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function side(apiName: string): LinkTypeMetadata {
  return {
    apiName,
    displayMetadata: {
      displayName: apiName,
      pluralDisplayName: `${apiName}s`,
      visibility: 'NORMAL',
      groupDisplayName: '',
    },
    typeClasses: [],
  };
}

export interface LinkSide {
  readonly type: string;
  readonly key: string;
  readonly side: string;
}

export function manyToManyLink(id: string, a: LinkSide, b: LinkSide): OntologyIrLinkTypeBlockDataV2 {
  return {
    linkType: {
      definition: {
        type: 'manyToMany',
        manyToMany: {
          objectTypeAToBLinkMetadata: side(a.side),
          objectTypeBToALinkMetadata: side(b.side),
          objectTypeRidA: a.type,
          objectTypeRidB: b.type,
          objectTypeAPrimaryKeyPropertyMapping: [
            { from: { apiName: a.key, object: a.type }, to: { apiName: a.key, object: a.type } },
          ],
          objectTypeBPrimaryKeyPropertyMapping: [
            { from: { apiName: b.key, object: b.type }, to: { apiName: b.key, object: b.type } },
          ],
        },
      },
      id,
      status: { type: 'active', active: {} },
      redacted: false,
    },
    datasources: [],
    entityMetadata: { arePatchesEnabled: true },
  };
}
