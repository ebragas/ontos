import type { OntologyIr, OntologyIrParameterPrefill } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountWith, propertyOfType, STRING_FLAGS, USE } from '../ontology/stored.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import { STUB_PERSON, stubUsers } from '../workos.test-utils.ts';
import {
  account,
  actionType,
  addRule,
  CLIENT_ACCOUNTS,
  CLIENT_ENGAGEMENTS,
  deleteRule,
  ENG_7,
  errorAnswer,
  insertObjects,
  modifyRule,
  NS,
  parameterResult,
  parameterValue,
  PERSON,
  rowsOf,
  seedClient,
  startActions,
  staticString,
  twinFunctions,
  twinIr,
  type ActionsService,
  type ObjectRow,
  newVersion,
} from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const DELETE_ACCOUNT = `${NS}delete-account`;
const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const SET_STRUCT_PROBE_RELATIONSHIP = `${NS}set-struct-probe-relationship`;
const COPY_ACCOUNT_PHASE = `${NS}copy-account-phase`;

const CREATE_STAMPED = `${NS}create-stamped-engagement`;
const CREATE_LINKED = `${NS}create-linked-engagement`;
const CREATE_STRUCT_PROBE = `${NS}create-struct-probe`;
const SET_AND_COPY_PHASE = `${NS}set-and-copy-phase`;
const SET_STATUS_TWICE = `${NS}set-status-twice`;
const DELETE_THEN_MODIFY = `${NS}delete-then-modify`;
const MODIFY_THEN_DELETE = `${NS}modify-then-delete`;
const MODIFY_THEN_CREATE = `${NS}modify-then-create`;
const CREATE_THEN_MODIFY = `${NS}create-then-modify`;
const CREATE_THEN_DELETE = `${NS}create-then-delete`;
const CREATE_TWICE = `${NS}create-twice`;
const SET_ENGAGEMENT_KEY = `${NS}set-engagement-key`;
const CREATE_TAGGED_ACCOUNT = `${NS}create-tagged-account`;
const SET_ACCOUNT_TAGS = `${NS}set-account-tags`;
const SET_ACCOUNT_TAGS_KEPT = `${NS}set-account-tags-kept`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const CURRENT_USER = { type: 'currentUser', currentUser: {} };
const CURRENT_TIME = { type: 'currentTime', currentTime: {} };

const uniqueIdentifier = (linkId?: string) => ({
  type: 'uniqueIdentifier',
  uniqueIdentifier: linkId === undefined ? {} : { linkId },
});

const objectProperty = (parameterId: string, propertyTypeId: string) => ({
  type: 'objectParameterPropertyValue' as const,
  objectParameterPropertyValue: { parameterId, propertyTypeId },
});

const TEXT = { type: 'text', text: { type: 'text', text: {} } };
const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };

const REQUIRED = { type: 'required', required: {} };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const NO_LIST_LENGTH = { type: 'listLengthValidation', listLengthValidation: {} };

interface TestParameter {
  readonly type: unknown;
  readonly allowedValues: unknown;
  readonly required: unknown;
}

const stringParameter: TestParameter = {
  type: { type: 'string', string: {} },
  allowedValues: TEXT,
  required: NOT_REQUIRED,
};

const stringListParameter: TestParameter = {
  type: { type: 'stringList', stringList: {} },
  allowedValues: TEXT,
  required: NO_LIST_LENGTH,
};

const objectParameter = (objectTypeId: string): TestParameter => ({
  type: { type: 'objectReference', objectReference: { objectTypeId } },
  allowedValues: OBJECT_QUERY,
  required: REQUIRED,
});

function withDefault(block: ActionTypeBlock, id: string, defaultValue: OntologyIrParameterPrefill): ActionTypeBlock {
  const validation = block.actionType.actionTypeLogic.validation.parameterValidations[id];

  if (!validation) throw new Error(`The Action Type has no parameter ${id}.`);

  validation.defaultValidation.display.prefill = defaultValue;

  return block;
}

