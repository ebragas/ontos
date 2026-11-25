import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Edit } from '../actions/index.ts';
import type { Sql } from '../db/index.ts';
import type { Db } from '../db/promise.test-utils.ts';
import { actionOf, ScriptedFunctions, withFunctions } from './functions.test-utils.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { sql } from '../publish/publish.test-utils.ts';
import { routeSpans } from '../routeHarness.test-utils.ts';
import {
  account,
  countingDb,
  deleteRule,
  errorAnswer,
  insertObjects,
  manyToManyLink,
  modifyRule,
  newVersion,
  NS,
  rowsOf,
  startActions,
  staticString,
  twinIr,
  type ActionsService,
  type ObjectRow,
} from '../actions/actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const DELETE_ACCOUNT = `${NS}delete-account`;
const SCRIPTED_ACTION = actionOf('scripted');

const ADD_SPONSOR = `${NS}add-sponsor`;
const ADD_SPONSORED = `${NS}add-sponsored-engagement`;
const REMOVE_SPONSOR = `${NS}remove-sponsor`;
const REMOVE_SPONSORED = `${NS}remove-sponsored-engagement`;
const ADD_PARTNER = `${NS}add-partner`;
const ADD_AND_REMOVE_SPONSOR = `${NS}add-and-remove-sponsor`;
const DELETE_THEN_LINK = `${NS}delete-then-link`;
const MODIFY_LINK_DELETE = `${NS}modify-link-delete`;
const LINK_THEN_DELETE = `${NS}link-then-delete`;
const UNLINK_THEN_DELETE = `${NS}unlink-then-delete`;
const RETITLE_AND_SPONSOR = `${NS}retitle-and-sponsor`;
const REPHASE_AND_SPONSOR = `${NS}rephase-and-sponsor`;
const SPONSOR_AND_REPHASE = `${NS}sponsor-and-rephase`;

type ActionTypeBlock = OntologyIr['ontology']['actionTypes'][string];

const SPONSORS = manyToManyLink(
  'engagement-sponsors',
  { type: ENGAGEMENT, key: 'engagementId', side: 'sponsors' },
  { type: ACCOUNT, key: 'accountId', side: 'sponsoredEngagements' },
);

const PARTNERS = manyToManyLink(
  'account-partners',
  { type: ACCOUNT, key: 'accountId', side: 'partners' },
  { type: ACCOUNT, key: 'accountId', side: 'partnerOf' },
);

const OBJECT_QUERY = { type: 'objectQuery', objectQuery: { type: 'objectQuery', objectQuery: {} } };
const REQUIRED = { type: 'required', required: {} };

