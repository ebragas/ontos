import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { quoteName } from '../db/index.ts';
import { indexName, tableName } from '../ontology/index.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import {
  actionType,
  addRule,
  countingDb,
  deleteRule,
  errorAnswer,
  insertObjects,
  invalidValue,
  modifyRule,
  NS,
  ONTOLOGY_RID,
  parameterValue,
  recordingDb,
  rowsOf,
  seedClient,
  startActions,
  staticString,
  transactionWait,
  twinFunctions,
  twinIr,
  type ActionsService,
  type Answer,
} from './actions.test-utils.ts';

type RequestDb = ActionsService['db'];

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;

const RULES = [
  { objectType: ACCOUNT, name: 'oneNamePerPhase', properties: ['name', 'phase'] },
  { objectType: ENGAGEMENT, name: 'oneStatusAtATime', properties: ['createdAt', 'status'] },
  { objectType: ENGAGEMENT, name: 'uniqueTitle', properties: ['title'] },
] as const;

const CREATE_ACCOUNT = `${NS}create-account`;
const CREATE_ENGAGEMENT = `${NS}create-engagement`;
const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const CLOSE_ACCOUNT = `${NS}close-account-action`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;
const SET_TITLE = `${NS}set-title`;
const SWAP_TITLES = `${NS}swap-titles`;
const MOVE_TITLE = `${NS}move-title`;
const MOVE_PAIR = `${NS}move-pair`;
const REISSUE = `${NS}reissue-engagement`;
const CREATE_AND_PROBE = `${NS}create-engagement-and-probe`;
const MODIFY_AND_CREATE = `${NS}modify-and-create-engagement`;
const SWAP_AND_CREATE = `${NS}swap-titles-and-create`;
const STRUCT_PROBE = `${NS}StructProbe`;

const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };

const stringParameter = {
  type: { type: 'string', string: {} },
  allowedValues: TEXT,
  required: { type: 'notRequired', notRequired: {} },
};

const engagementParameter = {
  type: { type: 'objectReference', objectReference: { objectTypeId: ENGAGEMENT } },
  allowedValues: OBJECT_QUERY,
  required: { type: 'required', required: {} },
};

const objectProperty = (parameterId: string, propertyTypeId: string) => ({
  type: 'objectParameterPropertyValue',
  objectParameterPropertyValue: { parameterId, propertyTypeId },
});

function testIr() {
  const ir = twinIr('0.6.3');
  const engagement = ir.ontology.objectTypes[ENGAGEMENT];

  if (!engagement) throw new Error('The twin 0.6.3 IR has no Engagement.');

  engagement.entityMetadata = unchecked({
    ...engagement.entityMetadata,
    editsHistory: { type: 'config', config: { store: ENGAGEMENT, storeAllPreviousProperties: false } },
  });

  const blocks = [
    actionType(SET_TITLE, { engagement: engagementParameter, title: stringParameter }, [
      modifyRule('engagement', { title: parameterValue('title') }),
    ]),
    actionType(SWAP_TITLES, { first: engagementParameter, second: engagementParameter }, [
      modifyRule('first', { title: objectProperty('second', 'title') }),
      modifyRule('second', { title: objectProperty('first', 'title') }),
    ]),
    actionType(MOVE_TITLE, { from: engagementParameter, to: engagementParameter, title: stringParameter }, [
      modifyRule('to', { title: objectProperty('from', 'title') }),
      modifyRule('from', { title: parameterValue('title') }),
    ]),
    actionType(MOVE_PAIR, { from: engagementParameter, to: engagementParameter }, [
      modifyRule('to', { createdAt: objectProperty('from', 'createdAt'), status: objectProperty('from', 'status') }),
      modifyRule('from', { status: staticString('moved') }),
    ]),
    actionType(REISSUE, { engagement: engagementParameter, engagementId: stringParameter, title: stringParameter }, [
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: parameterValue('title') }),
      deleteRule('engagement'),
    ]),
    actionType(
      SWAP_AND_CREATE,
      { first: engagementParameter, second: engagementParameter, engagementId: stringParameter },
      [
        modifyRule('first', { title: objectProperty('second', 'title') }),
        modifyRule('second', { title: objectProperty('first', 'title') }),
        addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: staticString('Swap side create') }),
      ],
    ),
    actionType(CREATE_AND_PROBE, { engagementId: stringParameter, title: stringParameter, probeId: stringParameter }, [
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: parameterValue('title') }),
      addRule(STRUCT_PROBE, { probeId: parameterValue('probeId') }),
    ]),
    actionType(
      MODIFY_AND_CREATE,
      {
        engagement: engagementParameter,
        firstTitle: stringParameter,
        secondId: stringParameter,
        secondTitle: stringParameter,
      },
      [
        modifyRule('engagement', { title: parameterValue('firstTitle') }),
        addRule(ENGAGEMENT, { engagementId: parameterValue('secondId'), title: parameterValue('secondTitle') }),
      ],
    ),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  for (const rule of RULES) {
    for (const apiName of rule.properties) {
      const property = ir.ontology.objectTypes[rule.objectType]?.objectType.propertyTypes[apiName];

      if (!property) throw new Error(`The Object Type ${rule.objectType} has no Property ${apiName}.`);

      property.typeClasses = [...property.typeClasses, { kind: 'unique', name: rule.name }];
    }
  }

  return ir;
}