const stampedRule = (linkId?: string) =>
  addRule(ENGAGEMENT, {
    engagementId: uniqueIdentifier(linkId),
    title: CURRENT_USER,
    status: staticString('stamped'),
    createdAt: CURRENT_TIME,
  });

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  ir.ontology.objectTypes[ACCOUNT] = accountWith(
    propertyOfType('tags', {
      type: 'array',
      array: { subtype: { type: 'string', string: STRING_FLAGS }, reducers: [] },
    }),
  );

  const engagement = objectParameter(ENGAGEMENT);

  const blocks: ActionTypeBlock[] = [
    actionType(CREATE_STAMPED, {}, [stampedRule()]),
    actionType(CREATE_LINKED, {}, [stampedRule('new-engagement')]),
    actionType(SET_AND_COPY_PHASE, { engagement, account: objectParameter(ACCOUNT), phase: stringParameter }, [
      modifyRule('account', { phase: parameterValue('phase') }),
      modifyRule('engagement', { status: objectProperty('account', 'phase') }),
    ]),
    actionType(SET_STATUS_TWICE, { engagement, status: stringParameter }, [
      modifyRule('engagement', { status: staticString('first'), title: staticString('Set twice') }),
      modifyRule('engagement', { status: parameterValue('status') }),
    ]),
    actionType(DELETE_THEN_MODIFY, { engagement }, [
      deleteRule('engagement'),
      modifyRule('engagement', { status: staticString('after delete') }),
    ]),
    actionType(MODIFY_THEN_DELETE, { engagement }, [
      modifyRule('engagement', { status: staticString('before delete') }),
      deleteRule('engagement'),
    ]),
    actionType(MODIFY_THEN_CREATE, { engagement, engagementId: stringParameter }, [
      modifyRule('engagement', { status: staticString('modified') }),
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: staticString('Created') }),
    ]),
    actionType(CREATE_THEN_MODIFY, { engagement, engagementId: stringParameter }, [
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: staticString('Created') }),
      modifyRule('engagement', { status: staticString('modified') }),
    ]),
    actionType(CREATE_THEN_DELETE, { engagement, engagementId: stringParameter }, [
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: staticString('Created') }),
      deleteRule('engagement'),
    ]),
    actionType(CREATE_TWICE, { engagementId: stringParameter, otherEngagementId: stringParameter }, [
      addRule(ENGAGEMENT, { engagementId: parameterValue('engagementId'), title: staticString('First') }),
      addRule(ENGAGEMENT, { engagementId: parameterValue('otherEngagementId'), title: staticString('Second') }),
    ]),
    actionType(SET_ENGAGEMENT_KEY, { engagement, engagementId: stringParameter, title: stringParameter }, [
      modifyRule('engagement', { engagementId: parameterValue('engagementId'), title: parameterValue('title') }),
    ]),
    actionType(
      CREATE_TAGGED_ACCOUNT,
      { accountId: stringParameter, name: stringParameter, tags: stringListParameter },
      [
        addRule(ACCOUNT, {
          accountId: parameterValue('accountId'),
          name: parameterValue('name'),
          tags: parameterValue('tags'),
        }),
      ],
    ),
    actionType(SET_ACCOUNT_TAGS, { account: objectParameter(ACCOUNT), tags: stringListParameter }, [
      modifyRule('account', { tags: parameterValue('tags') }),
    ]),
    withDefault(
      actionType(SET_ACCOUNT_TAGS_KEPT, { account: objectParameter(ACCOUNT), tags: stringListParameter }, [
        modifyRule('account', { tags: parameterValue('tags') }),
      ]),
      'tags',
      objectProperty('account', 'tags'),
    ),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOCK_MARGIN_MS = 5_000;

const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const EXECUTE_ALL = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL' };
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

const editsOf = (edits: unknown[], counts: { added?: number; modified?: number; deleted?: number }) => ({
  type: 'edits',
  edits,
  addedObjectCount: counts.added ?? 0,
  modifiedObjectsCount: counts.modified ?? 0,
  deletedObjectsCount: counts.deleted ?? 0,
  addedLinksCount: 0,
  deletedLinksCount: 0,
});

const applied = (edits: ReturnType<typeof editsOf>) => ({
  status: 200,
  body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID, edits },
});

const REFUSED = {
  status: 400,
  body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ApplyActionFailed', parameters: {} },
};

const engagementRow = (
  engagementId: string,
  accountId: string | null,
  title: string | null,
  amount: number | null,
  status: string | null,
  createdAt: unknown,
  version = '1',
) => ({
  engagement_id: engagementId,
  account_id: accountId,
  title,
  amount,
  status,
  created_at: typeof createdAt === 'string' ? new Date(createdAt) : createdAt,
  __version: version,
});

