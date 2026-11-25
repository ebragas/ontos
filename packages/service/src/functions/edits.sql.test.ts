import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '../publish/publish.test-utils.ts';
import {
  errorAnswer,
  newVersion,
  NS,
  rowsOf,
  seedClient,
  startActions,
  type ActionsService,
} from '../actions/actions.test-utils.ts';
import { actionOf, editsIr, withFunctions, type TestFunction } from './functions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const SPONSORS_API_NAME = 'engagementSponsors';

const input = [{ name: 'accountId', type: 'string' as const }];
const both = { inputs: input, edits: [ACCOUNT, ENGAGEMENT], links: [SPONSORS_API_NAME] };

const FUNCTIONS: TestFunction[] = [
  { apiName: 'editEach', ...both },
  { apiName: 'mergeEdits', ...both },
  { apiName: 'createExisting', ...both },
  { apiName: 'updatePrimaryKey', ...both },
  { apiName: 'editOutside', inputs: input, edits: [ACCOUNT] },
  { apiName: 'linkOutside', inputs: input, edits: [ACCOUNT, ENGAGEMENT] },
  { apiName: 'interfaceEdit', ...both, inputs: [...input, { name: 'kind', type: 'string' }] },
  { apiName: 'unknownKind', ...both },
  { apiName: 'linkOneToMany', inputs: input, edits: [ACCOUNT, ENGAGEMENT], links: ['accountToEngagements'] },
  { apiName: 'linkWrongTarget', ...both },
  { apiName: 'editAfterDelete', ...both },
  { apiName: 'moveEngagement', inputs: input, edits: [ENGAGEMENT] },
];

const SOURCE = `
import { createEditBatch } from '@osdk/functions';

const Account = { type: 'object', apiName: '${ACCOUNT}' };
const Engagement = { type: 'object', apiName: '${ENGAGEMENT}' };
const account = (accountId) => ({ $apiName: '${ACCOUNT}', $primaryKey: accountId });
const engagement = (engagementId) => ({ $apiName: '${ENGAGEMENT}', $primaryKey: engagementId });

export const functions = {
  editEach: async (client) => {
    const batch = createEditBatch(client);
    // The service reads only $apiName and $primaryKey of a reference, and ignores each $ key of the values.
    batch.update({ ...account('acc-1'), $title: 'other', $rid: 'other', name: 'Not a value', phase: 'Not a value' }, { name: 'Acme Corp', $rid: 'ignored' });
    batch.delete(account('acc-2'));
    batch.link(engagement('eng-1'), 'sponsors', account('acc-1'));
    batch.unlink(engagement('eng-2'), 'sponsors', account('acc-3'));
    // A Link from side B gives the same Link as from side A.
    batch.link(account('acc-3'), 'sponsoredEngagements', engagement('eng-3'));
    batch.create(Account, { accountId: 'acc-8', name: 'Umbrella' });
    return batch.getEdits();
  },
  mergeEdits: async (client) => {
    const batch = createEditBatch(client);
    batch.update(account('acc-1'), { name: 'First name' });
    batch.create(Account, { accountId: 'acc-9', name: 'Created' });
    batch.update(account('acc-1'), { phase: 'closed' });
    batch.update(account('acc-1'), { name: 'Last name' });
    batch.update(account('acc-9'), { phase: 'prospect' });
    return batch.getEdits();
  },
  createExisting: async (client) => {
    const batch = createEditBatch(client);
    batch.create(Account, { accountId: 'acc-1', name: 'Duplicate' });
    return batch.getEdits();
  },
  updatePrimaryKey: async (client) => {
    const batch = createEditBatch(client);
    batch.update(account('acc-1'), { accountId: 'acc-99', name: 'Renamed' });
    return batch.getEdits();
  },
  editOutside: async (client) => {
    const batch = createEditBatch(client);
    batch.update(account('acc-1'), { name: 'Inside' });
    batch.update(engagement('eng-1'), { status: 'outside' });
    return batch.getEdits();
  },
  linkOutside: async (client) => {
    const batch = createEditBatch(client);
    batch.link(engagement('eng-1'), 'sponsors', account('acc-1'));
    return batch.getEdits();
  },
  interfaceEdit: async (client, accountId, kind) => [{ type: kind, int: { type: 'interface', apiName: 'Named' }, obj: { $apiName: 'Named', $objectType: '${ACCOUNT}', $primaryKey: 'acc-1' }, properties: { name: 'x' } }],
  unknownKind: async () => [{ type: 'notification', recipients: [], content: {} }],
  linkOneToMany: async (client) => {
    const batch = createEditBatch(client);
    batch.link(account('acc-1'), 'engagements', engagement('eng-4'));
    return batch.getEdits();
  },
  linkWrongTarget: async (client) => {
    const batch = createEditBatch(client);
    batch.link(engagement('eng-1'), 'sponsors', engagement('eng-2'));
    return batch.getEdits();
  },
  editAfterDelete: async (client) => {
    const batch = createEditBatch(client);
    batch.create(Account, { accountId: 'acc-9', name: 'Created' });
    batch.delete(account('acc-9'));
    batch.update(account('acc-9'), { name: 'After the delete' });
    return batch.getEdits();
  },
  moveEngagement: async (client, accountId) => {
    const batch = createEditBatch(client);
    batch.update(engagement('eng-1'), { accountId });
    return batch.getEdits();
  },
};
`;