const ENG_3_AMOUNT = 6000;
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

const OBJECT_ALREADY_EXISTS = {
  status: 409,
  body: { errorCode: 'CONFLICT', errorName: 'ObjectAlreadyExists', parameters: {} },
};

const ENGAGEMENTS = `${quoteName('ontology_1_objects')}.${quoteName(tableName(ENGAGEMENT))}`;
const REGISTRY_ROW = 'SELECT version FROM ontology_registry.ontologies WHERE rid = $1';
const SET_CONSTRAINTS = 'SET CONSTRAINTS ALL IMMEDIATE';
const CANCELLED = 'cancelled: ';
const TOO_LONG = 'A String value of a Property in a Uniqueness constraint has at most 500 bytes in UTF-8.';

const FUNCTION_VALUE = 'The Function assigned a value whose type does not match the Property.';

function valueAlreadyExists(objectType: string, constraint: string, properties: readonly string[]): Answer {
  return {
    status: 409,
    body: {
      errorCode: 'CONFLICT',
      errorName: 'PropertyValueAlreadyExists',
      parameters: { objectType, constraint, properties },
    },
  };
}

const TITLE_EXISTS = valueAlreadyExists(ENGAGEMENT, 'uniqueTitle', ['title']);

let service: ActionsService;
let publisher: pg.Client;
let servedVersion: number;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));

  publisher = new pg.Client({ connectionString: service.url });

  await publisher.connect();

  const [row] = await service.db.query<{ version: number }>({ text: REGISTRY_ROW, values: [ONTOLOGY_RID] });

  servedVersion = row?.version ?? 0;
});

afterAll(async () => {
  await publisher?.end();

  await service?.stop();
});

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

async function addConstraint(objectType: string, rule: string, columns: readonly string[]): Promise<void> {
  const table = tableName(objectType);

  await service.db.query(
    sql(
      `ALTER TABLE ontology_1_objects.${quoteName(table)} ADD CONSTRAINT ${quoteName(indexName('unique', table, rule))} UNIQUE (${columns.map(quoteName).join(', ')}) DEFERRABLE INITIALLY DEFERRED`,
    ),
  );
}

const apply = (action: string, parameters: Record<string, unknown>, db?: RequestDb) =>
  service.apply(action, { parameters, options: EXECUTE_NONE }, db ? { db } : {});

const answerOf = (answer: Answer) => (answer.status === 200 ? answer : errorAnswer(answer));
const engagementRows = () => rowsOf(service.db, ENGAGEMENT, 'engagement_id');
const accountRows = () => rowsOf(service.db, ACCOUNT, 'account_id');

const titles = async () => (await engagementRows()).map((row) => row['title']);

