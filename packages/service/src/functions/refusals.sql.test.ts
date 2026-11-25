import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  errorAnswer,
  NS,
  ONTOLOGY_RID,
  rowsOf,
  seedClient,
  startActions,
  type ActionsService,
  type SendOptions,
} from '../actions/actions.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import { asSnapshot } from '../service.test-utils.ts';
import { actionOf, editsIr, withFunctions, type TestFunction } from './functions.test-utils.ts';

type Db = NonNullable<SendOptions['db']>;

type Snapshot = Parameters<Parameters<Db['snapshot']>[0]>[0];

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SPONSORS = 'engagementSponsors';
const accountId = { name: 'accountId', type: 'string' as const };
const edits = { name: 'edits', type: 'string' as const };

const FUNCTIONS: TestFunction[] = [
  ...[
    'throwError',
    'throwUserFacing',
    'throwNamedUserFacing',
    'refuseNamed',
    'refuseUnknown',
    'throwString',
    'throwObject',
    'callFetch',
    'throwInTimer',
    'lateClient',
    'readName',
    'readAndIgnoreFailure',
    'notInBundle',
    'returnBigInt',
  ].map((apiName): TestFunction => ({ apiName, inputs: [accountId], edits: [ACCOUNT] })),
  { apiName: 'readObjectInput', inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }], edits: [ACCOUNT] },
  {
    apiName: 'readObjectList',
    inputs: [{ name: 'accounts', type: 'objectList', objectType: ACCOUNT }],
    edits: [ACCOUNT],
  },
  { apiName: 'rawEdits', inputs: [edits], edits: [ACCOUNT, ENGAGEMENT], links: [SPONSORS] },
  { apiName: 'accountOnly', inputs: [edits], edits: [ACCOUNT] },
];