function actionType(apiName: string, parameters: Record<string, string>, rules: readonly unknown[]): ActionTypeBlock {
  const block = structuredClone(twinIr('0.6.3').ontology.actionTypes[SET_ENGAGEMENT_STATUS]);

  if (!block) throw new Error('The twin 0.6.3 IR has no set-engagement-status.');

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;
  metadata.parameters = {};
  metadata.parameterOrdering = Object.keys(parameters);

  actionTypeLogic.validation.parameterValidations = {};

  for (const [id, objectTypeId] of Object.entries(parameters)) {
    metadata.parameters[id] = unchecked({
      id,
      type: { type: 'objectReference', objectReference: { objectTypeId } },
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    actionTypeLogic.validation.parameterValidations[id] = unchecked({
      defaultValidation: {
        display: { renderHint: { type: 'textInput', textInput: {} }, visibility: { type: 'editable', editable: {} } },
        validation: { allowedValues: OBJECT_QUERY, required: REQUIRED },
      },
      conditionalOverrides: [],
    });
  }

  actionTypeLogic.logic.rules = unchecked(rules);

  return block;
}

const linkRule = (
  kind: 'addLinkRule' | 'deleteLinkRule',
  linkTypeId: string,
  sourceObject: string,
  targetObject: string,
) => ({
  type: kind,
  [kind]: { linkTypeId, sourceObject, targetObject },
});

function testIr(): OntologyIr {
  const ir = twinIr('0.6.3');

  for (const link of [SPONSORS, PARTNERS]) ir.ontology.linkTypes[link.linkType.id] = link;

  const parameters = { engagement: ENGAGEMENT, account: ACCOUNT };

  const blocks = [
    actionType(ADD_SPONSOR, parameters, [linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account')]),
    actionType(ADD_SPONSORED, parameters, [linkRule('addLinkRule', 'engagement-sponsors', 'account', 'engagement')]),
    actionType(REMOVE_SPONSOR, parameters, [
      linkRule('deleteLinkRule', 'engagement-sponsors', 'engagement', 'account'),
    ]),
    actionType(REMOVE_SPONSORED, parameters, [
      linkRule('deleteLinkRule', 'engagement-sponsors', 'account', 'engagement'),
    ]),
    actionType(ADD_PARTNER, { account: ACCOUNT, partner: ACCOUNT }, [
      linkRule('addLinkRule', 'account-partners', 'account', 'partner'),
    ]),
    actionType(ADD_AND_REMOVE_SPONSOR, { ...parameters, otherEngagement: ENGAGEMENT }, [
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
      linkRule('deleteLinkRule', 'engagement-sponsors', 'otherEngagement', 'account'),
    ]),
    actionType(DELETE_THEN_LINK, parameters, [
      deleteRule('account'),
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
    ]),
    actionType(MODIFY_LINK_DELETE, parameters, [
      modifyRule('account', { phase: staticString('churned') }),
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
      deleteRule('account'),
    ]),
    actionType(LINK_THEN_DELETE, parameters, [
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
      deleteRule('account'),
    ]),
    actionType(UNLINK_THEN_DELETE, parameters, [
      linkRule('deleteLinkRule', 'engagement-sponsors', 'engagement', 'account'),
      deleteRule('account'),
    ]),
    actionType(RETITLE_AND_SPONSOR, parameters, [
      modifyRule('engagement', { title: staticString('Retitled') }),
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
    ]),
    actionType(REPHASE_AND_SPONSOR, parameters, [
      modifyRule('account', { phase: staticString('renewal') }),
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
    ]),
    actionType(SPONSOR_AND_REPHASE, parameters, [
      linkRule('addLinkRule', 'engagement-sponsors', 'engagement', 'account'),
      modifyRule('account', { phase: staticString('renewal') }),
    ]),
  ];

  for (const block of blocks) ir.ontology.actionTypes[block.actionType.metadata.apiName] = block;

  return ir;
}

let service: ActionsService;
let scripted: ScriptedFunctions;

const withScripted = (ir: OntologyIr) =>
  withFunctions(
    [
      {
        apiName: 'scripted',
        inputs: [{ name: 'account', type: 'object', objectType: ACCOUNT }],
        edits: [ACCOUNT, ENGAGEMENT],
        links: ['engagementSponsors'],
      },
    ],
    scripted.source,
    ir,
  );

beforeAll(async () => {
  scripted = new ScriptedFunctions(testIr());

  const { ir, functions } = await withScripted(testIr());

  service = await startActions(ir, functions);
});

afterAll(() => {
  scripted?.close();

  return service?.stop();
});

beforeEach(async () => {
  scripted.reset();

  await service.clear();
});

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID = { result: 'VALID', submissionCriteria: [], parameters: {} };
const EXECUTE_NONE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const EXECUTE_ALL = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL' };
const EXECUTE_ALL_V2 = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };

const applied = (
  edits: unknown[],
  counts: { deletedObjects?: number; addedLinks?: number; deletedLinks?: number },
) => ({
  status: 200,
  body: {
    operationId: expect.stringMatching(ACTION_RID),
    validation: VALID,
    edits: {
      type: 'edits',
      edits,
      addedObjectCount: 0,
      modifiedObjectsCount: 0,
      deletedObjectsCount: counts.deletedObjects ?? 0,
      addedLinksCount: counts.addedLinks ?? 0,
      deletedLinksCount: counts.deletedLinks ?? 0,
    },
  },
});

const sponsorEdit = (type: 'addLink' | 'deleteLink', engagementId: string, accountId: string) => ({
  type,
  linkTypeApiNameAtoB: 'sponsors',
  linkTypeApiNameBtoA: 'sponsoredEngagements',
  aSideObject: { primaryKey: engagementId, objectType: ENGAGEMENT },
  bSideObject: { primaryKey: accountId, objectType: ACCOUNT },
});

const engagement = (engagementId: string, accountId: string, title: string): ObjectRow => ({
  engagementId,
  accountId,
  title,
});

const ACCOUNTS = [
  account('acc-1', 'Acme', 'customer'),
  account('acc-2', 'Globex', 'prospect'),
  account('acc-3', 'Initech', 'customer'),
];

const ENGAGEMENTS = [
  engagement('eng-1', 'acc-1', 'Discovery workshop'),
  engagement('eng-2', 'acc-1', 'Ontology build'),
  engagement('eng-4', 'acc-2', 'Pilot'),
];

async function seed(): Promise<void> {
  await insertObjects(service.db, ACCOUNT, ACCOUNTS);

  await insertObjects(service.db, ENGAGEMENT, ENGAGEMENTS);
}

type Pair = readonly [string, string];

async function insertLinks(table: 'engagement_sponsors' | 'account_partners', pairs: readonly Pair[]): Promise<void> {
  const [a, b] = columnsOf(table);

  for (const [left, right] of pairs)
    await service.db.query(sql(`INSERT INTO ontology_1_objects.${table} (${a}, ${b}) VALUES ($1, $2)`, left, right));
}

async function linksOf(table: 'engagement_sponsors' | 'account_partners'): Promise<Pair[]> {
  const [a, b] = columnsOf(table);

  const rows = await service.db.query<{ a: string; b: string }>(
    sql(`SELECT ${a} AS a, ${b} AS b FROM ontology_1_objects.${table} ORDER BY 1, 2`),
  );

  return rows.map((row) => [row.a, row.b]);
}

function columnsOf(table: 'engagement_sponsors' | 'account_partners'): Pair {
  return table === 'engagement_sponsors' ? ['a_engagement_id', 'b_account_id'] : ['a_account_id', 'b_account_id'];
}

const accountIds = async () => (await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row['account_id']);

const versions = async () => [
  ...(await rowsOf(service.db, ENGAGEMENT, 'engagement_id')).map((row) => [row['engagement_id'], row['__version']]),
  ...(await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => [row['account_id'], row['__version']]),
];

const START_VERSIONS = [
  ['eng-1', '1'],
  ['eng-2', '1'],
  ['eng-4', '1'],
  ['acc-1', '1'],
  ['acc-2', '1'],
  ['acc-3', '1'],
];

describe('a Create link rule', () => {
  const ENG_1_ACC_2 = { parameters: { engagement: 'eng-1', account: 'acc-2' } };

  it('ontology/action-types/rules#rule-kinds: inserts the join table row of the 2 Objects, with the a_ and b_ columns of the Link Type sides, and changes no Object', async () => {
    await seed();

    await insertLinks('engagement_sponsors', [['eng-2', 'acc-1']]);

    const answer = await service.apply(ADD_SPONSOR, { ...ENG_1_ACC_2, options: EXECUTE_NONE });

    expect(answer).toEqual({
      status: 200,
      body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID },
    });

    expect(await linksOf('engagement_sponsors')).toEqual([
      ['eng-1', 'acc-2'],
      ['eng-2', 'acc-1'],
    ]);

    expect(await linksOf('account_partners')).toEqual([]);

    expect(await versions()).toEqual(START_VERSIONS);
  });

  it('ontology/action-types/rules#rule-kinds: a rule from the B side writes the same row, with the Account in the b_ column', async () => {
    await seed();

    const answer = await service.apply(ADD_SPONSORED, { ...ENG_1_ACC_2, options: EXECUTE_NONE });

    expect(answer).toEqual({
      status: 200,
      body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID },
    });

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-2']]);

    expect(await versions()).toEqual(START_VERSIONS);
  });

  it('ontology/action-types/rules#rule-kinds: a rule on a self-link writes the source in the a_ column, and answers with the source as side A', async () => {
    await seed();

    const answer = await service.apply(ADD_PARTNER, {
      parameters: { account: 'acc-3', partner: 'acc-1' },
      options: EXECUTE_ALL,
    });

    expect(answer).toEqual(
      applied(
        [
          {
            type: 'addLink',
            linkTypeApiNameAtoB: 'partners',
            linkTypeApiNameBtoA: 'partnerOf',
            aSideObject: { primaryKey: 'acc-3', objectType: ACCOUNT },
            bSideObject: { primaryKey: 'acc-1', objectType: ACCOUNT },
          },
        ],
        { addedLinks: 1 },
      ),
    );

    expect(await linksOf('account_partners')).toEqual([['acc-3', 'acc-1']]);
  });

  it.each([
    ['ALL', EXECUTE_ALL, ADD_SPONSOR],
    ['ALL_V2_WITH_DELETIONS', EXECUTE_ALL_V2, ADD_SPONSOR],
    ['ALL, from the B side', EXECUTE_ALL, ADD_SPONSORED],
  ])(
    'ontology/action-types/rules#rule-kinds: returnEdits %s lists 1 addLink edit and counts it in addedLinksCount',
    async (_, options, action) => {
      await seed();

      const answer = await service.apply(action, { ...ENG_1_ACC_2, options });

      expect(answer).toEqual(applied([sponsorEdit('addLink', 'eng-1', 'acc-2')], { addedLinks: 1 }));
    },
  );

  it('ontology/action-types/rules#rule-kinds: a Link that exists stays 1 row, and the apply succeeds', async () => {
    await seed();

    await insertLinks('engagement_sponsors', [['eng-1', 'acc-2']]);

    const answer = await service.apply(ADD_SPONSOR, { ...ENG_1_ACC_2, options: EXECUTE_ALL });

    expect(answer).toEqual(applied([sponsorEdit('addLink', 'eng-1', 'acc-2')], { addedLinks: 1 }));

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-2']]);
  });
});

describe('a Create link rule and a Delete link rule in 1 Action', () => {
  it('ontology/action-types/rules#rule-kinds: lists the 2 Link edits in rule order and counts each kind', async () => {
    await seed();

    await insertLinks('engagement_sponsors', [['eng-2', 'acc-2']]);

    const answer = await service.apply(ADD_AND_REMOVE_SPONSOR, {
      parameters: { engagement: 'eng-1', account: 'acc-2', otherEngagement: 'eng-2' },
      options: EXECUTE_ALL,
    });

    expect(answer).toEqual(
      applied([sponsorEdit('addLink', 'eng-1', 'acc-2'), sponsorEdit('deleteLink', 'eng-2', 'acc-2')], {
        addedLinks: 1,
        deletedLinks: 1,
      }),
    );

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-2']]);
  });
});

describe('a Delete link rule', () => {
  const START: Pair[] = [
    ['eng-1', 'acc-1'],
    ['eng-1', 'acc-2'],
    ['eng-2', 'acc-2'],
  ];

  it.each([
    ['the A side', REMOVE_SPONSOR],
    ['the B side', REMOVE_SPONSORED],
  ])(
    'ontology/action-types/rules#rule-kinds: a rule from %s deletes the join table row of the 2 Objects, and keeps the other rows and the Objects',
    async (_, action) => {
      await seed();

      await insertLinks('engagement_sponsors', START);

      const answer = await service.apply(action, {
        parameters: { engagement: 'eng-1', account: 'acc-2' },
        options: EXECUTE_NONE,
      });

      expect(answer).toEqual({
        status: 200,
        body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID },
      });

      expect(await linksOf('engagement_sponsors')).toEqual([
        ['eng-1', 'acc-1'],
        ['eng-2', 'acc-2'],
      ]);

      expect(await versions()).toEqual(START_VERSIONS);
    },
  );

  it.each([
    ['ALL', EXECUTE_ALL],
    ['ALL_V2_WITH_DELETIONS', EXECUTE_ALL_V2],
  ])(
    'ontology/action-types/rules#rule-kinds: returnEdits %s lists 1 deleteLink edit and counts it in deletedLinksCount',
    async (_, options) => {
      await seed();

      await insertLinks('engagement_sponsors', START);

      const answer = await service.apply(REMOVE_SPONSORED, {
        parameters: { engagement: 'eng-1', account: 'acc-2' },
        options,
      });

      expect(answer).toEqual(applied([sponsorEdit('deleteLink', 'eng-1', 'acc-2')], { deletedLinks: 1 }));
    },
  );

  it('ontology/action-types/rules#rule-kinds: a Link that does not exist deletes no row, and the apply succeeds', async () => {
    await seed();

    await insertLinks('engagement_sponsors', START);

    const answer = await service.apply(REMOVE_SPONSOR, {
      parameters: { engagement: 'eng-4', account: 'acc-1' },
      options: EXECUTE_ALL,
    });

    expect(answer).toEqual(applied([sponsorEdit('deleteLink', 'eng-4', 'acc-1')], { deletedLinks: 1 }));

    expect(await linksOf('engagement_sponsors')).toEqual(START);
  });
});