const historyCount = async () =>
  (
    await service.db.query<{ count: number }>(sql('SELECT count(*)::int AS count FROM ontology_1_engine.edit_history'))
  )[0]?.count;

const createEngagement = (engagementId: string, title: string, db?: RequestDb) =>
  apply(CREATE_ENGAGEMENT, { engagementId, accountId: 'acc-1', title, amount: 1 }, db);

const commitEngagement = (engagementId: string) =>
  insertObjects(service.db, ENGAGEMENT, [
    {
      engagementId,
      accountId: 'acc-1',
      title: `Committed ${engagementId}`,
      amount: 1,
      status: 'open',
      createdAt: null,
    },
  ]);

describe('a rule from the IR, end to end', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: the publish of an IR with rules creates each constraint by its compiled name, a clashing apply gets 409, and a publish of a new rule on clashing data gets 400', async () => {
    const { rows } = await publisher.query<{ name: string; definition: string }>(
      "SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'u' ORDER BY conname",
      [ENGAGEMENTS],
    );

    expect(rows).toEqual([
      {
        name: indexName('unique', 'engagement', 'oneStatusAtATime'),
        definition: 'UNIQUE (created_at, status) DEFERRABLE INITIALLY DEFERRED',
      },
      {
        name: indexName('unique', 'engagement', 'uniqueTitle'),
        definition: 'UNIQUE (title) DEFERRABLE INITIALLY DEFERRED',
      },
    ]);

    expect(answerOf(await createEngagement('eng-9', 'Pilot'))).toEqual(TITLE_EXISTS);

    const next = testIr();
    const status = next.ontology.objectTypes[ENGAGEMENT]?.objectType.propertyTypes['status'];

    if (!status) throw new Error('The test IR has no Engagement status.');

    status.typeClasses = [...status.typeClasses, { kind: 'unique', name: 'oneStatus' }];

    const refused = await service.publish(next, twinFunctions('0.6.3')).then(
      () => 'published',
      (error: unknown) => String(error),
    );

    expect(refused).toMatch(/^Error: The publish gave 400: /);

    const body = JSON.parse(refused.replace(/^Error: The publish gave 400: /, '')) as {
      errorName: string;
      parameters: Record<string, unknown>;
    };

    expect(body).toMatchObject({
      errorName: 'Default:InvalidArgument',
      parameters: {
        objectType: ENGAGEMENT,
        property: 'status',
        badObjects: 5,
        primaryKeys: ['eng-1', 'eng-2', 'eng-3', 'eng-5', 'eng-6'],
      },
    });
  });
});

describe('a write that breaks a Uniqueness constraint', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: a rule-backed create of a title that another Engagement has gets 409 PropertyValueAlreadyExists, and writes nothing', async () => {
    const before = await engagementRows();

    expect(answerOf(await createEngagement('eng-9', 'Pilot'))).toEqual(TITLE_EXISTS);

    expect(await engagementRows()).toEqual(before);

    expect(await historyCount()).toBe(0);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a rule-backed modify to a title that another Engagement has gets 409 PropertyValueAlreadyExists, and adds no Object Edit History entry', async () => {
    const before = await engagementRows();

    expect(answerOf(await apply(SET_TITLE, { engagement: 'eng-2', title: 'Pilot' }))).toEqual(TITLE_EXISTS);

    expect(await engagementRows()).toEqual(before);

    expect(await historyCount()).toBe(0);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a clash on a rule of 2 Properties lists both Properties in API name order', async () => {
    const before = await accountRows();

    expect(answerOf(await apply(CREATE_ACCOUNT, { accountId: 'acc-9', name: 'Acme', phase: 'customer' }))).toEqual(
      valueAlreadyExists(ACCOUNT, 'oneNamePerPhase', ['name', 'phase']),
    );

    expect(await accountRows()).toEqual(before);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a function-backed modify that clashes gets 409 PropertyValueAlreadyExists, and writes none of its edits', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-9', name: 'Acme', phase: 'closed' }]);

    const [accounts, engagements] = [await accountRows(), await engagementRows()];

    expect(answerOf(await apply(CLOSE_ACCOUNT, { account: 'acc-1' }))).toEqual(
      valueAlreadyExists(ACCOUNT, 'oneNamePerPhase', ['name', 'phase']),
    );

    expect(await accountRows()).toEqual(accounts);

    expect(await engagementRows()).toEqual(engagements);

    expect(await historyCount()).toBe(0);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: the answer, the request log, and the fault reports hold no value and no primary key of the other Engagement', async () => {
    await insertObjects(service.db, ENGAGEMENT, [
      {
        engagementId: 'eng-secret-key',
        accountId: 'acc-1',
        title: 'secret-clash-value',
        amount: 1,
        status: 'open',
        createdAt: null,
      },
    ]);

    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const reportFault = vi.fn();

    try {
      const answer = await service.apply(
        CREATE_ENGAGEMENT,
        { parameters: { engagementId: 'eng-9', title: 'secret-clash-value' }, options: EXECUTE_NONE },
        { reportFault },
      );

      expect(answerOf(answer)).toEqual(TITLE_EXISTS);
      expect(JSON.stringify(answer.body)).not.toMatch(/eng-secret-key|duplicate key|Key \(/);

      const lines = spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' ')));

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toMatch(/secret-clash-value|eng-secret-key/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(reportFault).not.toHaveBeenCalled();
  });
});