const CLIENT_ENGAGEMENT_ROWS = [
  engagementRow('eng-1', 'acc-1', 'Discovery workshop', 12000, 'won', '2026-10-17T18:20:05.687Z'),
  engagementRow('eng-2', 'acc-1', 'Ontology build', 48000, 'open', '2026-10-17T18:20:05.839Z'),
  engagementRow('eng-3', 'acc-1', 'Support retainer', 6000, 'open', '2026-10-17T18:20:05.991Z'),
  engagementRow('eng-4', 'acc-2', 'Pilot', 15000, 'lost', '2026-10-17T18:20:06.135Z'),
  engagementRow('eng-5', 'acc-3', 'Data audit', 9000, 'won', '2026-10-17T18:20:06.284Z'),
  engagementRow('eng-6', 'acc-3', 'Migration', 30000, 'open', '2026-10-17T18:20:06.436Z'),
  engagementRow('eng-7', 'acc-2', 'Expansion', 22000, 'open', '2026-10-17T18:20:08.937Z'),
];

const engagementRowsWith = (...rows: ReturnType<typeof engagementRow>[]) =>
  CLIENT_ENGAGEMENT_ROWS.map((before) => rows.find((row) => row.engagement_id === before.engagement_id) ?? before);

const accountRow = (
  accountId: string,
  name: string,
  phase: string | null,
  tags: string[] | null = null,
  version = '1',
) => ({
  account_id: accountId,
  name,
  phase,
  tags,
  __version: version,
});

const CLIENT_ACCOUNT_ROWS = [
  accountRow('acc-1', 'Acme', 'customer'),
  accountRow('acc-2', 'Globex', 'prospect'),
  accountRow('acc-3', 'Initech', 'customer'),
];

const engagements = () => rowsOf(service.db, ENGAGEMENT, 'engagement_id');
const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');
const structProbes = () => rowsOf(service.db, STRUCT_PROBE, 'probe_id');

describe('a Modify object rule', () => {
  const CLIENT_18 = { parameters: { objectToModifyParameter: 'eng-7', status: 'won' }, options: EXECUTE_ALL_V2 };

  it('ontology/action-types/rules#rule-kinds: changes the mapped Property of the Object in the Object parameter, and keeps its other Properties', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    await service.apply(SET_ENGAGEMENT_STATUS, CLIENT_18);

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow('eng-7', 'acc-2', 'Expansion', 22000, 'won', '2026-10-17T18:20:08.937Z', newVersion('1')),
      ),
    );

    expect(await accounts()).toEqual(CLIENT_ACCOUNT_ROWS);
  });

  it('ontology/action-types/rules#rule-kinds, ontology/action-types/action-types#apply: answers with 1 modifyObject edit and its counts', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, CLIENT_18);

    expect(answer).toEqual(
      applied(editsOf([{ type: 'modifyObject', primaryKey: 'eng-7', objectType: ENGAGEMENT }], { modified: 1 })),
    );
  });

  it('ontology/action-types/action-types#apply: returnEdits ALL lists a modified Object, as it lists a created Object', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-7', status: 'won' },
      options: EXECUTE_ALL,
    });

    expect(answer).toEqual(
      applied(editsOf([{ type: 'modifyObject', primaryKey: 'eng-7', objectType: ENGAGEMENT }], { modified: 1 })),
    );
  });

  it('ontology/action-types/rules#values: a parameter with the value null gives its mapped Property no value', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-7', status: null },
      options: EXECUTE_NONE,
    });

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow('eng-7', 'acc-2', 'Expansion', 22000, null, '2026-10-17T18:20:08.937Z', newVersion('1')),
      ),
    );
  });

  it('ontology/action-types/rules#values: an omitted parameter whose default value is its own Property keeps the Property, and the Object gets a new version', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    await service.apply(SET_ENGAGEMENT_STATUS, {
      parameters: { objectToModifyParameter: 'eng-7' },
      options: EXECUTE_NONE,
    });

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow('eng-7', 'acc-2', 'Expansion', 22000, 'open', '2026-10-17T18:20:08.937Z', newVersion('1')),
      ),
    );
  });
});

