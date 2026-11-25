import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edit } from './index.ts';
import { quoteName, type Sql } from '../db/index.ts';
import { tableName } from '../ontology/index.ts';
import { ScriptedFunctions, ScriptedUserFacingError, withFunctions } from '../functions/functions.test-utils.ts';
import { propertyOfType, renamed, STRING_FLAGS, twinObjectType, unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { testIr } from './parametersSupport.test-utils.ts';
import {
  actionType,
  addRule,
  deleteRule,
  errorAnswer,
  insertObjects,
  manyToManyLink,
  modifyRule,
  NS,
  ONTOLOGY_RID,
  racingDb,
  rowsOf,
  seedClient,
  startActions,
  staticString,
  type ActionsService,
  type SendOptions,
} from './actions.test-utils.ts';

type Db = NonNullable<SendOptions['db']>;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CREATE_ACCOUNT = `${NS}create-account`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;
const SET_RELATIONSHIP_ACTION = `${NS}set-relationship-action`;
const PROBE_VERSION_CHECK = `${NS}probe-version-check-action`;
const CHECK_TYPES = `${NS}check-parameter-types`;
const LIST_OBJECTS = `${NS}refusal-list-objects`;
const CREATE_TWICE = `${NS}refusal-create-twice`;
const DELETE_THEN_MODIFY = `${NS}refusal-delete-then-modify`;
const DELETE_THEN_LINK = `${NS}refusal-delete-then-link`;
const VALUE_PROBE = `${NS}ValueProbe`;

const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
const REQUIRED = { type: 'required', required: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };

const objectParameter = (objectTypeId: string) => ({
  type: { type: 'objectReference', objectReference: { objectTypeId } },
  allowedValues: OBJECT_QUERY,
  required: REQUIRED,
});

const linkRule = (sourceObject: string, targetObject: string) => ({
  type: 'addLinkRule',
  addLinkRule: { linkTypeId: 'engagement-sponsors', sourceObject, targetObject },
});

function refusalIr(): OntologyIr {
  const ir = testIr();

  const sponsors = manyToManyLink(
    'engagement-sponsors',
    { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
    { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
  );

  ir.ontology.linkTypes[sponsors.linkType.id] = sponsors;

  const probe = renamed(twinObjectType('Account'), VALUE_PROBE);

  const labels = propertyOfType('labels', {
    type: 'array',
    array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
  } as Parameters<typeof propertyOfType>[1]);

  probe.objectType.propertyTypes['labels'] = unchecked({
    ...labels,
    dataConstraints: { propertyTypeConstraints: [], nullabilityV2: { noNulls: true, noEmptyCollections: true } },
  });

  ir.ontology.objectTypes[VALUE_PROBE] = probe;

  const engagementAndAccount = { engagement: objectParameter(ENGAGEMENT), account: objectParameter(ACCOUNT) };
  const created = addRule(ENGAGEMENT, { engagementId: staticString('eng-twice'), title: staticString('Twice') });

  const blocks: ActionTypeBlock[] = [
    actionType(
      LIST_OBJECTS,
      {
        engagements: {
          type: { type: 'objectReferenceList', objectReferenceList: { objectTypeId: ENGAGEMENT } },
          allowedValues: OBJECT_QUERY,
          required: NO_LIST_LENGTH,
        },
      },
      [],
    ),
    actionType(CREATE_TWICE, {}, [created, created]),
    actionType(DELETE_THEN_MODIFY, { engagement: objectParameter(ENGAGEMENT) }, [
      deleteRule('engagement'),
      modifyRule('engagement', { title: staticString('Retitled') }),
    ]),
    actionType(DELETE_THEN_LINK, engagementAndAccount, [deleteRule('account'), linkRule('engagement', 'account')]),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = unchecked(block);

  return ir;
}

const MANY_TYPES = Array.from({ length: 51 }, (_, index) => `${NS}Type${index}`);

function scriptedIr(): OntologyIr {
  const ir = refusalIr();

  for (const apiName of MANY_TYPES) ir.ontology.objectTypes[apiName] = renamed(twinObjectType('Account'), apiName);

  return ir;
}

let service: ActionsService;
let scripted: ScriptedFunctions;

beforeAll(async () => {
  const ir = scriptedIr();

  scripted = new ScriptedFunctions(
    ir,
    `probeVersionCheck: async (client, account, engagementId, mode) => {
    if (mode === 'read-only') await client({ type: 'object', apiName: '${ENGAGEMENT}' }).where({ engagementId }).fetchPage();
    return answer(client, { args: [account.$primaryKey, engagementId, mode] });
  },`,
  );

  const { functions } = await withFunctions([], scripted.source, ir);

  const discovered = functions.discovered.map((fn) =>
    fn.locator.typescript?.functionName === 'probeVersionCheck'
      ? unchecked<typeof fn>({
          ...fn,
          ontologyProvenance: {
            editedObjects: Object.fromEntries(
              [ACCOUNT, ENGAGEMENT, VALUE_PROBE, ...MANY_TYPES].map((type) => [type, {}]),
            ),
            editedLinks: { engagementSponsors: {} },
            editedInterfaces: {},
          },
        })
      : fn,
  );

  service = await startActions(ir, { ...functions, discovered });
}, 120_000);

afterAll(() => {
  scripted?.close();

  return service?.stop();
});

beforeEach(async () => {
  scripted.reset();

  await service.clear();

  await seedClient(service.db);
});

afterEach(() => {
  vi.useRealTimers();
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function answerOf(path: string, body: unknown, options: SendOptions = {}): Promise<unknown> {
  const { status, contentType, text } = await service.call(
    'POST',
    `/api/v2/ontologies/${ONTOLOGY_RID}${path}`,
    body,
    options,
  );

  const parsed = text === '' ? null : (JSON.parse(text) as unknown);

  return { status, contentType, body: status >= 400 ? errorAnswer({ status, body: parsed }).body : parsed };
}

const apply = (action: string, body: unknown, options?: SendOptions) =>
  answerOf(`/actions/${action}/apply`, body, options);

const execute = (action: string, parameters: unknown, options?: SendOptions) =>
  apply(action, { parameters, options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' } }, options);

const history = (objectType: string, body: unknown, options?: SendOptions) =>
  answerOf(`/objectTypes/${objectType}/editsHistory`, body, options);

async function overMcp(action: string, parameters: unknown, options?: SendOptions): Promise<unknown> {
  const { status, body } = await service.applyOverMcp(action, parameters, options);

  return { status, body: JSON.parse(JSON.stringify(body).replace(UUID, '<uuid>')) as unknown };
}

const statusOf = async (engagementId: string) =>
  (await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).find((row) => row['engagement_id'] === engagementId)?.[
    'status'
  ];

const setEng2 = (options?: SendOptions) =>
  execute(SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 'eng-2', status: 'won' }, options);

async function written(options: SendOptions): Promise<unknown> {
  return { answer: await setEng2(options), status: await statusOf('eng-2') };
}

function refusing(refuse: (statement: Sql) => boolean, code: string): Db {
  const raise = {
    text: `DO $$ BEGIN RAISE EXCEPTION 'refused by the test' USING ERRCODE = '${code}'; END $$`,
    values: [],
  };

  return inWrite((statement, tx) => (refuse(statement) ? tx.query(raise) : undefined));
}

function inWrite(step: (statement: Sql, tx: Db) => Promise<unknown> | undefined, committed?: () => void): Db {
  const base = service.db;

  return {
    query: (statement) => base.query(statement),
    stream: (statement) => base.stream(statement),
    snapshot: (run) => base.snapshot(run),
    transaction: async (run) => {
      const result = await base.transaction((tx) =>
        run({
          ...tx,
          query: async <Row extends object>(statement: Sql) =>
            ((await step(statement, tx)) as Row[] | undefined) ?? tx.query<Row>(statement),
        }),
      );

      committed?.();

      return result;
    },
  };
}

function atFirstQuery(first: () => void): Db {
  const base = service.db;
  let done = false;

  return {
    query: (statement) => {
      if (!done) first();

      done = true;

      return base.query(statement);
    },
    stream: (statement) => base.stream(statement),
    snapshot: (run) => base.snapshot(run),
    transaction: (run) => base.transaction(run),
  };
}

function atOpen(open: () => void): Db {
  const base = service.db;

  return {
    query: (statement) => base.query(statement),
    stream: (statement) => base.stream(statement),
    snapshot: (run) => base.snapshot(run),
    transaction: (run) =>
      base.transaction((tx) => {
        open();

        return run(tx);
      }),
  };
}

function failingStream(): Db {
  const base = service.db;

  return {
    query: (statement) => base.query(statement),
    // oxlint-disable-next-line require-yield -- the stream fails before its first row.
    stream: async function* () {
      throw new Error('The test fails the stream before its first row.');
    },
    snapshot: (run) => base.snapshot(run),
    transaction: (run) => base.transaction(run),
  };
}

function failingAfter(row: object): Db {
  const base = service.db;

  return {
    query: (statement) => base.query(statement),
    stream: async function* <Row extends object>() {
      yield row as Row;

      throw new Error('The test fails the stream after its first row.');
    },
    snapshot: (run) => base.snapshot(run),
    transaction: (run) => base.transaction(run),
  };
}

async function withEngagementsMoved<T>(run: () => Promise<T>): Promise<T> {
  const name = tableName(ENGAGEMENT);

  await service.db.query(
    sql(`ALTER TABLE ontology_1_objects.${quoteName(name)} RENAME TO ${quoteName(`${name}_moved`)}`),
  );

  try {
    return await run();
  } finally {
    await service.db.query(
      sql(`ALTER TABLE ontology_1_objects.${quoteName(`${name}_moved`)} RENAME TO ${quoteName(name)}`),
    );
  }
}

function clock(): (ms: number) => void {
  vi.useFakeTimers({ toFake: ['Date'] });

  vi.setSystemTime(Date.now());

  const arrived = Date.now();

  return (ms) => vi.setSystemTime(arrived + ms);
}

const isEdit = (statement: Sql) =>
  statement.text.startsWith('UPDATE ') || statement.text.startsWith('INSERT INTO "ontology_1_objects"');

const isLock = (statement: Sql) => statement.text.includes('FOR UPDATE');

const changeEng2 = sql(
  "UPDATE ontology_1_objects.engagement SET title = 'Raced', __version = __version + 1 WHERE engagement_id = 'eng-2'",
);

const functionGives = (edits: readonly Edit[]) => scripted.once(() => edits);
const locator = (objectType: string, primaryKey: string) => ({ objectType, primaryKey });

const modify = (objectType: string, primaryKey: string, properties: Record<string, unknown>): Edit => ({
  type: 'modifyObject',
  object: locator(objectType, primaryKey),
  properties: new Map(Object.entries(properties)) as Extract<Edit, { type: 'modifyObject' }>['properties'],
});

const create = (objectType: string, primaryKey: string, properties: Record<string, unknown> = {}): Edit => ({
  type: 'addObject',
  object: locator(objectType, primaryKey),
  properties: new Map(Object.entries(properties)) as Extract<Edit, { type: 'addObject' }>['properties'],
});

const runProbe = (options?: SendOptions) =>
  execute(PROBE_VERSION_CHECK, { account: 'acc-1', engagementId: 'eng-2', mode: 'blind-edit', delayMs: 0 }, options);

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

describe('apply: the route and the body', () => {
  pin([
    recorded('an unknown Action Type', () => execute('nope', {})),
    recorded('a body that is not an object', () => apply(SET_ENGAGEMENT_STATUS, [])),
    recorded('parameters that are not an object', () => apply(SET_ENGAGEMENT_STATUS, { parameters: [] })),
    recorded('options that are not an object', () => apply(SET_ENGAGEMENT_STATUS, { parameters: {}, options: 1 })),
    recorded('an unknown mode', () => apply(SET_ENGAGEMENT_STATUS, { parameters: {}, options: { mode: 'NOPE' } })),
    recorded('an unknown returnEdits', () =>
      apply(SET_ENGAGEMENT_STATUS, { parameters: {}, options: { returnEdits: 'NOPE' } }),
    ),
  ]);
});

describe('apply: the parameters', () => {
  pin([
    recorded('an unknown parameter', () => execute(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', nope: 1 })),
    recorded('a list parameter with the value null', () =>
      execute(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', tags: null }),
    ),
    recorded('a scalar value of the wrong type', () =>
      execute(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', count: 'many' }),
    ),
    recorded('a list value that is not a list', () =>
      execute(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', tags: 'one' }),
    ),
    recorded('a list value with a null element', () =>
      execute(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', tags: ['one', null] }),
    ),
    recorded('a list value with an element of the wrong type', () =>
      execute(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', tags: ['one', 2] }),
    ),
    recorded('an Object parameter that is not a String', () =>
      execute(SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 5, status: 'won' }),
    ),
    recorded('an Object list parameter with a null element', () =>
      execute(LIST_OBJECTS, { engagements: ['eng-1', null] }),
    ),
    recorded('an Object list parameter with an element that is not a String', () =>
      execute(LIST_OBJECTS, { engagements: ['eng-1', 5] }),
    ),
    recorded('a struct value that is not an object', () =>
      execute(CREATE_STRUCT_PROBE, { probeId: 'sp-9', relationship: 5 }),
    ),
    recorded('a struct value with an unknown field', () =>
      execute(CREATE_STRUCT_PROBE, { probeId: 'sp-9', relationship: { nope: 'x' } }),
    ),
    recorded('a struct field value of the wrong type', () =>
      execute(CREATE_STRUCT_PROBE, { probeId: 'sp-9', relationship: { label: 5 } }),
    ),
    recorded('a struct value of a Function input with no value for a required field', () =>
      execute(SET_RELATIONSHIP_ACTION, { probe: 'sp-f1', relationship: { since: '2026-02-03' }, mode: 'full' }),
    ),
  ]);
});

describe('apply: the loads', () => {
  pin([
    recorded('an Object parameter whose Object does not exist', () =>
      execute(SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 'eng-404', status: 'won' }),
    ),
    recorded('an Object list parameter with an Object that does not exist', () =>
      execute(LIST_OBJECTS, { engagements: ['eng-1', 'eng-404'] }),
    ),
  ]);
});

describe('apply: the rules', () => {
  pin([
    recorded('2 creates of the same Object', () => execute(CREATE_TWICE, {})),
    recorded('a modify after a delete of the same Object', () => execute(DELETE_THEN_MODIFY, { engagement: 'eng-2' })),
    recorded('a Link rule on an Object that an earlier rule deletes', () =>
      execute(DELETE_THEN_LINK, { engagement: 'eng-1', account: 'acc-1' }),
    ),
    recorded('a create with no primary key value', () => execute(CREATE_ENGAGEMENT, { title: 'No key' })),
  ]);
});

describe('apply: the values', () => {
  pin([
    recorded('a rule value that breaks a value rule', () => execute(CREATE_ACCOUNT, { accountId: 'acc-9', name: '' })),
    recorded('a Function value that breaks a value rule', () => {
      functionGives([modify(ENGAGEMENT, 'eng-2', { status: '' })]);

      return runProbe();
    }),
    recorded('a Function create with no value for a required Property', () => {
      functionGives([create(ACCOUNT, 'acc-9')]);

      return runProbe();
    }),
    recorded('a Function value that is an empty array of a Property with noEmptyCollections', () => {
      functionGives([create(VALUE_PROBE, 'vp-1', { name: 'Probe', labels: [] })]);

      return runProbe();
    }),
    recorded('a Function that edits more than 10,000 Objects', () => {
      functionGives(Array.from({ length: 10_001 }, (_, index) => create(ENGAGEMENT, `eng-new-${index}`)));

      return runProbe();
    }),
    recorded('a Function that edits Objects of more than 50 Object Types', () => {
      functionGives(MANY_TYPES.map((type) => create(type, 'one')));

      return runProbe();
    }),
  ]);
});

describe('apply: the edits of a Function', () => {
  pin([
    recorded('a Link edit on an Object that an earlier edit deletes', () => {
      functionGives([
        { type: 'deleteObject', object: locator(ACCOUNT, 'acc-1') },
        {
          type: 'addLink',
          link: 'sponsors' as Extract<Edit, { type: 'addLink' }>['link'],
          source: locator(ENGAGEMENT, 'eng-1'),
          target: locator(ACCOUNT, 'acc-1'),
        },
      ]);

      return runProbe();
    }),
    recorded('a modify of an Object that does not exist', () => {
      functionGives([modify(ENGAGEMENT, 'eng-404', { status: 'won' })]);

      return runProbe();
    }),
    recorded('a modify of an Object that another Action created during the run', () => {
      scripted.once(async () => {
        await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-9', name: 'Nine', phase: null }]);

        return [modify(ACCOUNT, 'acc-9', { phase: 'customer' })];
      });

      return runProbe();
    }),
    recorded('a Function error', () => {
      scripted.once(() => {
        throw new ScriptedUserFacingError('No.');
      });

      return runProbe();
    }),
    recorded('a fault of the Function run', () => {
      return withEngagementsMoved(() =>
        execute(PROBE_VERSION_CHECK, { account: 'acc-1', engagementId: 'eng-2', mode: 'read-only', delayMs: 0 }),
      );
    }),
  ]);
});

describe('apply: the write', () => {
  pin([
    recorded('a create of a primary key that exists', () =>
      execute(CREATE_ACCOUNT, { accountId: 'acc-1', name: 'Again' }),
    ),
    recorded('a version that changed before each of the 5 attempts', () =>
      written({ db: racingDb(service.db, changeEng2, 5).db }),
    ),
    recorded('a deadlock, 40P01, on each lock', () => written({ db: refusing(isLock, '40P01') })),
    recorded('the code 25P04 of transaction_timeout on the lock', () => written({ db: refusing(isLock, '25P04') })),
    recorded('another Postgres code on the edit statement', () => written({ db: refusing(isEdit, '22023') })),
    recorded('a failure with no code before COMMIT', () =>
      written({
        db: inWrite((statement) =>
          isEdit(statement) ? Promise.reject(new Error('The test fails the edit statement.')) : undefined,
        ),
      }),
    ),
    recorded('a failure with no code before COMMIT, past the deadline', () => {
      const later = clock();

      return written({
        db: inWrite((statement) => {
          if (!isEdit(statement)) return undefined;

          later(120_001);

          return Promise.reject(new Error('The test fails the edit statement.'));
        }),
      });
    }),
    recorded('a failure after COMMIT, past the deadline', () => {
      const later = clock();

      return written({
        db: inWrite(
          () => undefined,
          () => {
            later(120_001);

            throw new Error('The test fails the write after its commit.');
          },
        ),
      });
    }),
    recorded('a request that the client aborted before the write', () => {
      const client = new AbortController();

      return written({ db: atFirstQuery(() => client.abort()), signal: client.signal });
    }),
    recorded('a request with no time left at the check before the write', () => {
      const later = clock();

      return written({ db: atFirstQuery(() => later(120_000)) });
    }),
    recorded('a request with no time left when the transaction gets its connection', () => {
      const later = clock();

      return written({ db: atOpen(() => later(120_000)) });
    }),
  ]);
});

describe('applyBatch', () => {
  pin([recorded('each request', () => answerOf(`/actions/${SET_ENGAGEMENT_STATUS}/applyBatch`, { requests: [] }))]);
});

describe('editsHistory', () => {
  pin([
    recorded('an unknown Object Type', () => history('nope', {})),
    recorded('a body that is not an object', () => history(ENGAGEMENT, [])),
    recorded('an unknown sortOrder', () => history(ENGAGEMENT, { sortOrder: 'nope' })),
    recorded('an includeAllPreviousProperties that is not a Boolean', () =>
      history(ENGAGEMENT, { includeAllPreviousProperties: 'yes' }),
    ),
    recorded('an objectPrimaryKey that is not an object', () => history(ENGAGEMENT, { objectPrimaryKey: 'eng-1' })),
    recorded('an objectPrimaryKey of another Property', () =>
      history(ENGAGEMENT, { objectPrimaryKey: { title: 'eng-1' } }),
    ),
    recorded('an objectPrimaryKey value that is not a key', () =>
      history(ENGAGEMENT, { objectPrimaryKey: { engagementId: true } }),
    ),
    recorded('filters that are not an object', () => history(ENGAGEMENT, { filters: 1 })),
    recorded('a timestampFilter with a time that is not a time', () =>
      history(ENGAGEMENT, { filters: { type: 'timestampFilter', startTime: '2026-02-30T00:00:00Z' } }),
    ),
    recorded('an operationIdsFilter with no list of strings', () =>
      history(ENGAGEMENT, { filters: { type: 'operationIdsFilter', operationIds: [1] } }),
    ),
    recorded('an unknown filter type', () => history(ENGAGEMENT, { filters: { type: 'nope' } })),
    recorded('a pageSize that is not an integer', () => history(ENGAGEMENT, { pageSize: 1.5 })),
    recorded('a pageSize of 0', () => history(ENGAGEMENT, { pageSize: 0 })),
    recorded('a pageToken that is not a string', () => history(ENGAGEMENT, { pageToken: 1 })),
    recorded('a pageToken that the service did not make', () => history(ENGAGEMENT, { pageToken: 'not-a-token' })),
    recorded('a read that fails before its first row', () => history(ENGAGEMENT, {}, { db: failingStream() })),
    recorded('a read that fails after its first row', async () => {
      const row = {
        time: '2026-11-19T00:00:00.000001Z',
        timestamp: '2026-11-19T00:00:00Z',
        primaryKey: 'eng-1',
        operationId: 'ri.actions.main.action.1',
        entry: { operationId: 'ri.actions.main.action.1', edit: null },
      };

      const log = vi.spyOn(console, 'log');

      try {
        return await history(ENGAGEMENT, {}, { db: failingAfter(row) }).catch((error: unknown) => ({
          bodyFailed: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        log.mockRestore();
      }
    }),
  ]);
});

describe('the MCP tool apply_action', () => {
  pin([
    recorded('an unknown Action Type', () => overMcp('nope', {})),
    recorded('a scalar value of the wrong type', () =>
      overMcp(CHECK_TYPES, { accountId: 'acc-9', name: 'Nine', count: 'many' }),
    ),
    recorded('an Object parameter whose Object does not exist', () =>
      overMcp(SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 'eng-404', status: 'won' }),
    ),
    recorded('a create of a primary key that exists', () =>
      overMcp(CREATE_ACCOUNT, { accountId: 'acc-1', name: 'Again' }),
    ),
    recorded('a version that changed before each of the 5 attempts', async () => ({
      answer: await overMcp(
        SET_ENGAGEMENT_STATUS,
        { objectToModifyParameter: 'eng-2', status: 'won' },
        { db: racingDb(service.db, changeEng2, 5).db },
      ),
      status: await statusOf('eng-2'),
    })),
    recorded('a request that the client aborted before the write', async () => {
      const client = new AbortController();

      return {
        answer: await overMcp(
          SET_ENGAGEMENT_STATUS,
          { objectToModifyParameter: 'eng-2', status: 'won' },
          { db: atFirstQuery(() => client.abort()), signal: client.signal },
        ),
        status: await statusOf('eng-2'),
      };
    }),
    recorded('a failure with no code before COMMIT', async () => ({
      answer: await overMcp(
        SET_ENGAGEMENT_STATUS,
        { objectToModifyParameter: 'eng-2', status: 'won' },
        {
          db: inWrite((statement) =>
            isEdit(statement) ? Promise.reject(new Error('The test fails the edit statement.')) : undefined,
          ),
        },
      ),
      status: await statusOf('eng-2'),
    })),
  ]);
});