describe('each check runs against the end state of the Action', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: a swap of the titles of 2 Engagements passes in 1 Action', async () => {
    expect(answerOf(await apply(SWAP_TITLES, { first: 'eng-1', second: 'eng-2' }))).toMatchObject({ status: 200 });

    expect((await titles()).slice(0, 2)).toEqual(['Ontology build', 'Discovery workshop']);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a delete and a create of 1 title pass in 1 Action', async () => {
    expect(
      answerOf(await apply(REISSUE, { engagement: 'eng-4', engagementId: 'eng-9', title: 'Pilot' })),
    ).toMatchObject({ status: 200 });

    const rows = await engagementRows();

    expect(rows.filter((row) => row['title'] === 'Pilot').map((row) => row['engagement_id'])).toEqual(['eng-9']);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a move of the pair createdAt and status from 1 Engagement to another passes in 1 Action', async () => {
    expect(answerOf(await apply(MOVE_PAIR, { from: 'eng-2', to: 'eng-3' }))).toMatchObject({ status: 200 });

    const rows = await engagementRows();

    const [eng2, eng3] = [
      rows.find((row) => row['engagement_id'] === 'eng-2'),
      rows.find((row) => row['engagement_id'] === 'eng-3'),
    ];

    expect(eng2?.['status']).toBe('moved');
    expect(eng3?.['status']).toBe('open');
    expect(eng3?.['created_at']).toEqual(eng2?.['created_at']);
  });
});

describe('an Object with no value in 1 Property of a rule', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: on a rule of 2 Properties, 2 Accounts with the same name and no phase do not clash', async () => {
    expect(answerOf(await apply(CREATE_ACCOUNT, { accountId: 'acc-8', name: 'Same' }))).toMatchObject({ status: 200 });

    expect(answerOf(await apply(CREATE_ACCOUNT, { accountId: 'acc-9', name: 'Same' }))).toMatchObject({ status: 200 });

    expect((await accountRows()).filter((row) => row['name'] === 'Same')).toHaveLength(2);
  });
});

describe('a create on a table with a deferrable unique constraint', () => {
  it('service/storage#writes: a create passes, and a create of an existing primary key still gets 409 ObjectAlreadyExists and writes nothing', async () => {
    expect(answerOf(await createEngagement('eng-7', 'Expansion'))).toMatchObject({ status: 200 });

    const before = await engagementRows();

    expect(answerOf(await createEngagement('eng-1', 'Duplicate'))).toEqual(OBJECT_ALREADY_EXISTS);

    expect(await engagementRows()).toEqual(before);
  });
});

