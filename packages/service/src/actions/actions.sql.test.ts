import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import {
  actionType,
  insertObjects,
  modifyRule,
  newVersion,
  NS,
  parameterValue,
  startActions,
  type ActionsService,
  type RawAnswer,
} from './actions.test-utils.ts';
import { policiesIr, unchecked, USE } from '../ontology/stored.test-utils.ts';
import { actionOf, withFunctions, type TestFunction } from '../functions/functions.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { groupGrants, policyPeople } from '../policiesPeople.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ONTOLOGY = `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}`;

const ROLES = { admin: ['ontology:install', USE, 'admin'], member: [USE, 'member'] };

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    ben: { sub: 'user_ben', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
  },
  ROLES,
);

type Person = keyof typeof PEOPLE;

const CREATE_ACCOUNT = `${NS}create-account`;
const DELETE_ACCOUNT = `${NS}delete-account`;
const SET_ACCOUNT_PHASE = `${NS}set-account-phase`;
const COPY_ACCOUNT_PHASE = `${NS}copy-account-phase`;
const ADD_PARTNER = `${NS}add-partner`;
const REMOVE_PARTNER = `${NS}remove-partner`;
const SET_STATUS_IF_PROSPECT = `${NS}set-status-if-prospect`;
const SET_ENGAGEMENT_ACCOUNT = `${NS}set-engagement-account`;
const SET_STATUS_WITH_ACCOUNTS = `${NS}set-status-with-accounts`;

const byKey = [{ name: 'accountId', type: 'string' }] as const;
const linkInputs = [{ name: 'engagementId', type: 'string' }, ...byKey] as const;

const FUNCTIONS: TestFunction[] = [
  { apiName: 'closeAccountByKey', inputs: byKey, edits: [ACCOUNT] },
  { apiName: 'deleteAccountByKey', inputs: byKey, edits: [ACCOUNT] },
  { apiName: 'linkPartnerByKey', inputs: linkInputs, edits: [ACCOUNT, ENGAGEMENT], links: ['engagementPartners'] },
  { apiName: 'unlinkPartnerByKey', inputs: linkInputs, edits: [ACCOUNT, ENGAGEMENT], links: ['engagementPartners'] },
  {
    apiName: 'closeAccountObject',
    inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }],
    edits: [ACCOUNT],
  },
  { apiName: 'linkFromAccountByKey', inputs: linkInputs, edits: [ACCOUNT, ENGAGEMENT], links: ['engagementPartners'] },
  { apiName: 'closeProspect', inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }], edits: [ACCOUNT] },
  { apiName: 'markAccount', inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }], edits: [ACCOUNT] },
  {
    apiName: 'markAccounts',
    inputs: [{ name: 'accounts', type: 'objectList', objectType: ACCOUNT }],
    edits: [ACCOUNT],
  },
];

const MARKER = 'marker-the-function-ran';

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const account = (accountId) => ({ $apiName: '${ACCOUNT}', $primaryKey: accountId });
const engagement = (engagementId) => ({ $apiName: '${ENGAGEMENT}', $primaryKey: engagementId });
// The first step of a marking Function: a read of the marker key, which the test sees in the snapshot.
const mark = (client) => client({ type: 'object', apiName: '${ACCOUNT}' }).where({ accountId: { $eq: '${MARKER}' } }).fetchPage();

