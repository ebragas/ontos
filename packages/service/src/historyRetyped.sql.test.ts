import type { OntologyIr, OntologyIrPropertyType } from '@osdk/client.unstable';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { NS, startActions, twinFunctions, type ActionsService } from './actions/actions.test-utils.ts';
import { policiesIr, unchecked, USE } from './ontology/stored.test-utils.ts';
import { groupGrants, policyPeople } from './policiesPeople.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ONTOLOGY = `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}`;
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const ROLES = { admin: ['ontology:install', USE, 'admin'], member: [USE, 'member'], guest: [USE] };

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
    guest: { sub: 'user_guest', role: 'guest' },
  },
  ROLES,
);

const EMPTY = '{"data":[],"totalCount":0}';

function historyIr(change: (ownerId: OntologyIrPropertyType) => void = () => undefined): OntologyIr {
  const ir = policiesIr();
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!account) throw new Error('The policies IR has no Account.');

  account.entityMetadata = unchecked({
    ...account.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  const ownerId = account.objectType.propertyTypes['ownerId'];

  if (!ownerId) throw new Error('The policies IR has no Property ownerId on Account.');

  change(ownerId);

  return ir;
}

const experimental = (ownerId: OntologyIrPropertyType) => {
  ownerId.status = { type: 'experimental', experimental: {} };
};

const stringArray = (ownerId: OntologyIrPropertyType) => {
  experimental(ownerId);

  ownerId.type = { type: 'array', array: { subtype: ownerId.type, reducers: [] } };
};

let service: ActionsService;

beforeAll(async () => {
  const ir = historyIr();

  service = await startActions(ir, twinFunctions('0.6.3'), groupGrants(ir, ROLES));
});

afterAll(() => service?.stop());

async function apply(actionType: string, parameters: object): Promise<void> {
  expect((await service.apply(`${NS}${actionType}`, { parameters, options: EXECUTE }, PEOPLE.admin)).status).toBe(200);
}

it('service/storage#object-edit-history ontology/object-edits/edit-history#security: after ownerId becomes a String array, the delete entries of 2 Accounts hide them from each person, and each answer is 200 with the bytes of no history', async () => {
  for (const [accountId, ownerId] of [
    ['acc-1', 'user_ann'],
    ['acc-2', 'user_guest'],
  ]) {
    await apply('create-account', { accountId, name: accountId, phase: 'customer', ownerId, viewers: ['reviewer'] });

    await apply('delete-account', { objectToDeleteParameter: accountId });
  }

  const before = await service.call('POST', `${ONTOLOGY}/objectTypes/${ACCOUNT}/editsHistory`, {}, PEOPLE.ann);

  expect((JSON.parse(before.text) as { totalCount: number }).totalCount).toBe(2);

  for (const change of [experimental, stringArray]) {
    const ir = historyIr(change);

    await service.publish(ir, twinFunctions('0.6.3'), groupGrants(ir, ROLES));
  }

  for (const person of ['ann', 'admin', 'guest'] as const) {
    for (const body of [
      {},
      { objectPrimaryKey: { accountId: 'acc-1' } },
      { objectPrimaryKey: { accountId: 'acc-none' } },
    ]) {
      const answer = await service.call(
        'POST',
        `${ONTOLOGY}/objectTypes/${ACCOUNT}/editsHistory`,
        body,
        PEOPLE[person],
      );

      expect({ person, body, status: answer.status, text: answer.text }).toEqual({
        person,
        body,
        status: 200,
        text: EMPTY,
      });
    }

    const tool = await service.tool(
      'get_edit_history',
      { objectType: ACCOUNT, objectPrimaryKey: { accountId: 'acc-2' } },
      PEOPLE[person],
    );

    expect({
      person,
      page: (tool.body as { result: { structuredContent: unknown } }).result.structuredContent,
    }).toEqual({ person, page: { data: [], totalCount: 0 } });
  }
});