describe('the byte limit of a String in a rule', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: a rule-backed title of 500 UTF-8 bytes passes, and a title of 501 bytes gets 400 ApplyActionFailed and writes nothing', async () => {
    const fits = 'é'.repeat(250);

    expect(answerOf(await createEngagement('eng-8', fits))).toMatchObject({ status: 200 });

    const before = await engagementRows();

    expect(answerOf(await createEngagement('eng-9', `${fits}x`))).toEqual(invalidValue(ENGAGEMENT, 'title', TOO_LONG));

    expect(await engagementRows()).toEqual(before);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a Function edit of a status of 501 UTF-8 bytes gets 400 ApplyActionFailed and writes nothing, and 500 bytes pass', async () => {
    const before = await engagementRows();

    const statusOf = (bytes: number) => 'r'.repeat(bytes - CANCELLED.length);

    expect(answerOf(await apply(CLOSE_ACCOUNT, { account: 'acc-1', reason: statusOf(501) }))).toEqual(
      invalidValue(ENGAGEMENT, 'status', FUNCTION_VALUE),
    );

    expect(await engagementRows()).toEqual(before);

    expect(answerOf(await apply(CLOSE_ACCOUNT, { account: 'acc-1', reason: statusOf(500) }))).toMatchObject({
      status: 200,
    });
  });
});

describe('a rule-backed Action that a Uniqueness constraint refuses', () => {
  it('ontology/action-types/action-types#apply: the Action runs 1 attempt, and does not run again inside the service', async () => {
    const counted = countingDb(service.db, false);

    expect(answerOf(await createEngagement('eng-9', 'Pilot', counted.db))).toEqual(TITLE_EXISTS);

    expect(counted.transactions()).toBe(1);
  });
});

describe('the uniqueness check of the write transaction', () => {
  async function statementsOf(run: (db: RequestDb) => Promise<Answer>): Promise<readonly string[]> {
    const recorded = recordingDb(service.url);

    try {
      expect(answerOf(await run(recorded.db))).toMatchObject({ status: 200 });
    } finally {
      await recorded.pool.end();
    }

    const begin = recorded.statements.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');

    return recorded.statements.slice(begin + 1, recorded.statements.indexOf('COMMIT', begin) + 1);
  }

  it('service/storage#writes: a create on an Object Type with a rule runs SET CONSTRAINTS ALL IMMEDIATE after the version read, and then commits', async () => {
    const transaction = await statementsOf((db) => createEngagement('eng-9', 'Fresh', db));

    expect(transaction.slice(-3)).toEqual([REGISTRY_ROW, SET_CONSTRAINTS, 'COMMIT']);
  });

  it('service/storage#writes: a modify on an Object Type with a rule runs SET CONSTRAINTS ALL IMMEDIATE after the version read', async () => {
    const transaction = await statementsOf((db) => apply(SET_TITLE, { engagement: 'eng-2', title: 'Fresh' }, db));

    expect(transaction.slice(-3)).toEqual([REGISTRY_ROW, SET_CONSTRAINTS, 'COMMIT']);
  });

  it('service/storage#writes: a delete, and a create on an Object Type with no rule, do not run SET CONSTRAINTS', async () => {
    const deleted = await statementsOf((db) => apply(DELETE_ENGAGEMENT, { objectToDeleteParameter: 'eng-2' }, db));

    expect(deleted.slice(-2)).toEqual([REGISTRY_ROW, 'COMMIT']);

    const probe = await statementsOf((db) =>
      apply(CREATE_STRUCT_PROBE, { probeId: 'sp-9', relationship: { label: 'partner' }, measures: { flag: true } }, db),
    );

    expect(probe).not.toContain(SET_CONSTRAINTS);
  });
});

async function holdFirstUntilSecondWaits(
  at: string,
  first: (db: RequestDb) => Promise<Answer>,
  second: () => Promise<Answer>,
): Promise<{ first: Answer; second: Answer }> {
  let started: Promise<Answer> | undefined;

  const recorded = recordingDb(service.url, async (statement) => {
    if (started || !statement.startsWith(at)) return;

    started = second();

    await transactionWait(service.db);
  });

  try {
    const firstAnswer = await first(recorded.db);

    if (!started) throw new Error(`The first write ran no statement ${at}.`);

    return { first: firstAnswer, second: await started };
  } finally {
    await recorded.pool.end();
  }
}