export const functions = {
  closeAccountByKey: async (client, accountId) => {
    const batch = createEditBatch(client);
    batch.update(account(accountId), { phase: 'closed' });
    return batch.getEdits();
  },
  deleteAccountByKey: async (client, accountId) => {
    const batch = createEditBatch(client);
    batch.delete(account(accountId));
    return batch.getEdits();
  },
  linkPartnerByKey: async (client, engagementId, accountId) => {
    const batch = createEditBatch(client);
    batch.link(engagement(engagementId), 'partners', account(accountId));
    return batch.getEdits();
  },
  unlinkPartnerByKey: async (client, engagementId, accountId) => {
    const batch = createEditBatch(client);
    batch.unlink(engagement(engagementId), 'partners', account(accountId));
    return batch.getEdits();
  },
  linkFromAccountByKey: async (client, engagementId, accountId) => {
    const batch = createEditBatch(client);
    batch.link(account(accountId), 'partnerEngagements', engagement(engagementId));
    return batch.getEdits();
  },
  closeProspect: async (client, input) => {
    await mark(client);
    const batch = createEditBatch(client);
    batch.update(input, { phase: 'closed' });
    return batch.getEdits();
  },
  markAccount: async (client) => {
    await mark(client);
    throw new Error('The Function ran.');
  },
  markAccounts: async (client) => {
    await mark(client);
    throw new Error('The Function ran.');
  },
  closeAccountObject: async (client, input) => {
    const batch = createEditBatch(client);
    batch.update(input, { phase: 'closed' });
    return batch.getEdits();
  },
};
`;

const stringParameter = {
  type: { type: 'string', string: {} },
  allowedValues: { type: 'text', text: { type: 'text', text: {} } },
  required: { type: 'required', required: {} },
};

const objectParameter = (objectTypeId: string) => ({
  type: { type: 'objectReference', objectReference: { objectTypeId } },
  allowedValues: { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } },
  required: { type: 'required', required: {} },
});

const objectListParameter = (objectTypeId: string) => ({
  ...objectParameter(objectTypeId),
  type: { type: 'objectReferenceList', objectReferenceList: { objectTypeId } },
});

const linkRule = (kind: 'addLinkRule' | 'deleteLinkRule') => ({
  type: kind,
  [kind]: { linkTypeId: 'engagement-partners', sourceObject: 'engagement', targetObject: 'account' },
});

function testIr(base: OntologyIr): OntologyIr {
  const ir = structuredClone(base);

  for (const apiName of [ACCOUNT, ENGAGEMENT]) {
    const block = ir.ontology.objectTypes[apiName];

    if (!block) throw new Error(`policies.json has no ${apiName}.`);

    block.entityMetadata = unchecked({
      ...block.entityMetadata,
      editsHistory: { type: 'config', config: { store: apiName, storeAllPreviousProperties: true } },
    });
  }

  const link = { engagement: objectParameter(ENGAGEMENT), account: objectParameter(ACCOUNT) };

  const ifProspect = actionType(SET_STATUS_IF_PROSPECT, { ...link, status: stringParameter }, [
    modifyRule('engagement', { status: parameterValue('status') }),
  ]);

  const condition = {
    type: 'comparison',
    comparison: {
      operator: 'EQUALS',
      left: {
        type: 'objectParameterPropertyValue',
        objectParameterPropertyValue: { parameterId: 'account', propertyTypeId: 'phase' },
      },
      right: { type: 'staticValue', staticValue: { type: 'string', string: 'prospect' } },
    },
  };

  const closeProspect = ir.ontology.actionTypes[actionOf('closeProspect')];

  if (!closeProspect) throw new Error('withFunctions made no fn-close-prospect.');

  for (const block of [ifProspect, closeProspect]) {
    block.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = {
      '0': unchecked({
        condition,
        displayMetadata: { failureMessage: 'The Account must be a prospect.', typeClasses: [] },
      }),
    };
  }

  for (const block of [
    actionType(ADD_PARTNER, link, [linkRule('addLinkRule')]),
    actionType(REMOVE_PARTNER, link, [linkRule('deleteLinkRule')]),
    actionType(SET_ENGAGEMENT_ACCOUNT, { engagement: link.engagement, accountId: stringParameter }, [
      modifyRule('engagement', { accountId: parameterValue('accountId') }),
    ]),
    ifProspect,
    actionType(
      SET_STATUS_WITH_ACCOUNTS,
      { engagement: link.engagement, accounts: objectListParameter(ACCOUNT), status: stringParameter },
      [modifyRule('engagement', { status: parameterValue('status') })],
    ),
  ]) {
    ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;
  }

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, policiesIr());

  const full = testIr(ir);

  service = await startActions(full, functions, groupGrants(full, ROLES));
});

afterAll(() => service?.stop());

beforeEach(seed);

const accountRow = (accountId: string, phase: string, ownerId: string) => ({
  accountId,
  name: accountId,
  phase,
  ownerId,
  viewers: ['reviewer'],
});

async function seed(): Promise<void> {
  await service.clear();

  await insertObjects(service.db, ACCOUNT, [
    accountRow('acc-1', 'customer', 'user_ann'),
    accountRow('acc-2', 'prospect', 'user_ben'),
    accountRow('acc-3', 'prospect', 'user_carl'),
  ]);

  const engagement = (engagementId: string, accountId: string) => ({
    engagementId,
    accountId,
    title: engagementId,
    amount: 1000,
    status: 'open',
    createdAt: null,
  });

  await insertObjects(service.db, ENGAGEMENT, [engagement('eng-1', 'acc-1'), engagement('eng-2', 'acc-2')]);

  for (const [engagementId, accountId] of [
    ['eng-1', 'acc-3'],
    ['eng-2', 'acc-2'],
  ]) {
    await service.db.query(
      sql(
        'INSERT INTO ontology_1_objects.engagement_partners (a_engagement_id, b_account_id) VALUES ($1, $2)',
        engagementId,
        accountId,
      ),
    );
  }
}

async function removeAcc3(): Promise<void> {
  await service.db.query(sql("DELETE FROM ontology_1_objects.engagement_partners WHERE b_account_id = 'acc-3'"));

  await service.db.query(sql("DELETE FROM ontology_1_objects.account WHERE account_id = 'acc-3'"));
}

async function tables(): Promise<unknown> {
  const all = (text: string) => service.db.query(sql(text));

  return {
    accounts: await all(
      'SELECT account_id, phase, owner_id, viewers, __version FROM ontology_1_objects.account ORDER BY account_id',
    ),
    engagements: await all(
      'SELECT engagement_id, account_id, status, __version FROM ontology_1_objects.engagement ORDER BY engagement_id',
    ),
    partners: await all(
      'SELECT a_engagement_id, b_account_id FROM ontology_1_objects.engagement_partners ORDER BY a_engagement_id, b_account_id',
    ),
    history: await all(
      'SELECT object_type, primary_key, entry FROM ontology_1_engine.edit_history ORDER BY created_at, primary_key',
    ),
  };
}

const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const VALIDATE = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };

type Mode = typeof EXECUTE | typeof VALIDATE;

function applyRaw(
  action: string,
  parameters: object,
  person: Person,
  options: { mode?: Mode; db?: Db | undefined } = {},
): Promise<RawAnswer> {
  return service.call(
    'POST',
    `${ONTOLOGY}/actions/${action}/apply`,
    { parameters, options: options.mode ?? EXECUTE },
    { ...PEOPLE[person], ...(options.db ? { db: options.db } : {}) },
  );
}

function parsed(answer: RawAnswer): { status: number; body: unknown } {
  const { errorInstanceId, ...body } = JSON.parse(answer.text) as Record<string, unknown>;

  if (errorInstanceId !== undefined)
    expect(errorInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  return { status: answer.status, body };
}

const withoutIds = (text: string) =>
  text.replaceAll(/((?:errorInstanceId|operationId)\W+)(?:ri\.actions\.main\.action\.)?[0-9a-f-]{36}/g, '$1<id>');

async function asMissing(apply: () => Promise<RawAnswer>): Promise<{ status: number; body: unknown }> {
  const before = await tables();

  const hidden = await apply();

  expect(await tables()).toEqual(before);

  await removeAcc3();

  const empty = await tables();

  const missing = await apply();

  expect(await tables()).toEqual(empty);

  expect({ status: hidden.status, text: withoutIds(hidden.text) }).toEqual({
    status: missing.status,
    text: withoutIds(missing.text),
  });

  return parsed(hidden);
}

const NOT_FOUND = {
  status: 404,
  body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
};

const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

const ALREADY_EXISTS = {
  status: 409,
  body: { errorCode: 'CONFLICT', errorName: 'ObjectAlreadyExists', parameters: {} },
};

const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };

const DELETED_ACC_3 = {
  status: 200,
  body: {
    operationId: expect.stringMatching(/^ri\.actions\.main\.action\./),
    validation: VALID,
    edits: {
      type: 'edits',
      edits: [{ type: 'deleteObject', primaryKey: 'acc-3', objectType: ACCOUNT }],
      addedObjectCount: 0,
      modifiedObjectsCount: 0,
      deletedObjectsCount: 1,
      addedLinksCount: 0,
      deletedLinksCount: 0,
    },
  },
};

async function visibleAccounts(person: Person): Promise<unknown> {
  const answer = await service.call(
    'POST',
    `${ONTOLOGY}/objectSets/loadObjects`,
    {
      objectSet: { type: 'base', objectType: ACCOUNT },
      select: ['accountId'],
      orderBy: { fields: [{ field: 'accountId', direction: 'asc' }] },
    },
    PEOPLE[person],
  );

  return (JSON.parse(answer.text) as { data: { accountId: string }[] }).data.map((object) => object.accountId);
}

const RULE_EDITS = [
  [
    'a modify',
    SET_ACCOUNT_PHASE,
    { objectToModifyParameter: 'acc-3', phase: 'closed', ownerId: 'user_ben', viewers: ['member'] },
  ],
  ['a delete', DELETE_ACCOUNT, { objectToDeleteParameter: 'acc-3' }],
  ['an add of a Link', ADD_PARTNER, { engagement: 'eng-2', account: 'acc-3' }],
  ['a delete of a Link', REMOVE_PARTNER, { engagement: 'eng-1', account: 'acc-3' }],
] as const;

const VALID_ACCOUNT_ID = {
  status: 200,
  body: {
    validation: {
      ...VALID,
      parameters: { accountId: { evaluatedConstraints: [], required: true, result: 'VALID' } },
    },
  },
};

const FUNCTION_EDITS = [
  ['an update', 'closeAccountByKey', { accountId: 'acc-3' }, NOT_FOUND, NOT_FOUND],
  ['a delete', 'deleteAccountByKey', { accountId: 'acc-3' }, DELETED_ACC_3, VALID_ACCOUNT_ID],
  ['a link', 'linkPartnerByKey', { engagementId: 'eng-2', accountId: 'acc-3' }, NOT_FOUND, NOT_FOUND],
  ['an unlink', 'unlinkPartnerByKey', { engagementId: 'eng-1', accountId: 'acc-3' }, NOT_FOUND, NOT_FOUND],
  [
    'a link from the Account side',
    'linkFromAccountByKey',
    { engagementId: 'eng-2', accountId: 'acc-3' },
    NOT_FOUND,
    NOT_FOUND,
  ],
] as const;

describe('an edit of a hidden Object answers as a missing Object, and writes nothing', () => {
  it.each(RULE_EDITS)(
    'ontology/action-types/action-types#security: %s by a rule-backed Action gets 404 ObjectNotFound',
    async (_edit, action, parameters) => {
      expect(await asMissing(() => applyRaw(action, parameters, 'ben'))).toEqual(NOT_FOUND);
    },
  );

  it.each(RULE_EDITS)(
    'ontology/action-types/action-types#security: %s by a rule-backed Action with VALIDATE_ONLY gets 404 ObjectNotFound',
    async (_edit, action, parameters) => {
      expect(await asMissing(() => applyRaw(action, parameters, 'ben', { mode: VALIDATE }))).toEqual(NOT_FOUND);
    },
  );

  it.each(FUNCTION_EDITS)(
    'ontology/action-types/action-types#security: %s of a hidden key by a Function gets the answer of a missing key, never 409',
    async (_edit, fn, parameters, expectedExecute) => {
      expect(await asMissing(() => applyRaw(actionOf(fn), parameters, 'ben'))).toEqual(expectedExecute);
    },
  );

  it.each(FUNCTION_EDITS)(
    'ontology/action-types/action-types#security: %s of a hidden key by a Function with VALIDATE_ONLY gets the answer of a missing key',
    async (_edit, fn, parameters, _expectedExecute, expectedValidate) => {
      expect(await asMissing(() => applyRaw(actionOf(fn), parameters, 'ben', { mode: VALIDATE }))).toEqual(
        expectedValidate,
      );
    },
  );

  it('ontology/action-types/action-types#security: the admin, who sees acc-3, applies each of the same edits', async () => {
    for (const [, action, parameters] of RULE_EDITS) {
      expect((await applyRaw(action, parameters, 'admin')).status).toBe(200);

      await seed();
    }

    for (const [, fn, parameters] of FUNCTION_EDITS) {
      expect((await applyRaw(actionOf(fn), parameters, 'admin')).status).toBe(200);

      await seed();
    }
  });

  it('a member with the grant of delete-account deletes their own Account, and the policy refuses acc-3', async () => {
    expect(parsed(await applyRaw(DELETE_ACCOUNT, { objectToDeleteParameter: 'acc-2' }, 'ben'))).toMatchObject({
      status: 200,
      body: { validation: VALID },
    });

    expect(await visibleAccounts('admin')).toEqual(['acc-1', 'acc-3']);

    expect(await asMissing(() => applyRaw(DELETE_ACCOUNT, { objectToDeleteParameter: 'acc-3' }, 'ben'))).toEqual(
      NOT_FOUND,
    );
  });
});

describe('a read of a hidden Object by the apply', () => {
  it('ontology/action-types/action-types#security: a rule value that reads the phase of a hidden Account gets 404, and the Engagement stays', async () => {
    expect(
      await asMissing(() =>
        applyRaw(COPY_ACCOUNT_PHASE, { objectToModifyParameter: 'eng-2', account: 'acc-3' }, 'ben'),
      ),
    ).toEqual(NOT_FOUND);
  });

  it.each([
    ['VALIDATE_AND_EXECUTE', EXECUTE],
    ['VALIDATE_ONLY', VALIDATE],
  ])(
    'ontology/action-types/action-types#security: a submission criterion on a hidden Account gets 404 with %s, not its own message',
    async (_mode, mode) => {
      const apply = () =>
        applyRaw(SET_STATUS_IF_PROSPECT, { engagement: 'eng-2', account: 'acc-3', status: 'won' }, 'ben', { mode });

      expect(await asMissing(apply)).toEqual(NOT_FOUND);

      await seed();

      await service.db.query(
        sql("UPDATE ontology_1_objects.account SET phase = 'customer' WHERE account_id = 'acc-3'"),
      );

      expect(await asMissing(apply)).toEqual(NOT_FOUND);
    },
  );

  it('ontology/action-types/action-types#security: the same criterion on a visible Account passes and fails with its own message', async () => {
    expect(
      parsed(await applyRaw(SET_STATUS_IF_PROSPECT, { engagement: 'eng-2', account: 'acc-2', status: 'won' }, 'ben')),
    ).toMatchObject({ status: 200, body: { validation: VALID } });

    const failed = parsed(
      await applyRaw(SET_STATUS_IF_PROSPECT, { engagement: 'eng-1', account: 'acc-1', status: 'won' }, 'ann'),
    );

    expect(failed).toMatchObject({
      status: 200,
      body: {
        validation: {
          result: 'INVALID',
          submissionCriteria: [{ configuredFailureMessage: 'The Account must be a prospect.', result: 'INVALID' }],
        },
      },
    });
  });

  it('ontology/functions/functions#errors: an Object input of a hidden Account gets 400 FunctionExecutionFailed, and the Function writes nothing', async () => {
    expect(await asMissing(() => applyRaw(actionOf('closeAccountObject'), { account: 'acc-3' }, 'ben'))).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'FunctionExecutionFailed',
        parameters: {
          functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
          functionVersion: '1.0.0',
          message: 'Object not found',
        },
      },
    });

    expect((await applyRaw(actionOf('closeAccountObject'), { account: 'acc-2' }, 'ben')).status).toBe(200);
  });
});

describe('the Objects that a Function and an Object list read', () => {
  function markedDb(): { readonly db: Db; readonly ran: () => boolean } {
    const values: unknown[] = [];

    const db: Db = {
      query: <Row extends object>(statement: Sql) => service.db.query<Row>(statement),
      stream: <Row extends object>(statement: Sql) => service.db.stream<Row>(statement),
      transaction: (run) => service.db.transaction(run),
      snapshot: (run) =>
        service.db.snapshot((snapshot) =>
          run({
            ...snapshot,
            query: <Row extends object>(statement: Sql) => {
              values.push(...statement.values);

              return snapshot.query<Row>(statement);
            },
            stream: <Row extends object>(statement: Sql) => {
              values.push(...statement.values);

              return snapshot.stream<Row>(statement);
            },
          }),
        ),
    };

    return { db, ran: () => JSON.stringify(values).includes(MARKER) };
  }

  it.each([
    ['VALIDATE_AND_EXECUTE', EXECUTE],
    ['VALIDATE_ONLY', VALIDATE],
  ])(
    'ontology/action-types/action-types#security: a criterion of a function-backed Action on a hidden Account fails with its own message, as for a missing one, with %s, and the Function does not run',
    async (_mode, mode) => {
      const marked = markedDb();

      expect(
        await asMissing(() =>
          applyRaw(actionOf('closeProspect'), { account: 'acc-3' }, 'ben', { mode, db: marked.db }),
        ),
      ).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [{ configuredFailureMessage: 'The Account must be a prospect.', result: 'INVALID' }],
            parameters: {
              account: { evaluatedConstraints: [{ type: 'objectQueryResult' }], required: true, result: 'VALID' },
            },
          },
        },
      });

      expect(marked.ran()).toBe(false);

      await seed();

      const visible = markedDb();

      expect(
        parsed(await applyRaw(actionOf('closeProspect'), { account: 'acc-2' }, 'ben', { mode, db: visible.db })),
      ).toMatchObject({ status: 200, body: { validation: VALID } });

      expect(visible.ran()).toBe(true);
    },
  );

  it.each([
    ['an Object input', 'markAccount', { account: 'acc-3' }, { account: 'acc-2' }],
    [
      'an Object list input with 1 hidden element',
      'markAccounts',
      { accounts: ['acc-2', 'acc-3'] },
      { accounts: ['acc-2'] },
    ],
  ])(
    'ontology/functions/functions#errors: %s of a hidden Account gets 400, and the Function does not run; with a visible Account it runs',
    async (_input, fn, hidden, visible) => {
      const marked = markedDb();

      expect(await asMissing(() => applyRaw(actionOf(fn), hidden, 'ben', { db: marked.db }))).toMatchObject({
        status: 400,
        body: {
          errorName: 'FunctionExecutionFailed',
          parameters: { message: 'Object not found' },
        },
      });

      expect(marked.ran()).toBe(false);

      const ran = markedDb();

      expect(parsed(await applyRaw(actionOf(fn), visible, 'ben', { db: ran.db }))).toMatchObject({
        status: 400,
        body: { errorName: 'FunctionExecutionFailed', parameters: { message: 'The Function ran.' } },
      });

      expect(ran.ran()).toBe(true);
    },
  );

  it('ontology/action-types/action-types#security: an Object list parameter of a rule-backed Action with 1 hidden Account gets 404, as with a missing one', async () => {
    const apply = () =>
      applyRaw(SET_STATUS_WITH_ACCOUNTS, { engagement: 'eng-2', accounts: ['acc-2', 'acc-3'], status: 'won' }, 'ben');

    expect(await asMissing(apply)).toEqual(NOT_FOUND);

    expect(
      parsed(
        await applyRaw(SET_STATUS_WITH_ACCOUNTS, { engagement: 'eng-2', accounts: ['acc-2'], status: 'won' }, 'ben'),
      ),
    ).toMatchObject({ status: 200, body: { validation: VALID } });
  });
});

describe('a create and a foreign key', () => {
  it('ontology/action-types/action-types#security: a create of a new key for another owner applies, and the person cannot load the new Account', async () => {
    const created = parsed(
      await applyRaw(
        CREATE_ACCOUNT,
        { accountId: 'acc-9', name: 'Wayne', phase: 'prospect', ownerId: 'user_carl', viewers: ['reviewer'] },
        'ben',
      ),
    );

    expect(created).toMatchObject({
      status: 200,
      body: {
        validation: VALID,
        edits: {
          type: 'edits',
          edits: [{ type: 'addObject', primaryKey: 'acc-9', objectType: ACCOUNT }],
          addedObjectCount: 1,
        },
      },
    });

    expect(await visibleAccounts('ben')).toEqual(['acc-2']);

    expect(await visibleAccounts('admin')).toEqual(['acc-1', 'acc-2', 'acc-3', 'acc-9']);
  });

  it('ontology/action-types/action-types#security: a create of the key of a hidden Account gets 409 ObjectAlreadyExists, the same bytes as for a visible Account', async () => {
    const create = (accountId: string) =>
      applyRaw(
        CREATE_ACCOUNT,
        { accountId, name: 'Wayne', phase: 'prospect', ownerId: 'user_ben', viewers: ['reviewer'] },
        'ben',
      );

    const before = await tables();

    const [hidden, visible] = [await create('acc-3'), await create('acc-2')];

    expect(await tables()).toEqual(before);

    expect(parsed(hidden)).toEqual(ALREADY_EXISTS);
    expect(withoutIds(hidden.text)).toBe(withoutIds(visible.text));
  });

  it('ontology/action-types/action-types#security: a modify that sets the foreign key to a hidden Account applies, and the Search Around still hides it', async () => {
    expect(
      parsed(await applyRaw(SET_ENGAGEMENT_ACCOUNT, { engagement: 'eng-2', accountId: 'acc-3' }, 'ben')),
    ).toMatchObject({ status: 200, body: { validation: VALID } });

    const around = (person: Person) =>
      service.call(
        'POST',
        `${ONTOLOGY}/objectSets/loadObjects`,
        {
          objectSet: {
            type: 'searchAround',
            objectSet: {
              type: 'filter',
              objectSet: { type: 'base', objectType: ENGAGEMENT },
              where: { type: 'eq', field: 'engagementId', value: 'eng-2' },
            },
            link: 'account',
          },
          select: ['accountId'],
        },
        PEOPLE[person],
      );

    expect((JSON.parse((await around('ben')).text) as { data: unknown[] }).data).toEqual([]);

    expect(
      (JSON.parse((await around('admin')).text) as { data: { accountId: string }[] }).data.map(
        (object) => object.accountId,
      ),
    ).toEqual(['acc-3']);
  });
});

describe('an edit that changes who sees the Object', () => {
  it('ontology/action-types/action-types#security: a person who gives their Account to another owner then cannot edit it, and gets the 404 of a missing key', async () => {
    const give = { objectToModifyParameter: 'acc-1', phase: 'closed', ownerId: 'user_ben', viewers: ['reviewer'] };

    expect(parsed(await applyRaw(SET_ACCOUNT_PHASE, give, 'ann'))).toMatchObject({
      status: 200,
      body: { validation: VALID },
    });

    expect([await visibleAccounts('ann'), await visibleAccounts('ben')]).toEqual([[], ['acc-1', 'acc-2']]);

    const again = parsed(await applyRaw(SET_ACCOUNT_PHASE, { ...give, ownerId: 'user_ann' }, 'ann'));

    expect(again).toEqual(NOT_FOUND);

    expect(await visibleAccounts('ann')).toEqual([]);
  });

  it('ontology/action-types/action-types#security: an edit that would make a hidden Account visible to the person gets 404, and only the admin can make it visible', async () => {
    const take = { objectToModifyParameter: 'acc-3', phase: 'prospect', ownerId: 'user_ben', viewers: ['reviewer'] };

    expect(await asMissing(() => applyRaw(SET_ACCOUNT_PHASE, take, 'ben'))).toEqual(NOT_FOUND);

    await seed();

    expect((await applyRaw(SET_ACCOUNT_PHASE, take, 'admin')).status).toBe(200);

    expect(await visibleAccounts('ben')).toEqual(['acc-2', 'acc-3']);
  });

  const accountRows = async () =>
    service.db.query(
      sql("SELECT account_id, phase, owner_id, viewers FROM ontology_1_objects.account WHERE account_id = 'acc-1'"),
    );

  it('ontology/action-types/rules#values: a modify that sends only phase keeps the policy Properties ownerId and viewers, so ann still loads her Account', async () => {
    const answer = parsed(
      await applyRaw(SET_ACCOUNT_PHASE, { objectToModifyParameter: 'acc-1', phase: 'closed' }, 'ann'),
    );

    expect(answer).toMatchObject({ status: 200, body: { validation: VALID } });

    expect(await accountRows()).toEqual([
      { account_id: 'acc-1', phase: 'closed', owner_id: 'user_ann', viewers: ['reviewer'] },
    ]);

    expect([await visibleAccounts('ann'), await visibleAccounts('admin')]).toEqual([
      ['acc-1'],
      ['acc-1', 'acc-2', 'acc-3'],
    ]);

    const [entry] = (
      await service.db.query<{ entry: { edit: { type: string; properties: unknown } } }>(
        sql("SELECT entry FROM ontology_1_engine.edit_history WHERE primary_key = 'acc-1'"),
      )
    ).map((row) => row.entry.edit);

    expect([entry?.type, entry?.properties]).toEqual(['modifyEdit', { phase: 'closed' }]);
  });

  it('ontology/object-security-policies#hidden-objects, ontology/action-types/rules#values: a modify that sends "ownerId": null clears the policy Property, so the Account is hidden from each person, admin included', async () => {
    const answer = parsed(
      await applyRaw(SET_ACCOUNT_PHASE, { objectToModifyParameter: 'acc-1', ownerId: null }, 'admin'),
    );

    expect(answer).toMatchObject({ status: 200, body: { validation: VALID } });

    expect(await accountRows()).toEqual([
      { account_id: 'acc-1', phase: 'customer', owner_id: null, viewers: ['reviewer'] },
    ]);

    expect([await visibleAccounts('ann'), await visibleAccounts('admin')]).toEqual([[], ['acc-2', 'acc-3']]);
  });

  it('ontology/action-types/action-types#parameters: a modify that sends "viewers": null gets 400 ApplyActionFailed, and the list Property keeps its value', async () => {
    const answer = parsed(
      await applyRaw(SET_ACCOUNT_PHASE, { objectToModifyParameter: 'acc-1', viewers: null }, 'admin'),
    );

    expect(answer).toMatchObject({
      status: 400,
      body: {
        errorName: 'ApplyActionFailed',
        parameters: { originalErrorName: 'Ontos:SingletonValueForListParameter' },
      },
    });

    expect(await accountRows()).toEqual([
      { account_id: 'acc-1', phase: 'customer', owner_id: 'user_ann', viewers: ['reviewer'] },
    ]);
  });
});

function racingDb(race: () => Promise<void>, times: number): { readonly db: Db; readonly transactions: () => number } {
  let transactions = 0;

  const db: Db = {
    query: <Row extends object>(statement: Sql) => service.db.query<Row>(statement),
    stream: <Row extends object>(statement: Sql) => service.db.stream<Row>(statement),
    snapshot: (run) => service.db.snapshot(run),
    transaction: async (run) => {
      transactions += 1;

      if (transactions <= times) await race();

      return service.db.transaction(run);
    },
  };

  return { db, transactions: () => transactions };
}

const recreate = (ownerId: string | undefined) => async () => {
  expect((await applyRaw(DELETE_ACCOUNT, { objectToDeleteParameter: 'acc-1' }, 'admin')).status).toBe(200);

  if (ownerId === undefined) return;

  expect(
    (
      await applyRaw(
        CREATE_ACCOUNT,
        { accountId: 'acc-1', name: 'acc-1', phase: 'prospect', ownerId, viewers: ['reviewer'] },
        'admin',
      )
    ).status,
  ).toBe(200);
};

const acc1 = async () =>
  (
    await service.db.query<Record<string, unknown>>(
      sql("SELECT phase, owner_id, __version FROM ontology_1_objects.account WHERE account_id = 'acc-1'"),
    )
  )[0];

describe('a delete and a create of the same key between the load and the lock', () => {
  const close = { objectToModifyParameter: 'acc-1', phase: 'closed', ownerId: 'user_ann', viewers: ['reviewer'] };

  it('ontology/action-types/action-types#security: the new Account is hidden: the attempt again gets the 404 of a deleted key, and acc-1 stays as the admin made it', async () => {
    const hidden = racingDb(recreate('user_carl'), 1);

    const answer = await applyRaw(SET_ACCOUNT_PHASE, close, 'ann', { db: hidden.db });

    expect(hidden.transactions()).toBe(1);
    expect(parsed(answer)).toEqual(NOT_FOUND);

    expect(await acc1()).toEqual({ phase: 'prospect', owner_id: 'user_carl', __version: newVersion('1') });

    await seed();

    const deleted = racingDb(recreate(undefined), 1);

    const missing = await applyRaw(SET_ACCOUNT_PHASE, close, 'ann', { db: deleted.db });

    expect(withoutIds(answer.text)).toBe(withoutIds(missing.text));
  });

  it('ontology/action-types/action-types#security: the new Account is visible: each attempt fails the version check, the apply gets 409 ObjectChanged, and acc-1 stays as the admin made it', async () => {
    const visible = racingDb(recreate('user_ann'), Infinity);

    expect(parsed(await applyRaw(SET_ACCOUNT_PHASE, close, 'ann', { db: visible.db }))).toEqual(OBJECT_CHANGED);

    expect(visible.transactions()).toBe(5);

    expect(await acc1()).toEqual({ phase: 'prospect', owner_id: 'user_ann', __version: newVersion('1') });
  });

  it('ontology/action-types/action-types#security: the new Account is visible: the attempt again loads it, and the edit saves on the Object that it loaded', async () => {
    const visible = racingDb(recreate('user_ann'), 1);

    expect(parsed(await applyRaw(SET_ACCOUNT_PHASE, close, 'ann', { db: visible.db }))).toMatchObject({
      status: 200,
      body: { validation: VALID },
    });

    expect(visible.transactions()).toBe(2);

    expect(await acc1()).toEqual({ phase: 'closed', owner_id: 'user_ann', __version: newVersion('1') });
  });

  it.each([
    ['hidden', 'user_carl', { phase: 'prospect', owner_id: 'user_carl', __version: newVersion('1') }, 2],
    ['visible', 'user_ann', { phase: 'prospect', owner_id: 'user_ann', __version: newVersion('1') }, 2],
    ['missing', undefined, undefined, 1],
  ])(
    'ontology/action-types/action-types#security: a Function whose Account is deleted and created again (%s) before the lock gets 409 ObjectChanged, and writes nothing',
    async (_state, ownerId, expectedAccount, expectedHistoryLength) => {
      const raced = racingDb(recreate(ownerId), 1);

      const answer = await applyRaw(actionOf('closeAccountByKey'), { accountId: 'acc-1' }, 'ann', { db: raced.db });

      const after = await tables();

      expect(parsed(answer)).toEqual(OBJECT_CHANGED);
      expect(raced.transactions()).toBe(1);

      expect(await acc1()).toEqual(expectedAccount);

      expect((after as { history: unknown[] }).history).toHaveLength(expectedHistoryLength);
    },
  );
});

describe('a delete whose Object is deleted and created again between the load and the lock', () => {
  it.each([
    ['hidden', 'user_carl', NOT_FOUND, 1, { phase: 'prospect', owner_id: 'user_carl', __version: newVersion('1') }],
    [
      'visible',
      'user_ann',
      {
        status: 200,
        body: expect.objectContaining({
          validation: VALID,
          edits: expect.objectContaining({ deletedObjectsCount: 1 }),
        }),
      },
      2,
      undefined,
    ],
    ['missing', undefined, NOT_FOUND, 1, undefined],
  ] as const)(
    'ontology/action-types/action-types#security: a rule-backed delete of acc-1 with the new Account %s runs again, and deletes only an Account that its second attempt loaded',
    async (_state, ownerId, answer, expectedTransactions, stored) => {
      const raced = racingDb(recreate(ownerId), 1);

      expect(
        parsed(await applyRaw(DELETE_ACCOUNT, { objectToDeleteParameter: 'acc-1' }, 'ann', { db: raced.db })),
      ).toEqual(answer);

      expect(raced.transactions()).toBe(expectedTransactions);

      expect(await acc1()).toEqual(stored);
    },
  );

  it.each([
    ['hidden', 'user_carl'],
    ['visible', 'user_ann'],
    ['missing', undefined],
  ] as const)(
    'ontology/action-types/action-types#security ontology/functions/edit-functions#apply: a Function delete of acc-1 with the new Account %s gets 409 ObjectChanged, and deletes nothing',
    async (_state, ownerId) => {
      let afterRecreate: unknown;

      const raced = racingDb(async () => {
        await recreate(ownerId)();

        afterRecreate = await tables();
      }, 1);

      expect(
        parsed(await applyRaw(actionOf('deleteAccountByKey'), { accountId: 'acc-1' }, 'ann', { db: raced.db })),
      ).toEqual(OBJECT_CHANGED);

      expect(await tables()).toEqual(afterRecreate);
    },
  );
});

describe('the stored values that an edit reads', () => {
  it('ontology/action-types/action-types#security: a change between the load and the lock fails the check, and the history of the attempt again holds the values of the locked row', async () => {
    const change = async () => {
      expect(
        (
          await applyRaw(
            SET_ACCOUNT_PHASE,
            { objectToModifyParameter: 'acc-1', phase: 'renewal', ownerId: 'user_ann', viewers: ['member'] },
            'admin',
          )
        ).status,
      ).toBe(200);
    };

    const raced = racingDb(change, 1);

    expect(
      (
        await applyRaw(
          SET_ACCOUNT_PHASE,
          { objectToModifyParameter: 'acc-1', phase: 'closed', ownerId: 'user_ann', viewers: ['reviewer'] },
          'ann',
          { db: raced.db },
        )
      ).status,
    ).toBe(200);

    expect(raced.transactions()).toBe(2);

    const { history } = (await tables()) as { history: { entry: { edit: { previousProperties: unknown } } }[] };

    expect(history.map(({ entry }) => entry.edit.previousProperties)).toEqual([
      expect.objectContaining({ phase: 'customer', viewers: ['reviewer'] }),
      expect.objectContaining({ phase: 'renewal', viewers: ['member'] }),
    ]);
  });
});

const LINK_EDITS = [
  [
    'add-partner',
    'rules',
    () => applyRaw(ADD_PARTNER, { engagement: 'eng-2', account: 'acc-1' }, 'ann', { db: raced?.db }),
  ],
  [
    'remove-partner',
    'rules',
    () => applyRaw(REMOVE_PARTNER, { engagement: 'eng-1', account: 'acc-1' }, 'ann', { db: raced?.db }),
  ],
  [
    'fn-link-partner-by-key',
    'function',
    () =>
      applyRaw(actionOf('linkPartnerByKey'), { engagementId: 'eng-2', accountId: 'acc-1' }, 'ann', { db: raced?.db }),
  ],
  [
    'fn-unlink-partner-by-key',
    'function',
    () =>
      applyRaw(actionOf('unlinkPartnerByKey'), { engagementId: 'eng-1', accountId: 'acc-1' }, 'ann', { db: raced?.db }),
  ],
  [
    'fn-link-from-account-by-key, with acc-1 as the source',
    'function',
    () =>
      applyRaw(actionOf('linkFromAccountByKey'), { engagementId: 'eng-2', accountId: 'acc-1' }, 'ann', {
        db: raced?.db,
      }),
  ],
] as const;

const reown =
  (ownerId: string, phase = 'customer') =>
  async () => {
    expect(
      (
        await applyRaw(
          SET_ACCOUNT_PHASE,
          { objectToModifyParameter: 'acc-1', phase, ownerId, viewers: ['reviewer'] },
          'admin',
        )
      ).status,
    ).toBe(200);
  };

const HIDDEN_RACES = [
  ['a delete and a create for carl', recreate('user_carl')],
  ['a change of the owner to carl', reown('user_carl')],
] as const;

let raced: ReturnType<typeof racingDb> | undefined;
let afterRace: unknown;

async function inRace(race: () => Promise<void>, apply: () => Promise<RawAnswer>, times = 1): Promise<RawAnswer> {
  raced = racingDb(async () => {
    await race();

    afterRace = await tables();
  }, times);

  try {
    return await apply();
  } finally {
    raced = undefined;
  }
}

describe('a Link edit whose Object changes between the load and the lock', () => {
  beforeEach(() =>
    service.db.query(
      sql(
        "INSERT INTO ontology_1_objects.engagement_partners (a_engagement_id, b_account_id) VALUES ('eng-1', 'acc-1')",
      ),
    ),
  );

  describe.each(LINK_EDITS)('%s', (_name, kind, apply) => {
    const refused = kind === 'rules' ? NOT_FOUND : OBJECT_CHANGED;

    it.each(HIDDEN_RACES)(
      `ontology/action-types/action-types#security: after %s, the Link edit writes nothing, and gets the bytes of a deleted Account`,
      async (_race, race) => {
        const hidden = await inRace(race, apply);

        expect(await tables()).toEqual(afterRace);

        expect(parsed(hidden)).toEqual(refused);

        await seed();

        await service.db.query(
          sql(
            "INSERT INTO ontology_1_objects.engagement_partners (a_engagement_id, b_account_id) VALUES ('eng-1', 'acc-1')",
          ),
        );

        const missing = await inRace(recreate(undefined), apply);

        expect(await tables()).toEqual(afterRace);

        expect({ status: hidden.status, text: withoutIds(hidden.text) }).toEqual({
          status: missing.status,
          text: withoutIds(missing.text),
        });
      },
    );

    const basePartners = [
      { a_engagement_id: 'eng-1', b_account_id: 'acc-3' },
      { a_engagement_id: 'eng-2', b_account_id: 'acc-2' },
    ];

    it('ontology/action-types/action-types#security: after a delete only, the Link edit refuses and writes nothing', async () => {
      const answer = await inRace(recreate(undefined), apply);

      expect(parsed(answer)).toEqual(refused);

      const { partners } = (await tables()) as { partners: unknown };

      expect(partners).toEqual(basePartners);

      expect(await tables()).toEqual(afterRace);
    });

    if (kind === 'rules') {
      const added = _name.startsWith('remove') ? [] : [{ a_engagement_id: 'eng-2', b_account_id: 'acc-1' }];

      it('ontology/action-types/action-types#security: after a delete and a create for ann, so acc-1 is visible, the Link edit saves on an Object that its attempt loaded', async () => {
        const answer = await inRace(recreate('user_ann'), apply);

        expect(parsed(answer)).toEqual(expect.objectContaining({ status: 200 }));

        const { partners } = (await tables()) as { partners: unknown };

        expect(partners).toEqual(
          [...basePartners, ...added].sort(
            (x, y) =>
              x.a_engagement_id.localeCompare(y.a_engagement_id) || x.b_account_id.localeCompare(y.b_account_id),
          ),
        );
      });
    } else {
      it('ontology/action-types/action-types#security: after a delete and a create for ann, so acc-1 is visible, the Link edit refuses and writes nothing', async () => {
        const answer = await inRace(recreate('user_ann'), apply);

        expect(parsed(answer)).toEqual(refused);

        const { partners } = (await tables()) as { partners: unknown };

        expect(partners).toEqual(basePartners);

        expect(await tables()).toEqual(afterRace);
      });
    }

    it('ontology/action-types/action-types#security: after a change that keeps acc-1 visible, the Link edit fails the version check', async () => {
      const answer = await inRace(reown('user_ann', 'renewal'), apply, Infinity);

      expect(parsed(answer)).toEqual(OBJECT_CHANGED);

      expect(await tables()).toEqual(afterRace);
    });
  });

  it('ontology/action-types/action-types#security: 2 Link edits of eng-2 and acc-1 at once, from each side, both apply, and store 1 Link', async () => {
    for (let round = 0; round < 10; round += 1) {
      await service.db.query(
        sql(
          "DELETE FROM ontology_1_objects.engagement_partners WHERE a_engagement_id = 'eng-2' AND b_account_id = 'acc-1'",
        ),
      );

      const answers = await Promise.all([
        applyRaw(ADD_PARTNER, { engagement: 'eng-2', account: 'acc-1' }, 'ann'),
        applyRaw(actionOf('linkFromAccountByKey'), { engagementId: 'eng-2', accountId: 'acc-1' }, 'ann'),
        applyRaw(REMOVE_PARTNER, { engagement: 'eng-1', account: 'acc-1' }, 'ann'),
        applyRaw(actionOf('linkPartnerByKey'), { engagementId: 'eng-1', accountId: 'acc-1' }, 'ann'),
      ]);

      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);

      const rows = await service.db.query(
        sql(
          "SELECT count(*)::int AS n FROM ontology_1_objects.engagement_partners WHERE a_engagement_id = 'eng-2' AND b_account_id = 'acc-1'",
        ),
      );

      expect(rows).toEqual([{ n: 1 }]);
    }
  });
});
