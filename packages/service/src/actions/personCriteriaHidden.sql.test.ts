import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ONTOLOGY_RID, propertyPoliciesIr, unchecked } from '../ontology/stored.test-utils.ts';
import { groupGrants, policyPeople, PROPERTY_ROLES } from '../policiesPeople.test-utils.ts';
import { insertObjects, NS, startActions, type ActionsService, type RawAnswer } from './actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const PERSON = 'ontology/action-types/submission-criteria#person-values';

const PEOPLE = policyPeople(
  {
    ann: { sub: 'user_ann', role: 'member' },
    admin: { sub: 'user_admin', role: 'admin' },
  },
  PROPERTY_ROLES,
);

type Person = keyof typeof PEOPLE;

const OPERATORS = ['EQUALS', 'NOT_EQUALS', 'INTERSECTS'] as const;

type Operator = (typeof OPERATORS)[number];

const named = (operator: Operator) => `${NS}phase-${operator.toLowerCase().replace('_', '-')}-user`;
const message = (operator: Operator) => `The phase must ${operator} the user.`;

function testIr(): OntologyIr {
  const ir = propertyPoliciesIr();

  for (const operator of OPERATORS) {
    const block = structuredClone(ir.ontology.actionTypes[`${NS}copy-account-phase`]);

    if (!block) throw new Error('property-policies.json has no copy-account-phase.');

    block.actionType.metadata.apiName = named(operator);

    const condition = {
      type: 'comparison',
      comparison: {
        operator,
        left: {
          type: 'objectParameterPropertyValue',
          objectParameterPropertyValue: { parameterId: 'account', propertyTypeId: 'phase' },
        },
        right: {
          type: 'userProperty',
          userProperty: {
            userId: { type: 'currentUser', currentUser: {} },
            propertyValue: { type: 'userId', userId: {} },
          },
        },
      },
    };

    block.actionType.actionTypeLogic.validation.actionTypeLevelValidation.rules = unchecked({
      0: { condition, displayMetadata: { failureMessage: message(operator), typeClasses: [] } },
    });

    ir.ontology.actionTypes[named(operator)] = block;
  }

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  const ir = testIr();

  service = await startActions(ir, undefined, groupGrants(ir, PROPERTY_ROLES));
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  const account = (accountId: string, ownerId: string, phase: string | null) => ({
    accountId,
    name: `Name ${accountId}`,
    phase,
    region: 'west',
    rate: 10,
    ownerId,
    readers: [],
    tags: [],
  });

  await insertObjects(service.db, ACCOUNT, [
    account('acc-1', 'user_ann', 'user_ann'),
    account('acc-3', 'user_carl', 'user_ann'),
    account('acc-8', 'user_ann', null),
  ]);

  await insertObjects(service.db, ENGAGEMENT, [
    { engagementId: 'eng-1', accountId: 'acc-1', title: 'First', amount: 100, status: 'open' },
  ]);
});

function validate(operator: Operator, account: string, person: Person): Promise<RawAnswer> {
  const body = {
    parameters: { objectToModifyParameter: 'eng-1', account },
    options: { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' },
  };

  return service.call(
    'POST',
    `/api/v2/ontologies/${ONTOLOGY_RID}/actions/${named(operator)}/apply`,
    body,
    PEOPLE[person],
  );
}

async function result(operator: Operator, account: string, person: Person): Promise<unknown> {
  const answer = await validate(operator, account, person);

  expect(answer.status).toBe(200);

  const { validation } = JSON.parse(answer.text) as {
    validation: { result: string; submissionCriteria: { configuredFailureMessage: string }[] };
  };

  return validation.result === 'VALID'
    ? 'VALID'
    : validation.submissionCriteria.map((each) => each.configuredFailureMessage);
}

describe('a person criterion on a hidden Property value', () => {
  it.each([
    ['EQUALS', 'VALID', [message('EQUALS')]],
    ['NOT_EQUALS', [message('NOT_EQUALS')], 'VALID'],
    ['INTERSECTS', 'VALID', [message('INTERSECTS')]],
  ] as const)(
    `${PERSON}/680a1de0: phase %s user.id gives %j on the visible value user_ann and %j on the hidden one`,
    async (operator, visible, hidden) => {
      expect(await result(operator, 'acc-1', 'ann')).toEqual(visible);

      expect(await result(operator, 'acc-3', 'ann')).toEqual(hidden);
    },
  );

  it.each(OPERATORS)(
    `${PERSON}/680a1de0: phase %s user.id on a hidden value gives the answer bytes of a true null`,
    async (operator) => {
      const [hidden, missing] = await Promise.all([
        validate(operator, 'acc-3', 'ann'),
        validate(operator, 'acc-8', 'ann'),
      ]);

      expect(hidden).toEqual(missing);
    },
  );
});