describe('2 writes of 1 value at the same time', () => {
  it('service/storage#writes: 2 creates of 1 title: the second waits at SET CONSTRAINTS, and gets 409 PropertyValueAlreadyExists when the first commits', async () => {
    const { first, second } = await holdFirstUntilSecondWaits(
      SET_CONSTRAINTS,
      (db) => createEngagement('eng-8', 'Same title', db),
      () => createEngagement('eng-9', 'Same title'),
    );

    expect(answerOf(first)).toMatchObject({ status: 200 });
    expect(answerOf(second)).toEqual(TITLE_EXISTS);

    expect(
      (await engagementRows()).filter((row) => row['title'] === 'Same title').map((row) => row['engagement_id']),
    ).toEqual(['eng-8']);
  });

  it('service/storage#writes: 2 creates of 1 title: when the first rolls back, the second commits', async () => {
    const { first, second } = await holdFirstUntilSecondWaits(
      `INSERT INTO ${ENGAGEMENTS}`,
      (db) => apply(CREATE_AND_PROBE, { engagementId: 'eng-8', title: 'Same title', probeId: 'sp-10' }, db),
      async () => {
        await insertObjects(service.db, STRUCT_PROBE, [{ probe_id: 'sp-10' }]);

        return createEngagement('eng-9', 'Same title');
      },
    );

    expect(answerOf(first)).toEqual(OBJECT_ALREADY_EXISTS);
    expect(answerOf(second)).toMatchObject({ status: 200 });

    expect(
      (await engagementRows()).filter((row) => row['title'] === 'Same title').map((row) => row['engagement_id']),
    ).toEqual(['eng-9']);
  });

  it('service/storage#writes: a move of a title to another Engagement, against a create of that title, never leaves 2 copies: the create waits for the move, and gets 409', async () => {
    const { first, second } = await holdFirstUntilSecondWaits(
      SET_CONSTRAINTS,
      (db) => apply(MOVE_TITLE, { from: 'eng-1', to: 'eng-2', title: 'Renamed' }, db),
      () => createEngagement('eng-9', 'Discovery workshop'),
    );

    expect(answerOf(first)).toMatchObject({ status: 200 });
    expect(answerOf(second)).toEqual(TITLE_EXISTS);

    expect(
      (await engagementRows())
        .filter((row) => row['title'] === 'Discovery workshop')
        .map((row) => row['engagement_id']),
    ).toEqual(['eng-2']);
  });

  it('service/storage#writes: a swap that rolls back, against a create of a swapped title: the create waits, and gets 409 PropertyValueAlreadyExists against the stored titles', async () => {
    const { first, second } = await holdFirstUntilSecondWaits(
      `UPDATE ${ENGAGEMENTS}`,
      (db) => apply(SWAP_AND_CREATE, { first: 'eng-1', second: 'eng-2', engagementId: 'eng-99' }, db),
      async () => {
        await commitEngagement('eng-99');

        return createEngagement('eng-9', 'Discovery workshop');
      },
    );

    expect(answerOf(first)).toEqual(OBJECT_ALREADY_EXISTS);
    expect(answerOf(second)).toEqual(TITLE_EXISTS);

    expect((await titles()).slice(0, 2)).toEqual(['Discovery workshop', 'Ontology build']);
  });
});

describe('2 writes of 2 values in crossed order', () => {
  it('service/storage#writes: Postgres ends 1 with a deadlock, and that rule-backed Action runs again and gets 409 PropertyValueAlreadyExists', async () => {
    const counted = countingDb(service.db, false);

    const { first, second } = await holdFirstUntilSecondWaits(
      `UPDATE ${ENGAGEMENTS}`,
      (db) =>
        apply(
          MODIFY_AND_CREATE,
          { engagement: 'eng-1', firstTitle: 'Title X', secondId: 'eng-9', secondTitle: 'Title Y' },
          db,
        ),
      () =>
        apply(
          MODIFY_AND_CREATE,
          { engagement: 'eng-2', firstTitle: 'Title Y', secondId: 'eng-11', secondTitle: 'Title X' },
          counted.db,
        ),
    );

    expect(answerOf(first)).toMatchObject({ status: 200 });
    expect(answerOf(second)).toEqual(TITLE_EXISTS);
    expect(counted.transactions()).toBe(2);

    expect(
      (await engagementRows())
        .filter((row) => String(row['title']).startsWith('Title '))
        .map((row) => row['engagement_id']),
    ).toEqual(['eng-1', 'eng-9']);
  });
});

