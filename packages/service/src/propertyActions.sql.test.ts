import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertObjects, NS, startActions, type ActionsService } from './actions/actions.test-utils.ts';
import { propertyPoliciesIr, unchecked } from './ontology/stored.test-utils.ts';
import { groupGrants, policyPeople, PROPERTY_ROLES } from './policiesPeople.test-utils.ts';
import { sql } from './publish/publish.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const CHECK = `${NS}check-account-phase`;
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
  },
  PROPERTY_ROLES,
);

type Person = keyof typeof PEOPLE;

const FAILURE = 'The Account must be a customer.';

function testIr(): OntologyIr {
  const ir = propertyPoliciesIr();
  const account = ir.ontology.objectTypes[ACCOUNT];

  if (!account) throw new Error('property-policies.json has no Account.');

  account.entityMetadata = unchecked({
    ...account.entityMetadata,
    editsHistory: { type: 'config', config: { store: ACCOUNT, storeAllPreviousProperties: true } },
  });

  const check = structuredClone(ir.ontology.actionTypes[`${NS}copy-account-phase`]);

  if (!check) throw new Error('property-policies.json has no copy-account-phase.');

  check.actionType.metadata.apiName = CHECK;

  const condition = {
    type: 'comparison',
    comparison: {
      operator: 'EQUALS',
      left: {
        type: 'objectParameterPropertyValue',
        objectParameterPropertyValue: { parameterId: 'account', propertyTypeId: 'phase' },
      },
      right: { type: 'staticValue', staticValue: { type: 'string', string: 'customer' } },
    },
  };

  check.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = unchecked({
    0: { condition, displayMetadata: { failureMessage: FAILURE, typeClasses: [] } },
  });

  ir.ontology.actionTypes[CHECK] = check;

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  const ir = testIr();

  service = await startActions(ir, undefined, groupGrants(ir, PROPERTY_ROLES));
});

afterAll(() => service?.stop());

beforeEach(seed);

async function seed(): Promise<void> {
  await service.clear();

  const account = (accountId: string, ownerId: string, phase: string | null, rate: number) => ({
    accountId,
    name: `Name ${accountId}`,
    phase,
    region: 'west',
    rate,
    ownerId,
    readers: [],
    tags: [],
  });

  await insertObjects(service.db, ACCOUNT, [
    account('acc-1', 'user_ann', 'customer', 10),
    account('acc-3', 'user_carl', 'customer', 30),
    account('acc-6', 'user_carl', null, 60),
  ]);

  await insertObjects(service.db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'First', amount: 100, status: 'open' },
  ]);
}

async function apply(
  actionType: string,
  parameters: object,
  person: Person,
  options: object = EXECUTE,
): Promise<{ status: number; body: unknown }> {
  return service.apply(`${NS}${actionType}`, { parameters, options }, PEOPLE[person]);
}

async function stored(table: string, key: string, id: string, columns: string): Promise<unknown> {
  const rows = await service.db.query(sql(`SELECT ${columns} FROM ontology_1_objects.${table} WHERE ${key} = $1`, id));

  return rows[0];
}

describe('ontology/action-types/submission-criteria#person-values: a criterion reads a Property value as the person sees it', () => {
  const criteria = async (account: string, person: Person) => {
    const answer = await apply(
      'check-account-phase',
      { objectToModifyParameter: 'eng-1', account },
      person,
      VALIDATE_ONLY,
    );

    expect(answer.status).toBe(200);

    const { result, submissionCriteria } = (
      answer.body as { validation: { result: unknown; submissionCriteria: unknown } }
    ).validation;

    return { result, submissionCriteria };
  };

  const FAILS = { result: 'INVALID', submissionCriteria: [{ configuredFailureMessage: FAILURE, result: 'INVALID' }] };

  it('ontology/action-types/submission-criteria#person-values ontology/action-types/action-types#security: a criterion that needs a hidden value fails, with the answer of a value that is null', async () => {
    expect(await criteria('acc-1', 'ann')).toEqual({ result: 'VALID', submissionCriteria: [] });

    expect(await criteria('acc-3', 'ann')).toEqual(FAILS);

    expect(await criteria('acc-3', 'admin')).toEqual({ result: 'VALID', submissionCriteria: [] });

    expect(await criteria('acc-3', 'ann')).toEqual(await criteria('acc-6', 'admin'));
  });
});