const SOURCE = `
import { createEditBatch, UserFacingError } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };

export const functions = {
  throwError: async () => { throw new Error('a plain error'); },
  throwUserFacing: async () => { throw new UserFacingError('a user-facing error'); },
  throwNamedUserFacing: async () => {
    const error = new Error('a named user-facing error');
    error.name = 'UserFacingError';
    throw error;
  },
  refuseNamed: async () => { throw Object.assign(new UserFacingError('accountId must match'), { parameterId: 'accountId' }); },
  refuseUnknown: async () => { throw Object.assign(new UserFacingError('accountId must match'), { parameterId: 'acountId' }); },
  throwString: async () => { throw 'a thrown string'; },
  throwObject: async () => { throw { code: 7 }; },
  callFetch: async () => { await fetch('https://example.com/'); return []; },
  throwInTimer: async () => {
    setTimeout(() => { throw new Error('a throw in a timer'); }, 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return [];
  },
  // The request of the client comes after the call ends, in the second turn of the event loop after its return.
  lateClient: async (client, accountId) => {
    const late = () => { client(Account).fetchOne(accountId).catch(() => undefined); };
    setImmediate(() => setImmediate(() => setImmediate(late)));
    return [];
  },
  readName: async (client, accountId) => {
    const account = await client(Account).fetchOne(accountId);
    const batch = createEditBatch(client);
    batch.create(Account, { accountId: 'report', name: account.name });
    return batch.getEdits();
  },
  returnBigInt: async () => [{ type: 'createObject', obj: { type: 'object', apiName: '${ACCOUNT}' }, properties: { accountId: 1n } }],
  readAndIgnoreFailure: async (client, accountId) => {
    try {
      await client(Account).fetchOne(accountId);
    } catch {
      // The Function goes on as if the read gave nothing.
    }
    return [];
  },
  readAndIgnoreFailure: async (client, accountId) => {
    try {
      await client(Account).fetchOne(accountId);
    } catch {
      // The Function goes on as if the read gave nothing.
    }
    return [];
  },
  readObjectInput: async () => [],
  readObjectList: async () => [],
  rawEdits: async (client, edits) => JSON.parse(edits),
  accountOnly: async (client, edits) => JSON.parse(edits),
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, editsIr());

  service = await startActions(ir, functions);
}, 120_000);

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

async function answerOf(
  apiName: string,
  parameters: Record<string, unknown>,
  options: SendOptions = {},
): Promise<unknown> {
  const { status, contentType, text } = await service.call(
    'POST',
    `/api/v2/ontologies/${ONTOLOGY_RID}/actions/${actionOf(apiName)}/apply`,
    { parameters, options: EXECUTE },
    options,
  );

  const parsed = text === '' ? null : (JSON.parse(status >= 400 ? text : text.replace(UUID, '<uuid>')) as unknown);

  const accounts = (await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row['account_id']);

  return { status, contentType, body: status >= 400 ? errorAnswer({ status, body: parsed }).body : parsed, accounts };
}

interface Case {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

const recorded = (name: string, run: () => Promise<unknown>): Case => ({ name, run });

function pin(cases: readonly Case[]): void {
  for (const { name, run } of cases) {
    it(name, async () => {
      expect(await run()).toMatchSnapshot();
    });
  }
}

const account = (primaryKey: unknown) => ({ $apiName: ACCOUNT, $primaryKey: primaryKey });
const engagement = (primaryKey: string) => ({ $apiName: ENGAGEMENT, $primaryKey: primaryKey });

const create = (key: string) => ({
  type: 'createObject',
  obj: { type: 'object', apiName: ACCOUNT },
  properties: { accountId: key, name: 'n' },
});

const update = (key: string) => ({ type: 'updateObject', obj: account(key), properties: { name: 'n' } });
const remove = (key: string) => ({ type: 'deleteObject', obj: account(key) });

const link = (type: 'addLink' | 'removeLink', source: object, apiName: string, target: object) => ({
  type,
  source,
  apiName,
  target,
});

const sponsors = (type: 'addLink' | 'removeLink', accountKey: string, engagementKey: string) =>
  link(type, account(accountKey), 'sponsoredEngagements', engagement(engagementKey));

const raw = (returned: unknown, apiName = 'rawEdits') => answerOf(apiName, { edits: JSON.stringify(returned) });

describe('a Function that fails', () => {
  pin([
    recorded('a thrown Error', () => answerOf('throwError', { accountId: 'acc-1' })),
    recorded('a UserFacingError', () => answerOf('throwUserFacing', { accountId: 'acc-1' })),
    recorded('an Error that is named UserFacingError', () => answerOf('throwNamedUserFacing', { accountId: 'acc-1' })),
    recorded('a UserFacingError with the parameterId of a parameter', () =>
      answerOf('refuseNamed', { accountId: 'acc-1' }),
    ),
    recorded('a UserFacingError with a parameterId that names no parameter', () =>
      answerOf('refuseUnknown', { accountId: 'acc-1' }),
    ),
    recorded('a thrown string', () => answerOf('throwString', { accountId: 'acc-1' })),
    recorded('a thrown object', () => answerOf('throwObject', { accountId: 'acc-1' })),
    recorded('a call of fetch', () => answerOf('callFetch', { accountId: 'acc-1' })),
    recorded('a throw in a timer', () => answerOf('throwInTimer', { accountId: 'acc-1' })),
    recorded('a request of the client after the end of the call', () => answerOf('lateClient', { accountId: 'acc-1' })),
    recorded('a BigInt in an edit', () => answerOf('returnBigInt', { accountId: 'acc-1' })),
    recorded('a Function that the bundle does not hold', () => answerOf('notInBundle', { accountId: 'acc-1' })),
  ]);
});

describe('the Object inputs', () => {
  pin([
    recorded('an Object input that does not exist', () => answerOf('readObjectInput', { account: 'p-missing' })),
    recorded('an Object list input with an Object that does not exist', () =>
      answerOf('readObjectList', { accounts: ['acc-1', 'p-missing'] }),
    ),
  ]);
});

function failingReads(): Db {
  const { db } = service;

  const watch = (snapshot: Snapshot): Snapshot =>
    asSnapshot({
      query: <Row extends object>(sql: Parameters<Snapshot['query']>[0]) =>
        sql.text.includes('FROM "ontology_1_objects"."account"')
          ? Promise.reject(new Error('The test fails each read of the Account table in the snapshot.'))
          : snapshot.query<Row>(sql),
      stream: <Row extends object>(sql: Parameters<Snapshot['query']>[0]) => {
        if (!sql.text.includes('FROM "ontology_1_objects"."account"')) return snapshot.stream<Row>(sql);

        return (async function* () {
          await Promise.reject(new Error('The test fails each read of the Account table in the snapshot.'));

          yield* snapshot.stream<Row>(sql);
        })();
      },
      snapshot: (run) => snapshot.snapshot(run),
      transaction: (run) => snapshot.transaction(run),
    });

  return {
    ...db,
    query: (sql) => db.query(sql),
    stream: (sql) => db.stream(sql),
    transaction: (run) => db.transaction(run),
    snapshot: (run) => db.snapshot((s) => run(watch(s))),
  };
}

describe('a request of the Function client that gets a 5xx', () => {
  pin([
    recorded('a failed read in the snapshot', () =>
      answerOf('readName', { accountId: 'acc-1' }, { db: failingReads() }),
    ),
    recorded('a failed read that the Function ignores', () =>
      answerOf('readAndIgnoreFailure', { accountId: 'acc-1' }, { db: failingReads() }),
    ),
  ]);
});

describe('the edits of a Function', () => {
  pin([
    recorded('a result that is no list', () => raw(7)),
    recorded('an edit of an unknown kind', () => raw([{ type: 'nope' }])),
    recorded('an edit of an Interface', () => raw([{ type: 'createObjectForInterface' }])),
    recorded('a create with no Object Type definition', () =>
      raw([{ type: 'createObject', properties: { accountId: 'acc-new' } }]),
    ),
    recorded('a create of an Object Type that the Edits type does not name', () =>
      raw(
        [
          {
            type: 'createObject',
            obj: { type: 'object', apiName: ENGAGEMENT },
            properties: { engagementId: 'eng-new' },
          },
        ],
        'accountOnly',
      ),
    ),
    recorded('a create with a Property that the Object Type does not have', () =>
      raw([
        {
          type: 'createObject',
          obj: { type: 'object', apiName: ACCOUNT },
          properties: { accountId: 'acc-new', nmae: 'n' },
        },
      ]),
    ),
    recorded('a create with no String primary key', () =>
      raw([{ type: 'createObject', obj: { type: 'object', apiName: ACCOUNT }, properties: { accountId: 7 } }]),
    ),
    recorded('an update with no String $primaryKey', () =>
      raw([{ type: 'updateObject', obj: account(7), properties: { name: 'n' } }]),
    ),
    recorded('a Link edit with no source', () =>
      raw([{ type: 'addLink', apiName: 'sponsoredEngagements', target: engagement('eng-1') }]),
    ),
    recorded('a Link edit of a Link that the source does not have', () =>
      raw([link('addLink', account('acc-1'), 'sponsors', engagement('eng-1'))]),
    ),
    recorded('a Link edit of a Link that is not many-to-many', () =>
      raw([link('addLink', account('acc-1'), 'engagements', engagement('eng-1'))]),
    ),
    recorded('a Link edit of a Link Type that the Edits type does not name', () =>
      raw([sponsors('addLink', 'acc-1', 'eng-1')], 'accountOnly'),
    ),
    recorded('a Link edit with a target of another Object Type', () =>
      raw([link('addLink', account('acc-1'), 'sponsoredEngagements', account('acc-2'))]),
    ),
    recorded('a Link edit after a create and a delete of its Object', () =>
      raw([create('acc-new'), remove('acc-new'), sponsors('addLink', 'acc-new', 'eng-1')]),
    ),
    recorded('an update after a create and a delete', () =>
      raw([create('acc-new'), remove('acc-new'), update('acc-new')]),
    ),
    recorded('a delete after a delete', () => raw([remove('acc-1'), remove('acc-1')])),
    recorded('an update after a delete', () => raw([remove('acc-1'), update('acc-1')])),
    recorded('a create after a delete', () => raw([remove('acc-1'), create('acc-1')])),
    recorded('2 creates of 1 Object', () => raw([create('acc-new'), create('acc-new')])),
    recorded('a create after an update', () => raw([update('acc-1'), create('acc-1')])),
  ]);
});

const RUN_SPANS = ['function run', 'worker wait', 'worker call'];

async function runSpansOf(): Promise<unknown[]> {
  const spans = (await routeSpans())
    .filter((span) => RUN_SPANS.includes(span.name))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  return spans.map((span) => ({
    name: span.name,
    status: SpanStatusCode[span.status.code],
    errorType: span.attributes['error.type'] ?? null,
  }));
}

async function tracedAnswerOf(
  apiName: string,
  options: SendOptions = {},
  parameters: Record<string, unknown> = { accountId: 'acc-1' },
): Promise<unknown> {
  const { status, body } = (await answerOf(apiName, parameters, options)) as {
    status: number;
    body: { errorName?: string };
  };

  return { status, errorName: body.errorName ?? null, spans: await runSpansOf() };
}

describe('the spans of a Function run that fails', () => {
  pin([
    recorded('a thrown Error', () => tracedAnswerOf('throwError')),
    recorded('a thrown string', () => tracedAnswerOf('throwString')),
    recorded('a call of fetch', () => tracedAnswerOf('callFetch')),
    recorded('a throw in a timer', () => tracedAnswerOf('throwInTimer')),
    recorded('a request of the client after the end of the call', () => tracedAnswerOf('lateClient')),
    recorded('a BigInt in an edit', () => tracedAnswerOf('returnBigInt')),
    recorded('a Function that the bundle does not hold', () => tracedAnswerOf('notInBundle')),
    recorded('an Object input that does not exist', () =>
      tracedAnswerOf('readObjectInput', {}, { account: 'p-missing' }),
    ),
    recorded('a failed read in the snapshot', () => tracedAnswerOf('readName', { db: failingReads() })),
    recorded('a failed read that the Function ignores', () =>
      tracedAnswerOf('readAndIgnoreFailure', { db: failingReads() }),
    ),
    recorded('a Function that runs', () => tracedAnswerOf('readName')),
  ]);
});