describe('a Delete object rule', () => {
  const RETURN_EDITS_ACCOUNTS = [account('p-ret1', 'Return edits 1', null), account('p-ret2', 'Return edits 2', null)];

  it('ontology/action-types/rules#rule-kinds, service/storage#objects: deletes the row of the Object in the Object parameter, and no other row', async () => {
    await insertObjects(service.db, ACCOUNT, [...CLIENT_ACCOUNTS, ...RETURN_EDITS_ACCOUNTS]);

    await service.apply(DELETE_ACCOUNT, { parameters: { objectToDeleteParameter: 'p-ret1' }, options: EXECUTE_ALL });

    expect(await accounts()).toEqual([...CLIENT_ACCOUNT_ROWS, accountRow('p-ret2', 'Return edits 2', null)]);

    await service.apply(DELETE_ACCOUNT, { parameters: { objectToDeleteParameter: 'p-ret2' }, options: EXECUTE_ALL_V2 });

    expect(await accounts()).toEqual(CLIENT_ACCOUNT_ROWS);
  });

  it('ontology/action-types/action-types#apply: returnEdits ALL only counts the deleted Object, and ALL_V2_WITH_DELETIONS also lists it', async () => {
    await insertObjects(service.db, ACCOUNT, RETURN_EDITS_ACCOUNTS);

    const all = await service.apply(DELETE_ACCOUNT, {
      parameters: { objectToDeleteParameter: 'p-ret1' },
      options: EXECUTE_ALL,
    });

    expect(all).toEqual(applied(editsOf([], { deleted: 1 })));

    const withDeletions = await service.apply(DELETE_ACCOUNT, {
      parameters: { objectToDeleteParameter: 'p-ret2' },
      options: EXECUTE_ALL_V2,
    });

    expect(withDeletions).toEqual(
      applied(editsOf([{ type: 'deleteObject', primaryKey: 'p-ret2', objectType: ACCOUNT }], { deleted: 1 })),
    );
  });

  it('service/storage#objects: a delete of an Engagement deletes its row', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    await service.apply(DELETE_ENGAGEMENT, { parameters: { objectToDeleteParameter: 'eng-7' }, options: EXECUTE_NONE });

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS.filter((row) => row.engagement_id !== 'eng-7'));
  });
});

const OTHER_PERSON = 'user_01JOTHERPERSON0000000000000';

const OTHER_USERS = stubUsers(
  [STUB_PERSON, { ...STUB_PERSON, id: OTHER_PERSON, email: 'other@example.com' }],
  [PERSON, OTHER_PERSON].map((user) => ({
    user_id: user,
    organization_id: ORGANIZATION,
    status: 'active' as const,
    roles: ['member'],
  })),
  { roles: { [ORGANIZATION]: { member: [USE] } } },
);