describe('the delete of an Object with Links', () => {
  const SPONSOR_LINKS: Pair[] = [
    ['eng-1', 'acc-1'],
    ['eng-1', 'acc-2'],
    ['eng-2', 'acc-1'],
    ['eng-4', 'acc-2'],
  ];

  const PARTNER_LINKS: Pair[] = [
    ['acc-1', 'acc-2'],
    ['acc-1', 'acc-3'],
    ['acc-2', 'acc-3'],
    ['acc-3', 'acc-1'],
  ];

  const DELETE_ACC_1 = { parameters: { objectToDeleteParameter: 'acc-1' }, options: EXECUTE_ALL_V2 };

  it('service/storage#links: deletes the join table rows of the deleted Object in each Link Type and in each column, and keeps the other rows', async () => {
    await seed();

    await insertLinks('engagement_sponsors', SPONSOR_LINKS);

    await insertLinks('account_partners', PARTNER_LINKS);

    const answer = await service.apply(DELETE_ACCOUNT, DELETE_ACC_1);

    expect(answer).toEqual(
      applied([{ type: 'deleteObject', primaryKey: 'acc-1', objectType: ACCOUNT }], { deletedObjects: 1 }),
    );

    expect(await accountIds()).toEqual(['acc-2', 'acc-3']);

    expect(await linksOf('engagement_sponsors')).toEqual([
      ['eng-1', 'acc-2'],
      ['eng-4', 'acc-2'],
    ]);

    expect(await linksOf('account_partners')).toEqual([['acc-2', 'acc-3']]);
  });

  it('service/storage#links: deletes the join table rows in the write transaction of the delete, so a failed commit keeps them', async () => {
    await seed();

    await insertLinks('engagement_sponsors', SPONSOR_LINKS);

    await insertLinks('account_partners', PARTNER_LINKS);

    const failing = countingDb(service.db, true);

    const failed = await service.apply(DELETE_ACCOUNT, DELETE_ACC_1, { db: failing.db });

    expect(errorAnswer(failed)).toEqual({
      status: 500,
      body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
    });

    expect(failing.transactions()).toBe(1);

    expect(await accountIds()).toEqual(['acc-1', 'acc-2', 'acc-3']);

    expect(await linksOf('engagement_sponsors')).toEqual(SPONSOR_LINKS);

    expect(await linksOf('account_partners')).toEqual(PARTNER_LINKS);
  });
});

