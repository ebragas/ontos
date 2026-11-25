import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countingDb,
  errorAnswer,
  NS,
  recordingDb,
  rowsOf,
  seedClient,
  startActions,
  transactionWait,
  twinIr,
  type ActionsService,
  type Answer,
} from '../actions/actions.test-utils.ts';
import { quoteName } from '../db/index.ts';
import { tableName } from '../ontology/index.ts';
import { actionOf, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ENGAGEMENT = `${NS}Engagement`;

const ENGAGEMENTS = `${quoteName('ontology_1_objects')}.${quoteName(tableName(ENGAGEMENT))}`;

const FUNCTIONS: TestFunction[] = [
  {
    apiName: 'createEngagement',
    inputs: [
      { name: 'engagementId', type: 'string' },
      { name: 'title', type: 'string' },
    ],
    edits: [ENGAGEMENT],
  },
  {
    apiName: 'modifyAndCreateEngagement',
    inputs: [
      { name: 'firstId', type: 'string' },
      { name: 'firstTitle', type: 'string' },
      { name: 'secondId', type: 'string' },
      { name: 'secondTitle', type: 'string' },
    ],
    edits: [ENGAGEMENT],
  },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Engagement = { type: 'object', apiName: '${ENGAGEMENT}' };

export const functions = {
  createEngagement: async (client, engagementId, title) => {
    const batch = createEditBatch(client);
    batch.create(Engagement, { engagementId, accountId: 'acc-1', title, amount: 1 });
    return batch.getEdits();
  },
  modifyAndCreateEngagement: async (client, firstId, firstTitle, secondId, secondTitle) => {
    const batch = createEditBatch(client);
    batch.update({ $apiName: '${ENGAGEMENT}', $primaryKey: firstId }, { title: firstTitle });
    batch.create(Engagement, { engagementId: secondId, accountId: 'acc-1', title: secondTitle, amount: 1 });
    return batch.getEdits();
  },
};
`;

function uniqueTitleIr() {
  const ir = twinIr('0.6.3');
  const title = ir.ontology.objectTypes[ENGAGEMENT]?.objectType.propertyTypes['title'];

  if (!title) throw new Error('The twin 0.6.3 IR has no Engagement title.');

  title.typeClasses = [...title.typeClasses, { kind: 'unique', name: 'uniqueTitle' }];

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, uniqueTitleIr());

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };

const create = (engagementId: string, title: string) =>
  service.apply(actionOf('createEngagement'), { parameters: { engagementId, title }, options: EXECUTE_NONE });

const modifyAndCreate = (parameters: Record<string, string>, db: ActionsService['db']) =>
  service.apply(actionOf('modifyAndCreateEngagement'), { parameters, options: EXECUTE_NONE }, { db });

const engagementRows = () => rowsOf(service.db, ENGAGEMENT, 'engagement_id');

describe('a function-backed create and a Uniqueness constraint', () => {
  it('ontology/object-link-types/properties#uniqueness-constraints: a function-backed create of a title that another Engagement has gets 409 PropertyValueAlreadyExists, and writes nothing', async () => {
    const before = await engagementRows();

    expect(errorAnswer(await create('eng-9', 'Pilot'))).toEqual({
      status: 409,
      body: {
        errorCode: 'CONFLICT',
        errorName: 'PropertyValueAlreadyExists',
        parameters: { objectType: ENGAGEMENT, constraint: 'uniqueTitle', properties: ['title'] },
      },
    });

    expect(await engagementRows()).toEqual(before);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: a function-backed create of a new title passes', async () => {
    expect((await create('eng-9', 'Fresh')).status).toBe(200);

    expect((await engagementRows()).map((row) => row['title'])).toContain('Fresh');
  });
});

describe('2 function-backed writes of 2 values in crossed order', () => {
  it('service/storage#writes: Postgres ends 1 with a deadlock, and that function-backed Action gets 409 ObjectChanged and does not run again', async () => {
    const counted = countingDb(service.db, false);
    let second: Promise<Answer> | undefined;

    const recorded = recordingDb(service.url, async (statement) => {
      if (second || !statement.startsWith(`UPDATE ${ENGAGEMENTS}`)) return;

      second = modifyAndCreate(
        { firstId: 'eng-2', firstTitle: 'Title Y', secondId: 'eng-11', secondTitle: 'Title X' },
        counted.db,
      );

      await transactionWait(service.db);
    });

    const countedFirst = countingDb(recorded.db, false);

    let first: Answer;

    try {
      first = await modifyAndCreate(
        { firstId: 'eng-1', firstTitle: 'Title X', secondId: 'eng-9', secondTitle: 'Title Y' },
        countedFirst.db,
      );
    } finally {
      await recorded.pool.end();
    }

    if (!second) throw new Error('The first write ran no UPDATE.');

    const secondAnswer = await second;

    const [winner, loser] = first.status === 200 ? [first, secondAnswer] : [secondAnswer, first];
    const expectedIds = first.status === 200 ? ['eng-1', 'eng-9'] : ['eng-2', 'eng-11'];

    expect(winner.status).toBe(200);

    expect(errorAnswer(loser)).toEqual({
      status: 409,
      body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} },
    });

    expect(countedFirst.transactions()).toBe(1);
    expect(counted.transactions()).toBe(1);

    expect(
      (await engagementRows())
        .filter((row) => String(row['title']).startsWith('Title '))
        .map((row) => row['engagement_id']),
    ).toEqual(expectedIds);
  });
});