describe('the rule values', () => {
  it('ontology/action-types/rules#values: a static value gives its fixed value', async () => {
    await service.apply(CREATE_STAMPED, { parameters: {}, options: EXECUTE_NONE });

    const [row] = await engagements();

    expect(row?.status).toBe('stamped');
  });

  it('ontology/action-types/rules#values: the current user value gives the sub of the token of the caller', async () => {
    await service.apply(CREATE_STAMPED, { parameters: {}, options: EXECUTE_NONE });

    await service.apply(
      CREATE_STAMPED,
      { parameters: {}, options: EXECUTE_NONE },
      { claims: { sub: OTHER_PERSON }, users: OTHER_USERS },
    );

    const titles = (await engagements()).map((row) => row.title).sort((a, b) => String(a).localeCompare(String(b)));

    expect(titles).toEqual([PERSON, 'user_01JOTHERPERSON0000000000000'].sort());
  });

  it('ontology/action-types/rules#values: the current time value gives the time when the user submits the Action', async () => {
    const before = new Date();

    await service.apply(CREATE_STAMPED, { parameters: {}, options: EXECUTE_NONE });

    const after = new Date();

    const [row] = await engagements();

    const createdAt = (row?.created_at as Date | undefined)?.getTime();

    expect(createdAt).toBeGreaterThanOrEqual(before.getTime() - CLOCK_MARGIN_MS);
    expect(createdAt).toBeLessThanOrEqual(after.getTime() + CLOCK_MARGIN_MS);
  });

  it('ontology/action-types/rules#values: a generated UUID value gives a new UUID on each Action', async () => {
    const first = await service.apply(CREATE_STAMPED, { parameters: {}, options: EXECUTE_ALL_V2 });

    const second = await service.apply(CREATE_STAMPED, { parameters: {}, options: EXECUTE_ALL_V2 });

    const keys = (await engagements()).map((row) => row.engagement_id as string);

    expect(keys).toHaveLength(2);

    for (const key of keys) expect(key).toMatch(UUID);

    expect(keys[0]).not.toBe(keys[1]);

    const created = [first, second].map(
      (answer) => (answer.body as { edits: { edits: { primaryKey: string }[] } }).edits.edits[0]?.primaryKey,
    );

    expect(created.sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual([...keys].sort());
  });

  it('ontology/action-types/rules#values: An apply with a linkId set gives a normal new UUID', async () => {
    await service.apply(CREATE_LINKED, { parameters: {}, options: EXECUTE_NONE });

    await service.apply(CREATE_LINKED, { parameters: {}, options: EXECUTE_NONE });

    const keys = (await engagements()).map((row) => row.engagement_id as string);

    expect(keys).toHaveLength(2);

    for (const key of keys) {
      expect(key).toMatch(UUID);
      expect(key).not.toContain('new-engagement');
    }

    expect(keys[0]).not.toBe(keys[1]);
  });

  it('ontology/action-types/rules#values: a Property of an Object parameter gives its value before the Action edits it', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(SET_AND_COPY_PHASE, {
      parameters: { engagement: 'eng-4', account: 'acc-2', phase: 'partner' },
      options: EXECUTE_ALL_V2,
    });

    expect(answer).toEqual(
      applied(
        editsOf(
          [
            { type: 'modifyObject', primaryKey: 'acc-2', objectType: ACCOUNT },
            { type: 'modifyObject', primaryKey: 'eng-4', objectType: ENGAGEMENT },
          ],
          { modified: 2 },
        ),
      ),
    );

    expect(await accounts()).toEqual([
      accountRow('acc-1', 'Acme', 'customer'),
      accountRow('acc-2', 'Globex', 'partner', null, newVersion('1')),
      accountRow('acc-3', 'Initech', 'customer'),
    ]);

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow('eng-4', 'acc-2', 'Pilot', 15000, 'prospect', '2026-10-17T18:20:06.135Z', newVersion('1')),
      ),
    );
  });

  it('ontology/action-types/rules#values: the twin copy-account-phase copies the phase of the Account to the status of the Engagement', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    await service.apply(COPY_ACCOUNT_PHASE, {
      parameters: { objectToModifyParameter: 'eng-1', account: 'acc-2' },
      options: EXECUTE_NONE,
    });

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow(
          'eng-1',
          'acc-1',
          'Discovery workshop',
          12000,
          'prospect',
          '2026-10-17T18:20:05.687Z',
          newVersion('1'),
        ),
      ),
    );

    expect(await accounts()).toEqual(CLIENT_ACCOUNT_ROWS);
  });
});

describe('list parameters', () => {
  it('ontology/action-types/action-types#parameters: a create with no value for a list parameter writes [] to its Property', async () => {
    await service.apply(CREATE_TAGGED_ACCOUNT, {
      parameters: { accountId: 'acc-t1', name: 'No tags' },
      options: EXECUTE_NONE,
    });

    await service.apply(CREATE_TAGGED_ACCOUNT, {
      parameters: { accountId: 'acc-t2', name: 'Tags', tags: ['a', 'b'] },
      options: EXECUTE_NONE,
    });

    expect(await accounts()).toEqual([
      accountRow('acc-t1', 'No tags', null, [], newVersion()),
      accountRow('acc-t2', 'Tags', null, ['a', 'b'], newVersion()),
    ]);
  });

  it('ontology/action-types/action-types#parameters: a modify with no value for a list parameter writes [] to its Property', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-t1', name: 'Tagged', tags: ['a'] }]);

    await service.apply(SET_ACCOUNT_TAGS, { parameters: { account: 'acc-t1' }, options: EXECUTE_NONE });

    expect(await accounts()).toEqual([accountRow('acc-t1', 'Tagged', null, [], newVersion('1'))]);
  });
});

