import type { OntologyIr } from '@osdk/client.unstable';
import { expect } from 'vitest';
import { createPool, quoteName } from '../db/index.ts';
import { createDb, type Db, fallibleOf, promiseOf } from '../db/promise.test-utils.ts';
import { handle, type HandleInput, type Settings } from '../handler/index.ts';
import type { PublishedFunctions } from '../publish/index.ts';
import { grantsOf, NS, ONTOLOGY_RID, stored } from '../ontology/stored.test-utils.ts';
import { startPostgres } from '../postgres.test-utils.ts';
import { onNewConnection, sql, type TestDatabase } from '../publish/publish.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { errorAnswer, type Answer } from '../service.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { createTestIssuer } from '../tokens.test-utils.ts';
import { stubPublish } from '../workos.test-utils.ts';

export { insertObjects, type ObjectRow } from '../publish/publish.test-utils.ts';

export { errorAnswer, type Answer };

export { NS };

const APP = { repository: 'example/twin', environment: 'publish' };

const settings: Settings = {
  productRid: ONTOLOGY_RID,
  environment: 'test',
  auth: { workosClientId: 'objectSets', baseUrl: 'http://localhost', app: APP },
};

const LOAD_OBJECTS = `/api/v2/ontologies/${ONTOLOGY_RID}/objectSets/loadObjects`;
const AGGREGATE = `/api/v2/ontologies/${ONTOLOGY_RID}/objectSets/aggregate`;
const PUBLISH = '/api/ontology-service/v1/publish';

export interface ObjectSetsService {
  readonly db: Db;
  loadObjects(body: unknown, db?: Db): Promise<Answer>;
  loadObjectsResponse(body: unknown): Promise<Response>;
  aggregate(body: unknown, db?: Db): Promise<Answer>;
  aggregateResponse(body: unknown): Promise<Response>;
  clear(): Promise<void>;
  stop(): Promise<void>;
}

export async function startObjectSets(ir: OntologyIr, functions?: PublishedFunctions): Promise<ObjectSetsService> {
  const postgres = await startPostgres();

  const database = await icuDatabase(postgres.url);

  const issuer = await createTestIssuer(settings.auth);

  const input: HandleInput = {
    db: fallibleOf(database.db),
    directDb: fallibleOf(database.db),
    settings,
    keys: issuer.keys,
    users: roleUsers(grantsOf(ir).defaultRoles),
    workos: stubPublish(),
  };

  const respond = (path: string, token: string, body: unknown, db: Db = promiseOf(input.db)): Promise<Response> => {
    const request = new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    return handle(request, { ...input, db: fallibleOf(db) });
  };

  const send = async (path: string, token: string, body: unknown, db?: Db): Promise<Answer> => {
    const response = await respond(path, token, body, db);

    const text = await response.text();

    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };

  const published = await send(PUBLISH, await issuer.github(), {
    ir,
    ...(functions ? { functions } : {}),
    product: 'twin',
    schemaMigrations: { migrations: [] },
    osdkSet: stored(ir).osdkSet,
    grants: grantsOf(ir),
    validateOnly: false,
  });

  if (published.status !== 200)
    throw new Error(`The publish gave ${published.status}: ${JSON.stringify(published.body)}`);

  await installOnce(database.db, ONTOLOGY_RID, 'twin');

  return {
    db: database.db,
    loadObjects: async (body, db) => send(LOAD_OBJECTS, await issuer.workos(), body, db),
    loadObjectsResponse: async (body) => respond(LOAD_OBJECTS, await issuer.workos(), body),
    aggregate: async (body, db) => send(AGGREGATE, await issuer.workos(), body, db),
    aggregateResponse: async (body) => respond(AGGREGATE, await issuer.workos(), body),
    clear: async () => {
      const tables = await database.db.query<{ name: string }>(
        sql("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'ontology_1_objects'"),
      );

      for (const { name } of tables) await database.db.query(sql(`DELETE FROM ontology_1_objects.${quoteName(name)}`));
    },
    stop: async () => {
      await database.end();

      await postgres.stop();
    },
  };
}

async function icuDatabase(adminUrl: string): Promise<TestDatabase> {
  const url = new URL(adminUrl);
  const name = `${url.username}_object_sets`;

  await onNewConnection(adminUrl, `CREATE DATABASE ${name} TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`);

  url.pathname = `/${name}`;

  const pool = createPool(url.toString());

  return { url: url.toString(), db: createDb(pool), end: () => pool.end() };
}

export function byPrimaryKey(data: unknown): unknown {
  if (!Array.isArray(data)) return data;

  const key = (object: unknown) => String((object as { __primaryKey?: unknown }).__primaryKey);

  return [...data].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
}

export function pageOf(answer: Answer): {
  status: number;
  primaryKeys: unknown;
  nextPageToken: string;
  totalCount: unknown;
  fields: string[];
} {
  const body = answer.body as { data?: unknown; totalCount?: unknown; nextPageToken?: unknown };

  return {
    status: answer.status,
    primaryKeys: Array.isArray(body.data)
      ? body.data.map((object) => (object as { __primaryKey?: unknown }).__primaryKey)
      : body.data,
    nextPageToken: typeof body.nextPageToken,
    totalCount: body.totalCount,
    fields: Object.keys(body).sort(),
  };
}

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'undefined';
}

interface Group {
  readonly group?: unknown;
  readonly metrics?: readonly { readonly name?: unknown }[];
}

function sortedAnswer(answer: Answer, groupsOrdered: boolean): Answer {
  const body = answer.body as { data?: unknown } | null;

  if (body === null || !Array.isArray(body.data)) return answer;

  const data = (body.data as Group[]).map((group) =>
    group.metrics === undefined
      ? group
      : {
          ...group,
          metrics: [...group.metrics].sort((left, right) => byCodePoint(String(left.name), String(right.name))),
        },
  );

  if (!groupsOrdered) data.sort((left, right) => byCodePoint(canonical(left.group), canonical(right.group)));

  return { status: answer.status, body: { ...body, data } };
}

export function expectAggregate(answer: Answer, expected: Answer): void {
  expect(sortedAnswer(answer, false)).toEqual(sortedAnswer(expected, false));
}

export function expectOrderedAggregate(answer: Answer, expected: Answer): void {
  expect(sortedAnswer(answer, true)).toEqual(sortedAnswer(expected, true));
}
