import { expect } from 'vitest';
import { type KeySource, type UserSource } from './auth/index.ts';
import { UserId } from './auth/caller.ts';
import {
  bindReader,
  createDb as createHandlerDb,
  type Db as FallibleDb,
  type Schemas,
  type SnapshotDb as FallibleSnapshotDb,
} from './db/index.ts';
import { createDb, fallibleOf, type Db, type SnapshotDb } from './db/promise.test-utils.ts';
import { ApiError, settle, type AsyncFallible, type Fallible, type Fault } from './errors/index.ts';
import type { HandleInput, Settings } from './handler/index.ts';
import { AUTHKIT_DOMAIN, ORGANIZATION } from './tokens.test-utils.ts';
import { stubPublish } from './workos.test-utils.ts';

export const SCHEMAS: Schemas = { object: 'ontology_1_objects', engine: 'ontology_1_engine' };

export const { reader: TEST_READER, writer: TEST_WRITER } = bindReader(SCHEMAS, {
  userId: UserId.parse('user-1'),
  permissions: [],
  attributes: new Map(),
});

export const TEST_ONTOLOGY_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000';

export const TEST_PRODUCT = { product: 'test', productRid: TEST_ONTOLOGY_RID } as const;

const noDatabase = () => new Error('This test has no database.');

export const noDb: Db = {
  query: () => Promise.reject(noDatabase()),
  stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(noDatabase()) }) }),
  transaction: () => Promise.reject(noDatabase()),
  snapshot: () => Promise.reject(noDatabase()),
};

export const emptyDb: Db = {
  query: () => Promise.resolve([]),
  stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }),
  transaction: (run) => run(emptyDb),
  snapshot: (run) => run(asSnapshot(emptyDb)),
};

export const emptyDbs = { db: fallibleOf(emptyDb) };

export const handlerDb = (pool: Parameters<typeof createDb>[0]): FallibleDb => createHandlerDb(pool);

export function asSnapshot(db: Db): SnapshotDb {
  return db as SnapshotDb;
}

export function trustedSnapshot(db: Db): FallibleSnapshotDb {
  return fallibleOf(db) as FallibleSnapshotDb;
}

export const noSnapshot = trustedSnapshot(noDb);

export const testEnv: Readonly<Record<string, string>> = {
  PRODUCT_RID: TEST_ONTOLOGY_RID,
  ONTOLOGY_ENVIRONMENT: 'staging',
  WORKOS_CLIENT_ID: 'client_test',
  AUTHKIT_DOMAIN,
  ONTOLOGY_BASE_URL: 'http://localhost',
  TRUSTED_GITHUB_REPOSITORY: 'example/test-app',
  TRUSTED_GITHUB_ENVIRONMENT: 'publish-staging',
};

export const testSettings: Settings = {
  productRid: TEST_ONTOLOGY_RID,
  environment: 'staging',
  auth: {
    workosClientId: 'client_test',
    baseUrl: 'http://localhost',
    app: { repository: 'example/test-app', environment: 'publish-staging' },
  },
  authkitDomain: AUTHKIT_DOMAIN,
};

export const testMcpSettings: Settings = { ...testSettings, mcp: true };

export const MEMBER = {
  user: UserId.parse('user_01HMEMBER'),
  kind: 'person',
  organization: ORGANIZATION,
  permissions: [] as readonly string[],
} as const;

const noKey = () => Promise.reject(new Error('This test has no key set.'));

const noKeys: KeySource = { workos: noKey, github: noKey, authkit: noKey };

// oxlint-disable-next-line require-yield -- it never fails.
export async function* given<T>(value: T): AsyncFallible<T, never> {
  return value;
}

async function* faulted(message: string): AsyncFallible<never, Fault> {
  return yield { kind: 'fault', error: new Error(message) };
}

export async function rejecting<T>(run: AsyncFallible<T, ApiError | Fault>): Promise<T> {
  const ran = await settle(run);

  if (ran.ok) return ran.value;

  throw ran.error instanceof ApiError ? ran.error : ran.error.error;
}

export function promised<Args extends unknown[], T>(
  source: (...args: Args) => AsyncFallible<T, ApiError | Fault>,
): (...args: Args) => Promise<T> {
  return (...args) => rejecting(source(...args));
}

export const noUsers: UserSource = {
  get: () => faulted('This test reads no user.'),
  members: () => faulted('This test reads no user.'),
  organizations: () => faulted('This test reads no user.'),
  permissions: () => given([]),
  applications: () => faulted('This test reads no application.'),
  organization: () => faulted('This test reads no Organization.'),
};

export const testInput: HandleInput = {
  db: fallibleOf(emptyDb),
  directDb: fallibleOf(emptyDb),
  settings: testSettings,
  keys: noKeys,
  users: noUsers,
  workos: stubPublish(),
};

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newVersion(...before: readonly string[]): string {
  const matcher = {
    asymmetricMatch: (actual: unknown) =>
      typeof actual === 'string' && /^[1-9][0-9]*$/.test(actual) && actual !== '1' && !before.includes(actual),
    toString: () => `newVersion(${before.join(', ')})`,
    toAsymmetricMatcher: () => `newVersion(${before.join(', ')})`,
  };

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- An asymmetric matcher stands in for a string in toEqual, as expect.any does.
  return matcher as unknown as string;
}

export function errorAnswer(answer: Answer): Answer {
  const { errorInstanceId, ...body } = answer.body as Record<string, unknown>;

  expect(errorInstanceId).toMatch(UUID);

  return { status: answer.status, body };
}

export function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (response.body === null) throw new Error('The answer has no body.');

  return response.body.getReader();
}

// oxlint-disable-next-line require-yield -- it never fails.
export function* timeLeft(): Fallible<number, ApiError> {
  return 1;
}