describe('the list rules of a rule-backed Action', () => {
  const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };

  const NULL_LIST = {
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'ApplyActionFailed',
      parameters: {
        originalErrorName: 'Ontos:SingletonValueForListParameter',
        userErrorMessage: 'The Action could not apply because of an invalid list parameter.',
        builderErrorMessage: 'A list parameter received a single value instead of a list.',
      },
    },
  };

  const invalidTags = (parameterValue: unknown) => ({
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'InvalidParameterValue',
      parameters: { parameterBaseType: 'String', parameterId: 'tags', parameterValue },
    },
  });

  const TAGGED = accountRow('acc-t1', 'Tagged', null, ['start']);

  async function expectRefused(tags: unknown, expected: unknown): Promise<void> {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-t1', name: 'Tagged', tags: ['start'] }]);

    for (const options of [VALIDATE_ONLY, EXECUTE_ALL_V2]) {
      expect(
        errorAnswer(
          await service.apply(CREATE_TAGGED_ACCOUNT, {
            parameters: { accountId: 'acc-t2', name: 'New', tags },
            options,
          }),
        ),
      ).toEqual(expected);

      expect(
        errorAnswer(await service.apply(SET_ACCOUNT_TAGS_KEPT, { parameters: { account: 'acc-t1', tags }, options })),
      ).toEqual(expected);
    }

    expect(await accounts()).toEqual([TAGGED]);
  }

  it('ontology/action-types/action-types#parameters, service/http-api#errors: null for a String list gets 400 ApplyActionFailed on a create and on a modify in both modes, and the Action writes nothing', async () => {
    await expectRefused(null, NULL_LIST);
  });

  it.each([[[null]], [['a', null, 'b']]])(
    'ontology/action-types/action-types#parameters: the String list %j gets 400 InvalidParameterValue with the base type String and the whole list, on a create and on a modify',
    async (tags) => {
      await expectRefused(tags, invalidTags(tags));
    },
  );

  it('ontology/action-types/action-types#parameters: a String list with a number gets 400 InvalidParameterValue with the base type String and the whole list, on a create and on a modify', async () => {
    await expectRefused([1], invalidTags([1]));
  });

  it('ontology/action-types/action-types#parameters: a String list value that is not a list gets 400 InvalidParameterValue with the base type String and the value, on a create and on a modify', async () => {
    await expectRefused('a', invalidTags('a'));
  });

  it('ontology/action-types/rules#values, ontology/action-types/action-types#parameters: an omitted tags on a create passes with a bare arraySize, and the create writes []', async () => {
    const parameters = { accountId: 'acc-t1', name: 'No tags' };

    expect(await service.apply(CREATE_TAGGED_ACCOUNT, { parameters, options: VALIDATE_ONLY })).toEqual({
      status: 200,
      body: {
        validation: {
          result: 'VALID',
          submissionCriteria: [],
          parameters: {
            accountId: parameterResult('VALID', false),
            name: parameterResult('VALID', false),
            tags: parameterResult('VALID', false, [{ type: 'arraySize' }]),
          },
        },
      },
    });

    expect(await service.apply(CREATE_TAGGED_ACCOUNT, { parameters, options: EXECUTE_ALL_V2 })).toEqual(
      applied(editsOf([{ type: 'addObject', primaryKey: 'acc-t1', objectType: ACCOUNT }], { added: 1 })),
    );

    expect(await accounts()).toEqual([accountRow('acc-t1', 'No tags', null, [], newVersion())]);
  });

  const KEPT_VALIDATION = {
    status: 200,
    body: {
      validation: {
        result: 'VALID',
        submissionCriteria: [],
        parameters: {
          account: parameterResult('VALID', true, [{ type: 'objectQueryResult' }]),
          tags: { ...parameterResult('VALID', false, [{ type: 'arraySize' }]), defaultValue: ['start'] },
        },
      },
    },
  };

  const MODIFIED = applied(
    editsOf([{ type: 'modifyObject', primaryKey: 'acc-t1', objectType: ACCOUNT }], { modified: 1 }),
  );

  it('ontology/action-types/rules#values, ontology/action-types/action-types#parameters: an omitted tags on a modify, whose default value is its own Property, keeps the Property, and its VALIDATE_ONLY entry has defaultValue', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-t1', name: 'Tagged', tags: ['start'] }]);

    const parameters = { account: 'acc-t1' };

    expect(await service.apply(SET_ACCOUNT_TAGS_KEPT, { parameters, options: VALIDATE_ONLY })).toEqual(KEPT_VALIDATION);

    expect(await service.apply(SET_ACCOUNT_TAGS_KEPT, { parameters, options: EXECUTE_ALL_V2 })).toEqual(MODIFIED);

    expect(await accounts()).toEqual([accountRow('acc-t1', 'Tagged', null, ['start'], newVersion('1'))]);
  });

  it('ontology/action-types/action-types#parameters: tags [] on a modify whose tags has a default value passes, and the modify writes []', async () => {
    await insertObjects(service.db, ACCOUNT, [{ accountId: 'acc-t1', name: 'Tagged', tags: ['start'] }]);

    const parameters = { account: 'acc-t1', tags: [] };

    expect(await service.apply(SET_ACCOUNT_TAGS_KEPT, { parameters, options: VALIDATE_ONLY })).toEqual(KEPT_VALIDATION);

    expect(await service.apply(SET_ACCOUNT_TAGS_KEPT, { parameters, options: EXECUTE_ALL_V2 })).toEqual(MODIFIED);

    expect(await accounts()).toEqual([accountRow('acc-t1', 'Tagged', null, [], newVersion('1'))]);
  });
});