describe('a Link rule on an Object that the same Action deletes', () => {
  const REFUSED = {
    status: 400,
    body: { errorCode: 'INVALID_ARGUMENT', errorName: 'ApplyActionFailed', parameters: {} },
  };

  const ENG_1_ACC_1 = { parameters: { engagement: 'eng-1', account: 'acc-1' }, options: EXECUTE_NONE };

  const DELETED_ACC_1 = applied([{ type: 'deleteObject', primaryKey: 'acc-1', objectType: ACCOUNT }], {
    deletedObjects: 1,
  });

  it('ontology/action-types/rules#compile, service/storage#links: refuses a delete, then a Link rule to the deleted Object, and writes nothing', async () => {
    await seed();

    const answer = await service.apply(DELETE_THEN_LINK, ENG_1_ACC_1);

    expect(errorAnswer(answer)).toEqual(REFUSED);

    expect(await accountIds()).toEqual(['acc-1', 'acc-2', 'acc-3']);

    expect(await linksOf('engagement_sponsors')).toEqual([]);

    expect(await versions()).toEqual(START_VERSIONS);
  });

  it.each([
    ['a Create link rule, then a delete of the linked Object', LINK_THEN_DELETE],
    ['a modify, a Create link rule, then a delete of the linked Object', MODIFY_LINK_DELETE],
  ])(
    'ontology/action-types/rules#compile, service/storage#links: applies %s: the delete wins, and no join table row stays',
    async (_, action) => {
      await seed();

      const answer = await service.apply(action, { ...ENG_1_ACC_1, options: EXECUTE_ALL_V2 });

      expect(answer).toEqual(DELETED_ACC_1);

      expect(await accountIds()).toEqual(['acc-2', 'acc-3']);

      expect(await linksOf('engagement_sponsors')).toEqual([]);
    },
  );

  it('ontology/action-types/rules#compile, service/storage#links: applies a Delete link rule, then a delete of the linked Object, and the delete removes each join table row of the Object', async () => {
    await seed();

    await insertLinks('engagement_sponsors', [
      ['eng-1', 'acc-1'],
      ['eng-2', 'acc-1'],
      ['eng-4', 'acc-2'],
    ]);

    const answer = await service.apply(UNLINK_THEN_DELETE, { ...ENG_1_ACC_1, options: EXECUTE_ALL_V2 });

    expect(answer).toEqual(DELETED_ACC_1);

    expect(await accountIds()).toEqual(['acc-2', 'acc-3']);

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-4', 'acc-2']]);
  });

  const DELETE_ACC_1: Edit = { type: 'deleteObject', object: { objectType: ACCOUNT, primaryKey: 'acc-1' } };

  const LINK_ENG_1_ACC_1: Edit = {
    type: 'addLink',
    link: 'sponsors',
    source: { objectType: ENGAGEMENT, primaryKey: 'eng-1' },
    target: { objectType: ACCOUNT, primaryKey: 'acc-1' },
  };

  it('ontology/action-types/rules#compile, service/storage#links: refuses the Function edits a delete, then a Link edit to the deleted Object, as it refuses the same rules', async () => {
    await seed();

    scripted.once(() => [DELETE_ACC_1, LINK_ENG_1_ACC_1]);

    const answer = await service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE });

    expect(errorAnswer(answer)).toEqual(REFUSED);

    expect(await accountIds()).toEqual(['acc-1', 'acc-2', 'acc-3']);

    expect(await linksOf('engagement_sponsors')).toEqual([]);

    expect(await versions()).toEqual(START_VERSIONS);
  });

  it('ontology/action-types/rules#compile, service/storage#links: applies the Function edits a Link edit, then a delete of the linked Object, as it applies the same rules', async () => {
    await seed();

    scripted.once(() => [LINK_ENG_1_ACC_1, DELETE_ACC_1]);

    const answer = await service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_ALL_V2 });

    expect(answer).toEqual(DELETED_ACC_1);

    expect(await accountIds()).toEqual(['acc-2', 'acc-3']);

    expect(await linksOf('engagement_sponsors')).toEqual([]);
  });
});