let service: ActionsService;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(FUNCTIONS, SOURCE, editsIr());

  service = await startActions(ir, functions);
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);

  await service.db.query(
    sql(
      'INSERT INTO ontology_1_objects.engagement_sponsors (a_engagement_id, b_account_id) VALUES ($1, $2)',
      'eng-2',
      'acc-3',
    ),
  );
});

function apply(apiName: string, parameters: Record<string, unknown> = { accountId: 'acc-1' }) {
  return service.apply(actionOf(apiName), {
    parameters,
    options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
  });
}

const ACTION_RID = /^ri\.actions\.main\.action\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function applied(edits: readonly { type: string }[]) {
  const count = (type: string) => edits.filter((edit) => edit.type === type).length;

  return {
    status: 200,
    body: {
      operationId: expect.stringMatching(ACTION_RID),
      validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
      edits: {
        type: 'edits',
        edits,
        addedObjectCount: count('addObject'),
        modifiedObjectsCount: count('modifyObject'),
        deletedObjectsCount: count('deleteObject'),
        addedLinksCount: count('addLink'),
        deletedLinksCount: count('deleteLink'),
      },
    },
  };
}

const objectEdit = (type: string, objectType: string, primaryKey: string) => ({ type, primaryKey, objectType });

const sponsorEdit = (type: 'addLink' | 'deleteLink', engagementId: string, accountId: string) => ({
  type,
  linkTypeApiNameAtoB: 'sponsors',
  linkTypeApiNameBtoA: 'sponsoredEngagements',
  aSideObject: { primaryKey: engagementId, objectType: ENGAGEMENT },
  bSideObject: { primaryKey: accountId, objectType: ACCOUNT },
});

const accounts = () => rowsOf(service.db, ACCOUNT, 'account_id');

const sponsors = async () =>
  (
    await service.db.query<{ a: string; b: string }>(
      sql('SELECT a_engagement_id AS a, b_account_id AS b FROM ontology_1_objects.engagement_sponsors ORDER BY 1, 2'),
    )
  ).map((row) => [row.a, row.b]);

const historyEdits = async () =>
  (
    await service.db.query<{ primary_key: string; entry: { edit: unknown } }>(
      sql('SELECT primary_key, entry FROM ontology_1_engine.edit_history ORDER BY primary_key'),
    )
  ).map((row) => [row.primary_key, row.entry.edit]);

function refused(message: string) {
  return {
    status: 400,
    body: {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'FunctionExecutionFailed',
      parameters: {
        functionRid: expect.stringMatching(/^ri\.function-registry\.main\.function\./),
        functionVersion: '1.0.0',
        message,
      },
    },
  };
}

const START_ACCOUNTS = [
  { __version: '1', account_id: 'acc-1', name: 'Acme', phase: 'customer' },
  { __version: '1', account_id: 'acc-2', name: 'Globex', phase: 'prospect' },
  { __version: '1', account_id: 'acc-3', name: 'Initech', phase: 'customer' },
];

describe('the V1 edit kinds', () => {
  it(
    'ontology/functions/edit-functions#edits, service/code-layout#seams, ' +
      'ontology/functions/edit-functions#edits, ' +
      'ontology/functions/edit-functions#edits, ontology/functions/edit-functions#apply: ' +
      'updateObject, deleteObject, addLink, removeLink, and createObject write as modifyObject, deleteObject, addLink, deleteLink, and addObject',
    async () => {
      expect(await apply('editEach')).toEqual(
        applied([
          objectEdit('modifyObject', ACCOUNT, 'acc-1'),
          objectEdit('deleteObject', ACCOUNT, 'acc-2'),
          sponsorEdit('addLink', 'eng-1', 'acc-1'),
          sponsorEdit('deleteLink', 'eng-2', 'acc-3'),
          sponsorEdit('addLink', 'eng-3', 'acc-3'),
          objectEdit('addObject', ACCOUNT, 'acc-8'),
        ]),
      );

      expect(await accounts()).toEqual([
        { __version: newVersion('1'), account_id: 'acc-1', name: 'Acme Corp', phase: 'customer' },
        { __version: '1', account_id: 'acc-3', name: 'Initech', phase: 'customer' },
        { __version: newVersion(), account_id: 'acc-8', name: 'Umbrella', phase: null },
      ]);

      expect(await sponsors()).toEqual([
        ['eng-1', 'acc-1'],
        ['eng-3', 'acc-3'],
      ]);
    },
  );
});