describe('ontology/action-types/rules#values: a rule that copies a hidden value writes null', () => {
  it('ontology/action-types/rules#values ontology/action-types/action-types#security: the copy of the phase of acc-3 writes null for ann, and customer for admin', async () => {
    expect(
      (await apply('copy-account-phase', { objectToModifyParameter: 'eng-1', account: 'acc-3' }, 'ann')).status,
    ).toBe(200);

    expect(await stored('engagement', 'engagement_id', 'eng-1', 'status')).toEqual({ status: null });

    expect(
      (await apply('copy-account-phase', { objectToModifyParameter: 'eng-1', account: 'acc-3' }, 'admin')).status,
    ).toBe(200);

    expect(await stored('engagement', 'engagement_id', 'eng-1', 'status')).toEqual({ status: 'customer' });

    expect(
      (await apply('copy-account-phase', { objectToModifyParameter: 'eng-1', account: 'acc-1' }, 'ann')).status,
    ).toBe(200);

    expect(await stored('engagement', 'engagement_id', 'eng-1', 'status')).toEqual({ status: 'customer' });
  });
});

describe('an Action writes a value that the person cannot view, and history keeps each stored value', () => {
  it('ontology/action-types/action-types#security: ann sets the phase of acc-3, which she cannot view, and the write keeps it', async () => {
    const answer = await apply('set-account-phase', { objectToModifyParameter: 'acc-3', phase: 'prospect' }, 'ann');

    expect(answer.status).toBe(200);

    expect(await stored('account', 'account_id', 'acc-3', 'phase, rate')).toEqual({ phase: 'prospect', rate: 30 });

    const page = await service.call(
      'POST',
      `/api/v2/ontologies/${'ri.ontology.main.ontology.22144f95-115e-4429-8bda-c69ce9a98a01'}/objectSets/loadObjects`,
      {
        objectSet: {
          type: 'filter',
          objectSet: { type: 'base', objectType: ACCOUNT },
          where: { type: 'eq', field: 'accountId', value: 'acc-3' },
        },
        select: ['phase'],
        excludeRid: true,
      },
      PEOPLE.ann,
    );

    expect((JSON.parse(page.text) as { data: unknown[] }).data).toEqual([
      { __apiName: ACCOUNT, __primaryKey: 'acc-3', accountId: 'acc-3' },
    ]);
  });

  it('service/storage#object-edit-history: a modify by ann, who cannot see the pay values of acc-3, stores their true previous values', async () => {
    expect(
      (await apply('set-account-phase', { objectToModifyParameter: 'acc-3', phase: 'prospect' }, 'ann')).status,
    ).toBe(200);

    const rows = await service.db.query<{ entry: { edit: unknown } }>(
      sql("SELECT entry FROM ontology_1_engine.edit_history WHERE primary_key = 'acc-3'"),
    );

    expect(rows.map((row) => row.entry.edit)).toEqual([
      {
        type: 'modifyEdit',
        properties: { phase: 'prospect' },
        previousProperties: {
          accountId: 'acc-3',
          name: 'Name acc-3',
          phase: 'customer',
          region: 'west',
          rate: 30,
          profile: {},
          ownerId: 'user_carl',
          readers: [],
          tags: [],
        },
        includesAllPreviousValues: true,
      },
    ]);
  });

  it('service/storage#object-edit-history: the entry of a modify by ann is the entry of the same modify by admin', async () => {
    const edit = async (person: Person) => {
      await seed();

      expect(
        (await apply('set-account-phase', { objectToModifyParameter: 'acc-3', phase: 'prospect' }, person)).status,
      ).toBe(200);

      const rows = await service.db.query<{ entry: { edit: unknown } }>(
        sql("SELECT entry FROM ontology_1_engine.edit_history WHERE primary_key = 'acc-3'"),
      );

      return rows.map((row) => row.entry.edit);
    };

    expect(await edit('ann')).toEqual(await edit('admin'));
  });
});

describe('an omitted parameter whose default value is a hidden Property', () => {
  it('ontology/action-types/rules#values, ontology/action-types/action-types#security: ann omits phase on acc-3, and the hidden phase stays customer', async () => {
    expect((await apply('set-account-phase', { objectToModifyParameter: 'acc-3' }, 'ann')).status).toBe(200);

    expect(await stored('account', 'account_id', 'acc-3', 'phase')).toEqual({ phase: 'customer' });
  });

  it('ontology/action-types/action-types#apply, ontology/action-types/action-types#security: VALIDATE_ONLY gives admin the defaultValue of phase, and gives ann none', async () => {
    const phaseOf = async (person: Person) => {
      const answer = await apply('set-account-phase', { objectToModifyParameter: 'acc-3' }, person, VALIDATE_ONLY);

      return (answer.body as { validation: { parameters: Record<string, unknown> } }).validation.parameters['phase'];
    };

    expect(await phaseOf('admin')).toEqual({
      result: 'VALID',
      evaluatedConstraints: [],
      required: false,
      defaultValue: 'customer',
    });

    expect(await phaseOf('ann')).toEqual({ result: 'VALID', evaluatedConstraints: [], required: false });
  });
});