describe('a Function Link edit on an Object that does not exist', () => {
  const NOT_FOUND = {
    status: 404,
    body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
  };

  const link = (type: 'addLink' | 'deleteLink', engagementId: string, accountId: string): Edit => ({
    type,
    link: 'sponsors',
    source: { objectType: ENGAGEMENT, primaryKey: engagementId },
    target: { objectType: ACCOUNT, primaryKey: accountId },
  });

  it.each([
    ['addLink', 'a missing target', link('addLink', 'eng-1', 'acc-missing')],
    ['addLink', 'a missing source', link('addLink', 'eng-missing', 'acc-1')],
    ['deleteLink', 'a missing target', link('deleteLink', 'eng-1', 'acc-missing')],
  ] as const)(
    'ontology/functions/edit-functions#apply: refuses %s to %s with 404 ObjectNotFound, and writes nothing',
    async (_, __, edit) => {
      await seed();

      await insertLinks('engagement_sponsors', [['eng-1', 'acc-1']]);

      scripted.once(() => [edit]);

      const answer = await service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE });

      expect(errorAnswer(answer)).toEqual(NOT_FOUND);

      expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-1']]);

      expect(await versions()).toEqual(START_VERSIONS);
    },
  );

  it('ontology/functions/edit-functions#apply: applies a Link edit to an Object that a create of the same Function makes', async () => {
    await seed();

    scripted.once(() => [
      {
        type: 'addObject',
        object: { objectType: ACCOUNT, primaryKey: 'acc-new' },
        properties: new Map([['name', 'New']]),
      },
      link('addLink', 'eng-1', 'acc-new'),
    ]);

    const answer = await service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE });

    expect(answer).toEqual({
      status: 200,
      body: { operationId: expect.stringMatching(ACTION_RID), validation: VALID },
    });

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-new']]);
  });

  it('service/observability#traces: a Function apply holds apply.object_edits with its Object edits, and no Link edit and no delete of an Object that the run did not see, 0 with only a Link edit; VALIDATE_ONLY holds none', async () => {
    await seed();

    const edits: Edit[] = [
      {
        type: 'addObject',
        object: { objectType: ACCOUNT, primaryKey: 'acc-new' },
        properties: new Map([['name', 'New']]),
      },
      {
        type: 'modifyObject',
        object: { objectType: ACCOUNT, primaryKey: 'acc-2' },
        properties: new Map([['name', 'Renamed']]),
      },
      link('addLink', 'eng-1', 'acc-new'),
      { type: 'deleteObject', object: { objectType: ACCOUNT, primaryKey: 'acc-unseen' } },
    ];

    scripted.always(() => edits);

    const parameters = { account: 'acc-1' };

    expect(await service.apply(SCRIPTED_ACTION, { parameters, options: { mode: 'VALIDATE_ONLY' } })).toMatchObject({
      status: 200,
    });

    expect(await service.apply(SCRIPTED_ACTION, { parameters, options: EXECUTE_NONE })).toMatchObject({ status: 200 });

    scripted.always(() => [link('addLink', 'eng-2', 'acc-2')]);

    expect(await service.apply(SCRIPTED_ACTION, { parameters, options: EXECUTE_NONE })).toMatchObject({ status: 200 });

    const counts = (await routeSpans())
      .filter((span) => span.name === 'apply attempt')
      .map((span) => span.attributes['apply.object_edits']);

    expect(counts).toEqual([undefined, 2, 0]);
  });
});

