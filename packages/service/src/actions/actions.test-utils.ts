import type { OntologyIr } from '@osdk/client.unstable';
import { createPool, quoteName, type Sql } from '../db/index.ts';
import pg from 'pg';
import { createDb as createPromiseDb, type Db, fallibleOf } from '../db/promise.test-utils.ts';
import type { UserSource } from '../auth/index.ts';
import { tableName, type GrantsFile } from '../ontology/index.ts';
import { handle, type HandleInput, type ReportFault, type Settings } from '../handler/index.ts';
import type { PublishedFunctions, SchemaMigration } from '../publish/index.ts';
import { grantsOf, NS, ONTOLOGY_RID, stored, twinIr, unchecked } from '../ontology/stored.test-utils.ts';
import { startPostgres, type TestPostgres } from '../postgres.test-utils.ts';
import {
  insertObjects,
  manyToManyLink,
  newDatabase,
  sql,
  type ObjectRow,
  type TestDatabase,
} from '../publish/publish.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { errorAnswer, newVersion, type Answer } from '../service.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { AUTHKIT_DOMAIN, createTestIssuer, type Claims } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

export { errorAnswer, insertObjects, newVersion, manyToManyLink, type Answer, type ObjectRow };

export { PERSON } from '../tokens.test-utils.ts';

export { NS, ONTOLOGY_RID, twinFunctions, twinIr } from '../ontology/stored.test-utils.ts';

const APP = { repository: 'example/twin', environment: 'publish' };

export const ACTIONS_SETTINGS: Settings = {
  productRid: ONTOLOGY_RID,
  environment: 'test',
  auth: { workosClientId: 'actions', baseUrl: 'http://localhost', app: APP },
  authkitDomain: AUTHKIT_DOMAIN,
  mcp: true,
};

const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const PUBLISH = '/api/ontology-service/v1/publish';
const MCP = '/api/mcp';

export interface SendOptions {
  readonly claims?: Claims;
  readonly db?: Db;
  readonly reportFault?: ReportFault;
  readonly signal?: AbortSignal;
  readonly ontology?: string;
  readonly users?: UserSource;
  readonly settings?: Partial<Settings>;
  readonly service?: true;
}

export interface RawAnswer {
  readonly status: number;
  readonly contentType: string | null;
  readonly text: string;
}

export interface ActionsService {
  readonly db: Db;
  readonly url: string;
  call(method: 'GET' | 'POST', path: string, body?: unknown, options?: SendOptions): Promise<RawAnswer>;
  respond(method: 'GET' | 'POST', path: string, body?: unknown, options?: SendOptions): Promise<Response>;
  apply(actionType: string, body: unknown, options?: SendOptions): Promise<Answer>;
  applyOverMcp(actionType: string, parameters: unknown, options?: SendOptions): Promise<Answer>;
  tool(name: string, args: object, options?: SendOptions): Promise<Answer>;
  editsHistory(objectType: string, body: unknown, options?: SendOptions): Promise<Answer>;
  loadObjects(body: unknown, options?: SendOptions): Promise<Answer>;
  publish(
    ir: OntologyIr,
    functions?: PublishedFunctions,
    grants?: GrantsFile,
    migrations?: readonly SchemaMigration[],
  ): Promise<void>;
  clear(): Promise<void>;
  stop(): Promise<void>;
}

export async function startActions(
  ir: OntologyIr,
  functions?: PublishedFunctions,
  grants?: GrantsFile,
): Promise<ActionsService> {
  const postgres = await startPostgres();

  let database: TestDatabase | undefined;

  try {
    database = await newDatabase(postgres.url);

    return await serve(postgres, database, ir, functions, grants);
  } catch (error) {
    await database?.end();

    await postgres.stop();

    throw error;
  }
}