describe('struct Properties', () => {
  const probeRow = (probeId: string, relationship: object, measures: object, version = '1') => ({
    probe_id: probeId,
    relationship,
    measures,
    __version: version,
  });

  const PROBES: ObjectRow[] = [
    { probeId: 'sp-1', relationship: { label: 'introduced', since: '2024-03-01' }, measures: {} },
    { probeId: 'sp-2', relationship: { label: 'referred', since: '2025-07-15' }, measures: {} },
    { probeId: 'sp-4', relationship: {}, measures: {} },
    { probeId: 'sp-5', relationship: {}, measures: { flag: true, count: 3, score: 2.5, at: '2026-10-17T12:00:00Z' } },
  ];

  const modify = (objectToModifyParameter: string, relationship?: object) => ({
    parameters: { objectToModifyParameter, ...(relationship ? { relationship } : {}) },
    options: EXECUTE_ALL_V2,
  });

  it('ontology/action-types/rules#values, ontology/action-types/action-types#parameters: a create gives a struct Property the value of its 1 struct parameter, and each field is optional', async () => {
    for (const parameters of [
      { probeId: 'sp-1', relationship: { label: 'introduced', since: '2024-03-01' } },
      { probeId: 'sp-2', relationship: { label: 'referred', since: '2025-07-15' } },
      { probeId: 'sp-3', relationship: { label: 'introduced' } },
      { probeId: 'sp-4' },
    ]) {
      const answer = await service.apply(CREATE_STRUCT_PROBE, { parameters, options: EXECUTE_ALL_V2 });

      expect(answer).toEqual(
        applied(
          editsOf([{ type: 'addObject', primaryKey: parameters.probeId, objectType: STRUCT_PROBE }], { added: 1 }),
        ),
      );
    }

    expect(await structProbes()).toEqual([
      probeRow('sp-1', { label: 'introduced', since: '2024-03-01' }, {}, newVersion()),
      probeRow('sp-2', { label: 'referred', since: '2025-07-15' }, {}, newVersion()),
      probeRow('sp-3', { label: 'introduced' }, {}, newVersion()),
      probeRow('sp-4', {}, {}, newVersion()),
    ]);
  });

  it('ontology/action-types/rules#values, ontology/action-types/action-types#parameters: a modify replaces the whole struct value with the value of its struct parameter', async () => {
    await insertObjects(service.db, STRUCT_PROBE, PROBES);

    for (const [key, relationship] of [
      ['sp-1', { label: 'partner' }],
      ['sp-2', undefined],
      ['sp-4', { label: 'met', since: '2026-01-02' }],
      ['sp-5', { label: 'met', since: '2026-01-02' }],
    ] as const) {
      const answer = await service.apply(SET_STRUCT_PROBE_RELATIONSHIP, modify(key, relationship));

      expect(answer).toEqual(
        applied(editsOf([{ type: 'modifyObject', primaryKey: key, objectType: STRUCT_PROBE }], { modified: 1 })),
      );
    }

    expect(await structProbes()).toEqual([
      probeRow('sp-1', { label: 'partner' }, {}, newVersion('1')),
      probeRow('sp-2', {}, {}, newVersion('1')),
      probeRow('sp-4', { label: 'met', since: '2026-01-02' }, {}, newVersion('1')),
      probeRow(
        'sp-5',
        { label: 'met', since: '2026-01-02' },
        { flag: true, count: 3, score: 2.5, at: '2026-10-17T12:00:00Z' },
        newVersion('1'),
      ),
    ]);
  });
});