describe('a Link edit and a delete of its Object in each order of their statements', () => {
  const DELETE_ACC_1 = { parameters: { objectToDeleteParameter: 'acc-1' }, options: EXECUTE_ALL_V2 };

  const LINK: Edit = {
    type: 'addLink',
    link: 'sponsors',
    source: { objectType: ENGAGEMENT, primaryKey: 'eng-1' },
    target: { objectType: ACCOUNT, primaryKey: 'acc-1' },
  };

  const ORPHANS = sql(
    `SELECT s.a_engagement_id AS a, s.b_account_id AS b FROM ontology_1_objects.engagement_sponsors s
     WHERE NOT EXISTS (SELECT 1 FROM ontology_1_objects.account o WHERE o.account_id = s.b_account_id)
        OR NOT EXISTS (SELECT 1 FROM ontology_1_objects.engagement o WHERE o.engagement_id = s.a_engagement_id)`,
  );

  const CASES: readonly (readonly [order: string, functionBacked: number, ruleBacked: number])[] = [
    ['a1 a2 a3 b1 b2 b3', 200, 200],
    ['a1 a2 b1 a3 b2 b3', 200, 200],
    ['a1 a2 b1 b2 a3 b3', 200, 200],
    ['a1 a2 b1 b2 b3 a3', 200, 200],
    ['a1 b1 a2 a3 b2 b3', 409, 404],
    ['a1 b1 a2 b2 a3 b3', 409, 404],
    ['a1 b1 a2 b2 b3 a3', 409, 404],
    ['a1 b1 b2 a2 a3 b3', 409, 404],
    ['a1 b1 b2 a2 b3 a3', 409, 404],
    ['a1 b1 b2 b3 a2 a3', 409, 404],
    ['b1 a1 a2 a3 b2 b3', 409, 404],
    ['b1 a1 a2 b2 a3 b3', 409, 404],
    ['b1 a1 a2 b2 b3 a3', 409, 404],
    ['b1 a1 b2 a2 a3 b3', 409, 404],
    ['b1 a1 b2 a2 b3 a3', 409, 404],
    ['b1 a1 b2 b3 a2 a3', 409, 404],
    ['b1 b2 a1 a2 a3 b3', 409, 404],
    ['b1 b2 a1 a2 b3 a3', 409, 404],
    ['b1 b2 a1 b3 a2 a3', 409, 404],
    ['b1 b2 b3 a1 a2 a3', 404, 404],
  ];

  class Party {
    state: 'idle' | 'stopped' | 'running' | 'done' = 'idle';
    private release: (() => void) | undefined;

    stop(): Promise<void> {
      this.state = 'stopped';

      return new Promise((resolve) => {
        this.release = () => {
          this.state = 'running';

          resolve();
        };
      });
    }

    open(): void {
      const release = this.release;

      this.release = undefined;

      release?.();
    }

    start(apply: () => Promise<{ readonly status: number }>): Promise<number> {
      this.state = 'running';

      return apply()
        .then((answer) => answer.status)
        .finally(() => {
          this.state = 'done';
        });
    }
  }

  function stoppingDb(party: Party, role: 'A' | 'B'): Db {
    const db = service.db;

    const stopsAfter = (query: Sql) =>
      role === 'B' &&
      (query.text.includes('FOR UPDATE') || (query.text.startsWith('WITH') && query.text.includes('DELETE FROM')));

    return {
      query: <Row extends object>(query: Sql) => db.query<Row>(query),
      stream: <Row extends object>(query: Sql) => db.stream<Row>(query),
      snapshot: (run) => db.snapshot(run),
      transaction: async (run) => {
        if (role === 'A') await party.stop();

        return db.transaction(async (tx) => {
          const result = await run({
            query: async <Row extends object>(query: Sql) => {
              const rows = await tx.query<Row>(query);

              if (stopsAfter(query)) await party.stop();

              return rows;
            },
            stream: <Row extends object>(query: Sql) => tx.stream<Row>(query),
            snapshot: (inner) => tx.snapshot(inner),
            transaction: (inner) => tx.transaction(inner),
          });

          if (role === 'A') await party.stop();

          return result;
        });
      },
    };
  }

  async function settle(parties: readonly Party[]): Promise<void> {
    const waiting = sql(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );

    for (let calm = 0; calm < 3;) {
      await new Promise((resolve) => setTimeout(resolve, 15));

      const running = parties.filter((party) => party.state === 'running').length;

      const [row] = await service.db.query<{ n: number }>(waiting);

      calm = running === row?.n ? calm + 1 : 0;
    }
  }

  async function accountIds(): Promise<string[]> {
    return (
      await service.db.query<{ id: string }>(sql('SELECT account_id AS id FROM ontology_1_objects.account ORDER BY 1'))
    ).map((row) => row.id);
  }

  const RULE_IDS = { function: 'ontology/functions/edit-functions#apply', rules: 'service/storage#writes' } as const;

  for (const kind of ['function', 'rules'] as const) {
    it.each(CASES)(
      `${RULE_IDS[kind]}: a ${kind}-backed Link edit and a delete in the order %s leave no Link to a deleted Object`,
      async (order, functionBacked, ruleBacked) => {
        await seed();

        scripted.always(() => [LINK]);

        const a = new Party();
        const b = new Party();

        const applyA = () =>
          kind === 'function'
            ? service.apply(
                SCRIPTED_ACTION,
                { parameters: { account: 'acc-2' }, options: EXECUTE_NONE },
                { db: stoppingDb(a, 'A') },
              )
            : service.apply(
                ADD_SPONSOR,
                { parameters: { engagement: 'eng-1', account: 'acc-1' }, options: EXECUTE_NONE },
                { db: stoppingDb(a, 'A') },
              );

        let statusA: Promise<number> | undefined;
        let statusB: Promise<number> | undefined;

        for (const step of order.split(' ')) {
          if (step === 'a1') statusA = a.start(applyA);
          else if (step === 'b1')
            statusB = b.start(() => service.apply(DELETE_ACCOUNT, DELETE_ACC_1, { db: stoppingDb(b, 'B') }));
          else (step.startsWith('a') ? a : b).open();

          await settle([a, b]);
        }

        while (a.state !== 'done' || b.state !== 'done') {
          (a.state === 'stopped' ? a : b).open();

          await settle([a, b]);
        }

        expect({ a: await statusA, b: await statusB, accounts: await accountIds() }).toEqual({
          a: kind === 'function' ? functionBacked : ruleBacked,
          b: 200,
          accounts: ['acc-2', 'acc-3'],
        });

        expect(await service.db.query(ORPHANS)).toEqual([]);
      },
    );
  }

  it('service/storage#writes: the write also locks the source Object, so a delete of it before the write fails the Link', async () => {
    await seed();

    scripted.always(() => [{ type: 'deleteObject', object: { objectType: ENGAGEMENT, primaryKey: 'eng-1' } }]);

    let deleted: number | undefined;

    const db: Db = {
      query: <Row extends object>(query: Sql) => service.db.query<Row>(query),
      stream: <Row extends object>(query: Sql) => service.db.stream<Row>(query),
      snapshot: (run) => service.db.snapshot(run),
      transaction: async (run) => {
        deleted ??= (await service.apply(SCRIPTED_ACTION, { parameters: { account: 'acc-1' }, options: EXECUTE_NONE }))
          .status;

        return service.db.transaction(run);
      },
    };

    const answer = await service.apply(
      ADD_SPONSOR,
      { parameters: { engagement: 'eng-1', account: 'acc-1' }, options: EXECUTE_NONE },
      { db },
    );

    expect({ deleted, linked: answer.status }).toEqual({ deleted: 200, linked: 404 });

    expect(await service.db.query(ORPHANS)).toEqual([]);
  });
});

describe('the writes of a join table', () => {
  it('ontology/object-link-types/link-types#backing-kinds: only the apply route writes a Link: a publish creates a join table with no row and keeps the rows of the others, and the apply adds the Link', async () => {
    await seed();

    await insertLinks('engagement_sponsors', [['eng-1', 'acc-1']]);

    const { ir: next, functions } = await withScripted(testIr());

    const reviewers = manyToManyLink(
      'engagement-reviewers',
      { type: ENGAGEMENT, key: 'engagementId', side: 'reviewers' },
      { type: ACCOUNT, key: 'accountId', side: 'reviewedEngagements' },
    );

    next.ontology.linkTypes[reviewers.linkType.id] = reviewers;

    await service.publish(next, functions);

    const reviewerRows = await service.db.query(sql('SELECT * FROM ontology_1_objects.engagement_reviewers'));

    expect(reviewerRows).toEqual([]);

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-1']]);

    await service.apply(ADD_SPONSOR, { parameters: { engagement: 'eng-2', account: 'acc-3' }, options: EXECUTE_NONE });

    expect(await linksOf('engagement_sponsors')).toEqual([
      ['eng-1', 'acc-1'],
      ['eng-2', 'acc-3'],
    ]);
  });
});

const RULE = 'service/storage#writes';
const SPONSOR_1 = { parameters: { engagement: 'eng-1', account: 'acc-1' }, options: EXECUTE_NONE };
const OBJECT_CHANGED = { status: 409, body: { errorCode: 'CONFLICT', errorName: 'ObjectChanged', parameters: {} } };