async function serve(
  postgres: TestPostgres,
  database: TestDatabase,
  ir: OntologyIr,
  functions?: PublishedFunctions,
  grants?: GrantsFile,
): Promise<ActionsService> {
  const issuer = await createTestIssuer(ACTIONS_SETTINGS.auth);

  const input: HandleInput = {
    db: fallibleOf(database.db),
    directDb: fallibleOf(database.db),
    settings: ACTIONS_SETTINGS,
    keys: issuer.keys,
    users: roleUsers((grants ?? grantsOf(ir)).defaultRoles),
    workos: stubPublish(),
  };

  let people = input.users;

  const respond = (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body: unknown,
    { db, reportFault, signal, users, settings }: Omit<SendOptions, 'claims'> = {},
  ): Promise<Response> => {
    const request = new Request(`http://localhost${path}`, {
      method,
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });

    return handle(request, {
      ...input,
      ...(settings ? { settings: { ...input.settings, ...settings } } : {}),
      ...(db ? { db: fallibleOf(db) } : {}),
      ...(reportFault ? { reportFault } : {}),
      users: users ?? people,
    });
  };

  const raw = async (...args: Parameters<typeof respond>): Promise<RawAnswer> => {
    const response = await respond(...args);

    return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
  };

  const send = async (
    path: string,
    token: string,
    body: unknown,
    options: Omit<SendOptions, 'claims'> = {},
  ): Promise<Answer> => {
    const { status, text } = await raw('POST', path, token, body, options);

    return { status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };

  const toolCall = (name: string, args: string) =>
    `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${name}","arguments":${args}}}`;

  const publish = async (
    next: OntologyIr,
    nextFunctions?: PublishedFunctions,
    nextGrants?: GrantsFile,
    migrations: readonly SchemaMigration[] = [],
  ) => {
    const published = nextGrants ?? grantsOf(next);

    const answer = await send(PUBLISH, await issuer.github(), {
      ir: next,
      ...(nextFunctions ? { functions: nextFunctions } : {}),
      product: 'twin',
      schemaMigrations: { migrations },
      osdkSet: stored(next).osdkSet,
      grants: published,
      validateOnly: false,
    });

    if (answer.status !== 200) throw new Error(`The publish gave ${answer.status}: ${JSON.stringify(answer.body)}`);

    people = roleUsers(published.defaultRoles);

    await installOnce(database.db, ONTOLOGY_RID, 'twin');
  };

  await publish(ir, functions, grants);

  return {
    db: database.db,
    url: database.url,
    call: async (method, path, body, options = {}) =>
      raw(
        method,
        path,
        await (options.service ? issuer.m2m(options.claims) : issuer.workos(options.claims)),
        body,
        options,
      ),
    respond: async (method, path, body, options = {}) =>
      respond(
        method,
        path,
        await (options.service ? issuer.m2m(options.claims) : issuer.workos(options.claims)),
        body,
        options,
      ),
    apply: async (actionType, body, options = {}) =>
      send(
        `/api/v2/ontologies/${options.ontology ?? ONTOLOGY_RID}/actions/${actionType}/apply`,
        await issuer.workos(options.claims),
        body,
        options,
      ),
    applyOverMcp: async (actionType, parameters, options = {}) => {
      const rawParameters = typeof parameters === 'string' ? parameters : JSON.stringify(parameters);

      return send(
        MCP,
        await issuer.authkit(options.claims),
        toolCall('apply_action', `{"action":${JSON.stringify(actionType)},"parameters":${rawParameters}}`),
        options,
      );
    },
    tool: async (name, args, options = {}) =>
      send(MCP, await issuer.authkit(options.claims), toolCall(name, JSON.stringify(args)), options),
    editsHistory: async (objectType, body, options = {}) =>
      send(`${ONTOLOGY}/objectTypes/${objectType}/editsHistory`, await issuer.workos(options.claims), body, options),
    loadObjects: async (body, options = {}) =>
      send(`${ONTOLOGY}/objectSets/loadObjects`, await issuer.workos(options.claims), body, options),
    publish,
    clear: async () => {
      const tables = await database.db.query<{ name: string }>(
        sql("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'ontology_1_objects'"),
      );

      for (const { name } of tables) await database.db.query(sql(`DELETE FROM ontology_1_objects.${quoteName(name)}`));

      await database.db.query(sql('DELETE FROM ontology_1_engine.edit_history'));
    },
    stop: async () => {
      await database.end();

      await postgres.stop();
    },
  };
}

export const account = (accountId: string, name: string, phase: string | null): ObjectRow => ({
  accountId,
  name,
  phase,
});

export const engagement = (
  engagementId: string,
  accountId: string,
  title: string,
  amount: number,
  status: string,
  createdAt: string | null,
): ObjectRow => ({
  engagementId,
  accountId,
  title,
  amount,
  status,
  createdAt,
});

export const CLIENT_ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'customer'),
];