describe('the compile of the rules to 1 edit for each Object', () => {
  it('ontology/action-types/rules#compile, ontology/action-types/action-types#apply: 2 rules on 1 Object give 1 edit, and a later rule wins for the same Property', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(SET_STATUS_TWICE, {
      parameters: { engagement: 'eng-2', status: 'second' },
      options: EXECUTE_ALL_V2,
    });

    expect(answer).toEqual(
      applied(editsOf([{ type: 'modifyObject', primaryKey: 'eng-2', objectType: ENGAGEMENT }], { modified: 1 })),
    );

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow('eng-2', 'acc-1', 'Set twice', 48000, 'second', '2026-10-17T18:20:05.839Z', newVersion('1')),
      ),
    );
  });

  it('ontology/action-types/rules#compile: a modify and then a delete of 1 Object give 1 deleteObject edit', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(MODIFY_THEN_DELETE, {
      parameters: { engagement: 'eng-2' },
      options: EXECUTE_ALL_V2,
    });

    expect(answer).toEqual(
      applied(editsOf([{ type: 'deleteObject', primaryKey: 'eng-2', objectType: ENGAGEMENT }], { deleted: 1 })),
    );

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS.filter((row) => row.engagement_id !== 'eng-2'));
  });

  it('ontology/action-types/rules#compile: rules on 2 Objects give 1 edit for each, in rule order', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(MODIFY_THEN_CREATE, {
      parameters: { engagement: 'eng-2', engagementId: 'eng-8' },
      options: EXECUTE_ALL_V2,
    });

    expect(answer).toEqual(
      applied(
        editsOf(
          [
            { type: 'modifyObject', primaryKey: 'eng-2', objectType: ENGAGEMENT },
            { type: 'addObject', primaryKey: 'eng-8', objectType: ENGAGEMENT },
          ],
          { added: 1, modified: 1 },
        ),
      ),
    );

    expect(await engagements()).toEqual([
      ...engagementRowsWith(
        engagementRow(
          'eng-2',
          'acc-1',
          'Ontology build',
          48000,
          'modified',
          '2026-10-17T18:20:05.839Z',
          newVersion('1'),
        ),
      ),
      engagementRow('eng-8', null, 'Created', null, null, null, newVersion()),
    ]);
  });

  it('ontology/action-types/rules#compile: refuses an Action whose rules delete an Object and then change it, and writes nothing', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(DELETE_THEN_MODIFY, {
      parameters: { engagement: 'eng-2' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(REFUSED);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });

  it('ontology/action-types/rules#compile: refuses an Action whose rules change an Object before they create it, and writes nothing', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(MODIFY_THEN_CREATE, {
      parameters: { engagement: 'eng-2', engagementId: 'eng-2' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(REFUSED);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });

  it('ontology/action-types/rules#compile: refuses an Action whose rules create the same Object twice, and writes nothing', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(CREATE_TWICE, {
      parameters: { engagementId: 'eng-8', otherEngagementId: 'eng-8' },
      options: EXECUTE_NONE,
    });

    expect(errorAnswer(answer)).toEqual(REFUSED);

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });

  it('ontology/action-types/rules#rule-kinds: a Modify object or Delete object rule cannot use an Object that the same Action creates', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    for (const apiName of [CREATE_THEN_MODIFY, CREATE_THEN_DELETE]) {
      const answer = await service.apply(apiName, {
        parameters: { engagement: 'eng-2', engagementId: 'eng-2' },
        options: EXECUTE_NONE,
      });

      expect(errorAnswer(answer)).toEqual(REFUSED);
    }

    expect(await engagements()).toEqual(CLIENT_ENGAGEMENT_ROWS);
  });
});

describe('the primary key of an Object', () => {
  it('ontology/object-link-types/properties#keys: a Modify object rule that maps the primary key Property does not change the primary key', async () => {
    await seedClient(service.db, CLIENT_ACCOUNTS, [...CLIENT_ENGAGEMENTS, ENG_7]);

    const answer = await service.apply(SET_ENGAGEMENT_KEY, {
      parameters: { engagement: 'eng-3', engagementId: 'eng-9', title: 'Renamed' },
      options: EXECUTE_ALL_V2,
    });

    expect(answer).toEqual(
      applied(editsOf([{ type: 'modifyObject', primaryKey: 'eng-3', objectType: ENGAGEMENT }], { modified: 1 })),
    );

    expect(await engagements()).toEqual(
      engagementRowsWith(
        engagementRow('eng-3', 'acc-1', 'Renamed', 6000, 'open', '2026-10-17T18:20:05.991Z', newVersion('1')),
      ),
    );
  });
});