function lockingDb(
  before: () => Promise<unknown>,
  times = 1,
): { readonly db: Db; readonly locks: Sql[]; readonly transactions: () => number } {
  const locks: Sql[] = [];
  let transactions = 0;

  const db: Db = {
    query: <Row extends object>(query: Sql) => service.db.query<Row>(query),
    stream: <Row extends object>(query: Sql) => service.db.stream<Row>(query),
    snapshot: (run) => service.db.snapshot(run),
    transaction: async (run) => {
      transactions += 1;

      if (transactions <= times) await before();

      return service.db.transaction((tx) =>
        run({
          query: <Row extends object>(query: Sql) => {
            if (/ FOR (UPDATE|KEY SHARE)$/.test(query.text)) locks.push(query);

            return tx.query<Row>(query);
          },
          stream: <Row extends object>(query: Sql) => tx.stream<Row>(query),
          snapshot: (inner) => tx.snapshot(inner),
          transaction: (inner) => tx.transaction(inner),
        }),
      );
    },
  };

  return { db, locks, transactions: () => transactions };
}

const changeAcc1 = () =>
  service.db.query(
    sql("UPDATE ontology_1_objects.account SET name = 'Acme 2', __version = __version + 1 WHERE account_id = 'acc-1'"),
  );

describe('the lock of each end of a Link edit', () => {
  beforeEach(seed);

  it('locks a later modified Link end once with FOR UPDATE and the other end with FOR KEY SHARE, in Object Type order', async () => {
    const watched = lockingDb(() => Promise.resolve());

    expect((await service.apply(SPONSOR_AND_REPHASE, SPONSOR_1, { db: watched.db })).status).toBe(200);

    expect(
      watched.locks.map((lock) => [
        lock.text.match(/FROM (\S+)/)?.[1],
        lock.text.match(/FOR (UPDATE|KEY SHARE)$/)?.[1],
        lock.values,
      ]),
    ).toEqual([
      ['"ontology_1_objects"."account"', 'UPDATE', [['acc-1'], ['1']]],
      ['"ontology_1_objects"."engagement"', 'KEY SHARE', [['eng-1'], ['1']]],
    ]);

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-1']]);

    expect(
      await service.db.query(sql("SELECT phase FROM ontology_1_objects.account WHERE account_id = 'acc-1'")),
    ).toEqual([{ phase: 'renewal' }]);
  });

  it(`${RULE}: an add and a delete of a Link lock both ends with the version of the load, and a Function create is not locked`, async () => {
    const add = lockingDb(() => Promise.resolve());

    expect((await service.apply(ADD_SPONSOR, SPONSOR_1, { db: add.db })).status).toBe(200);

    const remove = lockingDb(() => Promise.resolve());

    expect((await service.apply(REMOVE_SPONSOR, SPONSOR_1, { db: remove.db })).status).toBe(200);

    for (const { locks } of [add, remove]) {
      expect(
        locks.map((lock) => [
          lock.text.replace(
            /^SELECT 1 AS linked FROM (\S+) AS o JOIN unnest\(\$1::text\[\], \$2::bigint\[\]\) WITH ORDINALITY AS u\(__pk, __ver, __ord\) ON o\.(\S+) = u\.__pk AND o\."__version" = u\.__ver ORDER BY u\.__ord FOR KEY SHARE$/,
            '$1 $2',
          ),
          lock.values,
        ]),
      ).toEqual([
        ['"ontology_1_objects"."account" "account_id"', [['acc-1'], ['1']]],
        ['"ontology_1_objects"."engagement" "engagement_id"', [['eng-1'], ['1']]],
      ]);
    }

    scripted.always(() => [
      {
        type: 'addObject',
        object: { objectType: ACCOUNT, primaryKey: 'acc-9' },
        properties: new Map([['name', 'Wayne']]),
      },
      {
        type: 'addLink',
        link: 'sponsors',
        source: { objectType: ENGAGEMENT, primaryKey: 'eng-1' },
        target: { objectType: ACCOUNT, primaryKey: 'acc-9' },
      },
    ]);

    const created = lockingDb(() => Promise.resolve());

    expect(
      (
        await service.apply(
          SCRIPTED_ACTION,
          { parameters: { account: 'acc-1' }, options: EXECUTE_NONE },
          { db: created.db },
        )
      ).status,
    ).toBe(200);

    expect(created.locks.map((lock) => lock.values)).toEqual([[['eng-1'], ['1']]]);

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-9']]);
  });

  it.each([
    ['an add', ADD_SPONSOR, [], [['eng-1', 'acc-1']]],
    ['a delete', REMOVE_SPONSOR, [['eng-1', 'acc-1']], []],
  ] as const)(
    `${RULE}: a change of an end before the lock fails the version check of %s of a Link: a rule-backed Action runs again with the new version`,
    async (_edit, action, before, after) => {
      await insertLinks('engagement_sponsors', before);

      const raced = lockingDb(changeAcc1);

      expect((await service.apply(action, SPONSOR_1, { db: raced.db })).status).toBe(200);

      expect(raced.transactions()).toBe(2);

      expect(raced.locks.map((lock) => lock.values)).toEqual([
        [['acc-1'], ['1']],
        [['acc-1'], [newVersion('1')]],
        [['eng-1'], ['1']],
      ]);

      expect(await linksOf('engagement_sponsors')).toEqual(after);
    },
  );

  it.each([
    ['an add', 'addLink', [], []],
    ['a delete', 'deleteLink', [['eng-1', 'acc-1']], [['eng-1', 'acc-1']]],
  ] as const)(
    `${RULE}: a change of an end before the lock fails %s of a Link by a Function with 409 ObjectChanged, and writes nothing`,
    async (_edit, type, before, after) => {
      await insertLinks('engagement_sponsors', before);

      scripted.always(
        () =>
          [
            {
              type,
              link: 'sponsors',
              source: { objectType: ENGAGEMENT, primaryKey: 'eng-1' },
              target: { objectType: ACCOUNT, primaryKey: 'acc-1' },
            },
          ] satisfies Edit[],
      );

      const raced = lockingDb(changeAcc1);

      expect(
        errorAnswer(
          await service.apply(
            SCRIPTED_ACTION,
            { parameters: { account: 'acc-1' }, options: EXECUTE_NONE },
            { db: raced.db },
          ),
        ),
      ).toEqual(OBJECT_CHANGED);

      expect(raced.transactions()).toBe(1);

      expect(await linksOf('engagement_sponsors')).toEqual(after);
    },
  );

  it(`${RULE}: a modify of a locked end waits until the Link commits, and then applies`, async () => {
    const waiting = sql(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );

    let modify: Promise<{ status: number }> | undefined;
    let waited = 0;

    const db: Db = {
      ...service.db,
      query: <Row extends object>(query: Sql) => service.db.query<Row>(query),
      transaction: (run) =>
        service.db.transaction((tx) =>
          run({
            ...tx,
            query: async <Row extends object>(query: Sql) => {
              const rows = await tx.query<Row>(query);

              if (query.text.startsWith('INSERT INTO "ontology_1_objects"."engagement_sponsors"')) {
                modify = service.apply(SET_ENGAGEMENT_STATUS, {
                  parameters: { objectToModifyParameter: 'eng-1', status: 'won' },
                  options: EXECUTE_NONE,
                });

                for (let tries = 0; waited === 0 && tries < 200; tries += 1) {
                  await new Promise((resolve) => setTimeout(resolve, 10));

                  waited = (await service.db.query<{ n: number }>(waiting))[0]?.n ?? 0;
                }
              }

              return rows;
            },
          }),
        ),
    };

    expect((await service.apply(ADD_SPONSOR, SPONSOR_1, { db })).status).toBe(200);

    expect(waited).toBe(1);

    expect((await modify)?.status).toBe(200);

    const [eng1] = await service.db.query(
      sql("SELECT status FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-1'"),
    );

    expect({ eng1, links: await linksOf('engagement_sponsors') }).toEqual({
      eng1: { status: 'won' },
      links: [['eng-1', 'acc-1']],
    });
  });
});