export const CLIENT_ENGAGEMENTS = [
  engagement('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won', '2026-10-17T18:20:05.687Z'),
  engagement('eng-2', 'acc-1', 'Ontology build', 48000, 'open', '2026-10-17T18:20:05.839Z'),
  engagement('eng-3', 'acc-1', 'Support retainer', 6000, 'open', '2026-10-17T18:20:05.991Z'),
  engagement('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
  engagement('eng-5', 'acc-3', 'Data audit', 9000, 'won', '2026-10-17T18:20:06.284Z'),
  engagement('eng-6', 'acc-3', 'Migration', 30000, 'open', '2026-10-17T18:20:06.436Z'),
];

export const SEED_ENGAGEMENTS = [
  engagement('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won', '2026-10-17T18:20:05.687Z'),
  engagement('eng-2', 'acc-1', 'Ontology build', 48000, 'race-c', '2026-10-17T18:20:05.839Z'),
  engagement('eng-3', 'acc-1', 'Support retainer', 6000, 'open', '2026-10-17T18:20:05.991Z'),
  engagement('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
  engagement('eng-5', 'acc-3', 'Data audit', 9000, 'won', '2026-10-17T18:20:06.284Z'),
  engagement('eng-6', 'acc-3', 'Migration', 30000, 'cancelled: churned', '2026-10-17T18:20:06.436Z'),
  engagement('eng-7', 'acc-2', 'Expansion', 22000, 'won', '2026-10-17T18:20:08.937Z'),
];

export const ENG_7 = engagement('eng-7', 'acc-2', 'Expansion', 22000, 'open', '2026-10-17T18:20:08.937Z');

export async function seedClient(
  db: Db,
  accounts: readonly ObjectRow[] = CLIENT_ACCOUNTS,
  engagements: readonly ObjectRow[] = CLIENT_ENGAGEMENTS,
): Promise<void> {
  await insertObjects(db, `${NS}Account`, accounts);

  await insertObjects(db, `${NS}Engagement`, engagements);
}

export const parameterValue = (parameterId: string) => ({ type: 'parameterId', parameterId });

export const staticString = (value: string) => ({
  type: 'staticValue',
  staticValue: { type: 'string', string: value },
});

export const addRule = (objectTypeId: string, propertyValues: Record<string, unknown>) => ({
  type: 'addObjectRule',
  addObjectRule: { objectTypeId, propertyValues, structFieldValues: {} },
});

export const modifyRule = (objectToModify: string, propertyValues: Record<string, unknown>) => ({
  type: 'modifyObjectRule',
  modifyObjectRule: { objectToModify, propertyValues, structFieldValues: {} },
});

export const deleteRule = (objectToDelete: string) => ({
  type: 'deleteObjectRule',
  deleteObjectRule: { objectToDelete },
});

interface TestParameter {
  readonly type: unknown;
  readonly allowedValues: unknown;
  readonly required: unknown;
}

export function actionType(
  apiName: string,
  parameters: Record<string, TestParameter>,
  rules: readonly unknown[],
): OntologyIr['ontology']['actionTypes'][string] {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[`${NS}set-engagement-status`]);

  if (!block) throw new Error('The twin 0.6.3 IR has no set-engagement-status.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;
  metadata.parameters = {};
  metadata.parameterOrdering = Object.keys(parameters);

  actionTypeLogic.validation.parameterValidations = {};

  for (const [id, parameter] of Object.entries(parameters)) {
    metadata.parameters[id] = unchecked({
      id,
      type: parameter.type,
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    actionTypeLogic.validation.parameterValidations[id] = unchecked({
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: { allowedValues: parameter.allowedValues, required: parameter.required },
      },
      conditionalOverrides: [],
    });
  }

  actionTypeLogic.logic.rules = unchecked(rules);

  return block;
}

export const parameterResult = (
  result: 'VALID' | 'INVALID',
  required: boolean,
  evaluatedConstraints: unknown[] = [],
) => ({ result, evaluatedConstraints, required });

export function rowsOf(
  db: Db,
  objectType: string,
  orderBy: string,
  schema = 'ontology_1_objects',
): Promise<Record<string, unknown>[]> {
  return db.query(
    sql(`SELECT * FROM ${quoteName(schema)}.${quoteName(tableName(objectType))} ORDER BY ${quoteName(orderBy)}`),
  );
}

export function countingDb(db: Db, failCommit: boolean): { readonly db: Db; readonly transactions: () => number } {
  let transactions = 0;

  const wrapped: Db = {
    query: <Row extends object>(sql: Sql) => db.query<Row>(sql),
    stream: <Row extends object>(sql: Sql) => db.stream<Row>(sql),
    snapshot: (run) => db.snapshot(run),
    transaction: (run) => {
      transactions += 1;

      return db.transaction(async (tx) => {
        const result = await run(tx);

        if (failCommit) throw new Error('The test stops the write transaction before its commit.');

        return result;
      });
    },
  };

  return { db: wrapped, transactions: () => transactions };
}

export function invalidValue(objectType: string, property: string, builderErrorMessage: string): Answer {
  return {
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'ApplyActionFailed',
      parameters: {
        originalErrorName: 'Ontos:InvalidActionPropertyFormat',
        objectType,
        property,
        userErrorMessage: 'The Action could not apply because a Property value is invalid.',
        builderErrorMessage,
      },
    },
  };
}

export const NO_PRIMARY_KEY = {
  status: 400,
  body: {
    errorCode: 'INVALID_ARGUMENT',
    errorName: 'ApplyActionFailed',
    parameters: {
      originalErrorName: 'Ontos:InvalidPrimaryKeyPropertyType',
      userErrorMessage: 'The Action could not apply because of a primary key issue.',
      builderErrorMessage: 'The primary key Property requires a valid value of its declared type.',
    },
  },
};

const promiseDb = (pool: pg.Pool): Db => createPromiseDb(pool);

export function poolDb(url: string): { readonly db: Db; readonly pool: pg.Pool } {
  const pool = createPool(url);

  return { db: promiseDb(pool), pool };
}

export function recordingDb(
  url: string,
  after: (text: string) => Promise<void> = async () => {},
): { readonly db: Db; readonly pool: pg.Pool; readonly statements: string[] } {
  const pool = createPool(url, { max: 1 });
  const connect = pool.connect.bind(pool);
  const statements: string[] = [];
  const recorded = new WeakSet<pg.PoolClient>();

  const patched = async () => {
    const client = await connect();

    if (recorded.has(client)) return client;

    recorded.add(client);

    const query = client.query.bind(client) as (text: unknown, values?: unknown) => Promise<unknown>;

    const recording = async (text: unknown, values?: unknown) => {
      const statement = typeof text === 'string' ? text : (text as { text: string }).text;

      statements.push(statement);

      const result = await query(text, values);

      await after(statement);

      return result;
    };

    return Object.assign(client, { query: recording });
  };

  return { db: promiseDb(Object.assign(pool, { connect: patched })), pool, statements };
}

export async function transactionWait(db: Db): Promise<void> {
  for (let tries = 0; tries < 250; tries += 1) {
    const [row] = await db.query<{ waiting: number }>(
      sql(
        "SELECT count(*)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND l.locktype = 'transactionid' AND a.datname = current_database()",
      ),
    );

    if ((row?.waiting ?? 0) > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('No session waited for another transaction.');
}

export type Call = 'query' | 'stream' | 'transaction' | 'snapshot';

export function racingDb(
  db: Db,
  change: Sql | (() => Promise<unknown>),
  times: number,
): { readonly db: Db; readonly calls: Call[]; readonly transactions: () => number } {
  const calls: Call[] = [];
  let left = times;

  const raced: Db = {
    query: <Row extends object>(statement: Sql) => {
      calls.push('query');

      return db.query<Row>(statement);
    },
    stream: <Row extends object>(statement: Sql) => {
      calls.push('stream');

      return db.stream<Row>(statement);
    },
    snapshot: (run) => {
      calls.push('snapshot');

      return db.snapshot(run);
    },
    transaction: async (run) => {
      calls.push('transaction');

      if (left > 0) {
        left -= 1;

        await (typeof change === 'function' ? change() : db.query(change));
      }

      return db.transaction(run);
    },
  };

  return { db: raced, calls, transactions: () => calls.filter((call) => call === 'transaction').length };
}