describe('the edits of 1 Object', () => {
  it(
    'ontology/functions/edit-functions#apply, ontology/object-edits/edit-history#entries: ' +
      'the edits of each Object compile to 1 edit, a later edit of a Property wins, and each Object gets 1 history entry',
    async () => {
      expect(await apply('mergeEdits')).toEqual(
        applied([objectEdit('modifyObject', ACCOUNT, 'acc-1'), objectEdit('addObject', ACCOUNT, 'acc-9')]),
      );

      expect(await accounts()).toEqual([
        { __version: newVersion('1'), account_id: 'acc-1', name: 'Last name', phase: 'closed' },
        START_ACCOUNTS[1],
        START_ACCOUNTS[2],
        { __version: newVersion(), account_id: 'acc-9', name: 'Created', phase: 'prospect' },
      ]);

      expect(await historyEdits()).toEqual([
        [
          'acc-1',
          {
            type: 'modifyEdit',
            properties: { name: 'Last name', phase: 'closed' },
            previousProperties: { name: 'Acme', phase: 'customer' },
            includesAllPreviousValues: false,
          },
        ],
        ['acc-9', { type: 'createEdit', properties: { accountId: 'acc-9', name: 'Created', phase: 'prospect' } }],
      ]);
    },
  );

  it('ontology/object-edits/edit-history#entries: a function-backed Action that updates the foreign key of a one-to-many Link makes a modify of that Property, in the entry of the Object that holds the key', async () => {
    expect(await apply('moveEngagement', { accountId: 'acc-2' })).toEqual(
      applied([objectEdit('modifyObject', ENGAGEMENT, 'eng-1')]),
    );

    expect(await historyEdits()).toEqual([
      [
        'eng-1',
        {
          type: 'modifyEdit',
          properties: { accountId: 'acc-2' },
          previousProperties: { accountId: 'acc-1' },
          includesAllPreviousValues: false,
        },
      ],
    ]);
  });
});

describe('an edit that V1 does not allow', () => {
  it('ontology/functions/edit-functions#apply: a create with the primary key of an existing Object gets 409 ObjectAlreadyExists, and writes nothing', async () => {
    expect(errorAnswer(await apply('createExisting'))).toEqual({
      status: 409,
      body: { errorCode: 'CONFLICT', errorName: 'ObjectAlreadyExists', parameters: {} },
    });

    expect(await accounts()).toEqual(START_ACCOUNTS);
  });

  it('ontology/functions/edit-functions#apply: an update cannot change a primary key, so it keeps the key, as a Modify object rule does', async () => {
    expect(await apply('updatePrimaryKey')).toEqual(applied([objectEdit('modifyObject', ACCOUNT, 'acc-1')]));

    expect(await accounts()).toEqual([
      { __version: newVersion('1'), account_id: 'acc-1', name: 'Renamed', phase: 'customer' },
      START_ACCOUNTS[1],
      START_ACCOUNTS[2],
    ]);
  });

  it('ontology/functions/edit-functions#apply: an edit of an Object Type or a Link Type outside the provenance fails the Action, which writes nothing', async () => {
    expect(errorAnswer(await apply('editOutside'))).toEqual(
      refused(`The Function edits the Object Type ${ENGAGEMENT}, which its Edits type does not name.`),
    );

    expect(errorAnswer(await apply('linkOutside'))).toEqual(
      refused(`The Function edits the Link Type ${SPONSORS_API_NAME}, which its Edits type does not name.`),
    );

    expect(await accounts()).toEqual(START_ACCOUNTS);

    expect(await sponsors()).toEqual([['eng-2', 'acc-3']]);
  });

  it('ontology/functions/edit-functions#edits: a Link edit of a Link Type that is not many-to-many, or with a target of another Object Type, fails the Action', async () => {
    expect(errorAnswer(await apply('linkOneToMany'))).toEqual(
      refused(
        `A addLink edit names the Link engagements of ${ACCOUNT}, which is not a side of a many-to-many Link Type.`,
      ),
    );

    expect(errorAnswer(await apply('linkWrongTarget'))).toEqual(
      refused(`A addLink edit of the Link sponsors names a target of ${ENGAGEMENT}, not of ${ACCOUNT}.`),
    );

    expect(await sponsors()).toEqual([['eng-2', 'acc-3']]);
  });

  it('ontology/functions/edit-functions#apply: an edit of an Object after its create and its delete in 1 run fails the Action', async () => {
    expect(errorAnswer(await apply('editAfterDelete'))).toEqual(
      refused(`The Function edits ${ACCOUNT} acc-9 after it deletes it.`),
    );

    expect(await accounts()).toEqual(START_ACCOUNTS);
  });

  it('ontology/functions/edit-functions#edits: an interface edit fails the Action', async () => {
    for (const kind of ['createObjectForInterface', 'updateObjectForInterface', 'deleteObjectForInterface']) {
      expect(errorAnswer(await apply('interfaceEdit', { accountId: 'acc-1', kind }))).toEqual(
        refused(`The Function returned a ${kind} edit. V1 has no Interfaces.`),
      );
    }

    expect(await accounts()).toEqual(START_ACCOUNTS);
  });

  it('ontology/functions/edit-functions#out-of-scope: an edit of an unknown kind fails the Action', async () => {
    expect(errorAnswer(await apply('unknownKind'))).toEqual(
      refused('The Function returned an edit of the unknown kind notification.'),
    );
  });
});