describe('a Link edit and another Link edit of the same Object', () => {
  beforeEach(seed);

  it(`${RULE}: a Link edit of acc-1 applies while another Link edit of acc-1 holds its lock`, async () => {
    let inner: { status: number } | undefined;

    const db: Db = {
      ...service.db,
      query: <Row extends object>(query: Sql) => service.db.query<Row>(query),
      transaction: (run) =>
        service.db.transaction((tx) =>
          run({
            ...tx,
            query: async <Row extends object>(query: Sql) => {
              const rows = await tx.query<Row>(query);

              if (
                inner === undefined &&
                query.text.startsWith('INSERT INTO "ontology_1_objects"."engagement_sponsors"')
              ) {
                inner = await service.apply(ADD_SPONSOR, {
                  parameters: { engagement: 'eng-2', account: 'acc-1' },
                  options: EXECUTE_NONE,
                });
              }

              return rows;
            },
          }),
        ),
    };

    expect((await service.apply(ADD_SPONSOR, SPONSOR_1, { db })).status).toBe(200);

    expect(inner?.status).toBe(200);

    expect(await linksOf('engagement_sponsors')).toEqual([
      ['eng-1', 'acc-1'],
      ['eng-2', 'acc-1'],
    ]);
  });
});

describe('Link edits under contention', () => {
  function watchedDb(stats: { transactions: number; deadlocks: number }, pause = 0): Db {
    return {
      query: <Row extends object>(query: Sql) => service.db.query<Row>(query),
      stream: <Row extends object>(query: Sql) => service.db.stream<Row>(query),
      snapshot: (run) => service.db.snapshot(run),
      transaction: async (run) => {
        stats.transactions += 1;

        try {
          return await service.db.transaction((tx) =>
            run({
              ...tx,
              query: async <Row extends object>(query: Sql) => {
                const rows = await tx.query<Row>(query);

                if (pause > 0 && / FOR (UPDATE|KEY SHARE)$/.test(query.text))
                  await new Promise((resolve) => setTimeout(resolve, pause));

                return rows;
              },
            }),
          );
        } catch (error) {
          if ((error as { code?: unknown }).code === '40P01') stats.deadlocks += 1;

          throw error;
        }
      },
    };
  }

  it(`${RULE}: 10 rule-backed Actions at once add 10 Links to acc-1, each in its first attempt`, async () => {
    await seed();

    const keys = Array.from({ length: 10 }, (_, index) => `eng-c${index}`);

    await insertObjects(
      service.db,
      ENGAGEMENT,
      keys.map((key) => engagement(key, 'acc-1', key)),
    );

    const stats = keys.map(() => ({ transactions: 0, deadlocks: 0 }));

    const answers = await Promise.all(
      keys.map((key, index) =>
        service.apply(
          ADD_SPONSOR,
          { parameters: { engagement: key, account: 'acc-1' }, options: EXECUTE_NONE },
          { db: watchedDb(stats[index] ?? { transactions: 0, deadlocks: 0 }) },
        ),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual(keys.map(() => 200));

    expect(await linksOf('engagement_sponsors')).toEqual(keys.map((key) => [key, 'acc-1']));

    expect(stats).toEqual(keys.map(() => ({ transactions: 1, deadlocks: 0 })));
  });

  it(`${RULE}: 2 Actions that each modify 1 of eng-1 and acc-1 and link the other never deadlock, in 20 rounds`, async () => {
    const totals = { transactions: 0, deadlocks: 0, worst: 0 };

    for (let round = 0; round < 20; round += 1) {
      await service.clear();

      await seed();

      const [a, b] = [
        { transactions: 0, deadlocks: 0 },
        { transactions: 0, deadlocks: 0 },
      ];

      const answers = await Promise.all([
        service.apply(RETITLE_AND_SPONSOR, SPONSOR_1, { db: watchedDb(a, 20) }),
        service.apply(REPHASE_AND_SPONSOR, SPONSOR_1, { db: watchedDb(b, 20) }),
      ]);

      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);

      totals.transactions += a.transactions + b.transactions;
      totals.deadlocks += a.deadlocks + b.deadlocks;
      totals.worst = Math.max(totals.worst, a.transactions, b.transactions);
    }

    expect(totals.deadlocks).toBe(0);
    expect(totals.worst).toBeLessThanOrEqual(2);

    expect(await linksOf('engagement_sponsors')).toEqual([['eng-1', 'acc-1']]);

    expect(totals.transactions).toBe(60);
  });
});