describe('a Uniqueness constraint that the view does not know', () => {
  const constraint = indexName('unique', tableName(ENGAGEMENT), 'newRule');

  afterEach(() =>
    service.db.query(sql(`ALTER TABLE ${ENGAGEMENTS} DROP CONSTRAINT IF EXISTS ${quoteName(constraint)}`)),
  );

  it('service/storage#writes: a clash on the constraint of a rule that a publish added after the view opened gets 409 ObjectChanged, and writes nothing', async () => {
    await addConstraint(ENGAGEMENT, 'newRule', ['amount']);

    const before = await engagementRows();

    expect(
      answerOf(
        await apply(CREATE_ENGAGEMENT, {
          engagementId: 'eng-9',
          accountId: 'acc-1',
          title: 'Fresh',
          amount: ENG_3_AMOUNT,
        }),
      ),
    ).toEqual(OBJECT_CHANGED);

    expect(await engagementRows()).toEqual(before);
  });
});

describe('a publish that changes the Properties of a rule while an apply writes', () => {
  const constraint = indexName('unique', tableName(ENGAGEMENT), 'uniqueTitle');

  afterEach(async () => {
    await publisher.query('ROLLBACK');

    await service.db.query({
      text: 'UPDATE ontology_registry.ontologies SET version = $2 WHERE rid = $1',
      values: [ONTOLOGY_RID, servedVersion],
    });

    await service.db.query(sql(`ALTER TABLE ${ENGAGEMENTS} DROP CONSTRAINT ${quoteName(constraint)}`));

    await addConstraint(ENGAGEMENT, 'uniqueTitle', ['title']);
  });

  it('service/storage#writes: the apply waits for the table lock of the publish, and gets 409 ObjectChanged that names no old Property, and writes nothing', async () => {
    const before = await engagementRows();

    await publisher.query('BEGIN');

    await publisher.query({
      text: 'SELECT 1 FROM ontology_registry.ontologies WHERE rid = $1 FOR UPDATE',
      values: [ONTOLOGY_RID],
    });

    await publisher.query(`LOCK TABLE ${ENGAGEMENTS} IN SHARE MODE`);

    await publisher.query(`ALTER TABLE ${ENGAGEMENTS} DROP CONSTRAINT ${quoteName(constraint)}`);

    await publisher.query(
      `ALTER TABLE ${ENGAGEMENTS} ADD CONSTRAINT ${quoteName(constraint)} UNIQUE (amount) DEFERRABLE INITIALLY DEFERRED`,
    );

    const applied = apply(CREATE_ENGAGEMENT, {
      engagementId: 'eng-9',
      accountId: 'acc-1',
      title: 'Fresh',
      amount: ENG_3_AMOUNT,
    });

    await tableWait();

    await publisher.query({
      text: 'UPDATE ontology_registry.ontologies SET version = version + 1 WHERE rid = $1',
      values: [ONTOLOGY_RID],
    });

    await publisher.query('COMMIT');

    expect(answerOf(await applied)).toEqual(OBJECT_CHANGED);

    expect(await engagementRows()).toEqual(before);
  });
});

async function tableWait(): Promise<void> {
  for (let tries = 0; tries < 250; tries += 1) {
    const [row] = await service.db.query<{ waiting: number }>({
      text: 'SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted AND relation = $1::regclass AND database = (SELECT oid FROM pg_database WHERE datname = current_database())',
      values: [ENGAGEMENTS],
    });

    if ((row?.waiting ?? 0) > 0) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`No session waited for a lock on ${ENGAGEMENTS}.`);
}
