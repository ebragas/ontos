import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workosUsers, type UserSource, type WorkosUser } from './index.ts';
import { unchecked, USE } from '../ontology/stored.test-utils.ts';
import { ORGANIZATION, OTHER_ORGANIZATION, SERVICE_USER } from '../tokens.test-utils.ts';
import {
  STUB_APPLICATION,
  STUB_PERSON,
  STUB_WORKOS_KEY,
  stubWorkos,
  type StubMembership,
} from '../workos.test-utils.ts';
import {
  errorAnswer,
  NS,
  parameterResult,
  parameterValue,
  rowsOf,
  seedClient,
  startActions,
  staticString,
  twinFunctions,
  twinIr,
  type ActionsService,
} from '../actions/actions.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const CREATE_ACCOUNT = `${NS}create-account`;
const ASSIGN_ACCOUNT = `${NS}assign-account`;
const ASSIGN_OWNER = `${NS}assign-owner`;
const ASSIGN_CHECKED = `${NS}assign-checked`;
const ASSIGN_LISTS = `${NS}assign-lists`;
const ASSIGN_BOUNDED = `${NS}assign-bounded`;
const ASSIGN_ENGAGEMENT = `${NS}assign-engagement`;
const SET_ENGAGEMENT_STATUS = `${NS}set-engagement-status`;
const CLOSE_ACCOUNT_ACTION = `${NS}close-account-action`;

const MEMBER = STUB_PERSON;

const SECOND_MEMBER: WorkosUser = {
  id: 'user_01TEST00000000000000000002',
  email: 'grace@example.com',
  first_name: 'Grace',
  last_name: 'Hopper',
};

const FORMER: WorkosUser = {
  id: 'user_01TEST00000000000000000003',
  email: 'alan@example.com',
  first_name: 'Alan',
  last_name: 'Turing',
};

const OUTSIDER: WorkosUser = {
  id: 'user_01TEST00000000000000000004',
  email: 'kurt@example.com',
  first_name: 'Kurt',
  last_name: 'Goedel',
};

const OTHER_MEMBER: WorkosUser = {
  id: 'user_01TEST00000000000000000005',
  email: 'emmy@example.com',
  first_name: 'Emmy',
  last_name: 'Noether',
};

const UNKNOWN = 'user_01TEST00000000000000000006';
const GITHUB_SUBJECT = 'repo:example/app:environment:ontology-staging';

const MEMBERSHIPS: StubMembership[] = [
  { user_id: MEMBER.id, organization_id: ORGANIZATION, status: 'active' },
  { user_id: SECOND_MEMBER.id, organization_id: ORGANIZATION, status: 'active' },
  { user_id: FORMER.id, organization_id: ORGANIZATION, status: 'inactive' },
  { user_id: OTHER_MEMBER.id, organization_id: OTHER_ORGANIZATION, status: 'active' },
];

const FOREIGN_SERVICE = 'client_01JFOREIGNSERV1CE0000000AB';
const UNKNOWN_CLIENT = 'client_01JUNKNOWNCL1ENT00000000AB';

const ROLES = {
  roles: { [ORGANIZATION]: { member: [USE] }, [OTHER_ORGANIZATION]: { member: [USE] } },
  applications: {
    [SERVICE_USER]: STUB_APPLICATION,
    [FOREIGN_SERVICE]: { ...STUB_APPLICATION, name: 'Foreign sync', organization_id: OTHER_ORGANIZATION },
  },
};

const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };
const EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'NONE' };
const USER = { type: 'user', user: { type: 'user', user: { filter: [] } } };
const NOT_REQUIRED = { type: 'notRequired', notRequired: {} };
const REQUIRED = { type: 'required', required: {} };
const GROUP_MEMBER = { type: 'groupMember' };

const CREATE_ACCOUNT_RESULTS = {
  accountId: parameterResult('VALID', false),
  name: parameterResult('VALID', true),
  phase: parameterResult('VALID', false),
};

function validation(assignee: 'VALID' | 'INVALID', watchers: 'VALID' | 'INVALID' = 'VALID') {
  return {
    result: assignee === 'VALID' && watchers === 'VALID' ? 'VALID' : 'INVALID',
    submissionCriteria: [],
    parameters: {
      ...CREATE_ACCOUNT_RESULTS,
      assignee: parameterResult(assignee, false, [GROUP_MEMBER]),
      watchers: parameterResult(watchers, false, [GROUP_MEMBER]),
    },
  };
}

function userAction(
  ir: ReturnType<typeof twinIr>,
  apiName: string,
  parameters: readonly (readonly [string, object, object, object])[],
  criteria: readonly (readonly [condition: object, failureMessage: string])[] = [],
  base: string = CREATE_ACCOUNT,
) {
  const block = structuredClone(ir.ontology.actionTypes[base]);

  if (!block) throw new Error(`The twin 0.6.3 IR has no ${base}.`);

  const { metadata, actionTypeLogic } = block.actionType;

  metadata.apiName = apiName;

  for (const [id, type, renderHint, required] of parameters) {
    metadata.parameters[id] = unchecked({
      id,
      type,
      displayMetadata: { displayName: id, description: '', typeClasses: [] },
    });

    metadata.parameterOrdering.push(id);

    actionTypeLogic.validation.parameterValidations[id] = unchecked({
      defaultValidation: {
        display: { renderHint, visibility: { type: 'editable', editable: {} } },
        validation: { allowedValues: USER, required },
      },
      conditionalOverrides: [],
    });
  }

  if (criteria.length > 0) {
    actionTypeLogic.validation.actionTypeLevelValidation.rules = Object.fromEntries(
      criteria.map(([condition, failureMessage], index) => [
        String(index),
        unchecked({ condition, displayMetadata: { failureMessage, typeClasses: [] } }),
      ]),
    );
  }

  ir.ontology.actionTypes[apiName] = block;
}

function testIr() {
  const ir = twinIr('0.6.3');

  const userString = [
    { type: 'string', string: {} },
    { type: 'userDropdown', userDropdown: {} },
  ] as const;

  const userList = [
    { type: 'stringList', stringList: {} },
    { type: 'textInput', textInput: {} },
  ] as const;

  userAction(ir, ASSIGN_ACCOUNT, [
    ['assignee', ...userString, NOT_REQUIRED],
    ['watchers', ...userList, NOT_REQUIRED],
  ]);

  userAction(ir, ASSIGN_OWNER, [
    ['owner', ...userString, REQUIRED],
    ['assignee', ...userString, NOT_REQUIRED],
  ]);

  userAction(
    ir,
    ASSIGN_CHECKED,
    [['assignee', ...userString, NOT_REQUIRED]],
    [
      [
        {
          type: 'comparison',
          comparison: { operator: 'EQUALS', left: parameterValue('name'), right: staticString('ok') },
        },
        'The name must be ok.',
      ],
    ],
  );

  userAction(ir, ASSIGN_LISTS, [
    ['watchers', ...userList, NOT_REQUIRED],
    ['others', ...userList, NOT_REQUIRED],
  ]);

  userAction(
    ir,
    ASSIGN_ENGAGEMENT,
    [
      ['assignee', ...userString, NOT_REQUIRED],
      ['watchers', ...userList, NOT_REQUIRED],
    ],
    [],
    SET_ENGAGEMENT_STATUS,
  );

  userAction(ir, ASSIGN_BOUNDED, [
    ['watchers', ...userList, { type: 'listLengthValidation', listLengthValidation: { minLength: 2, maxLength: 3 } }],
  ]);

  return ir;
}

const LIST = 'member list page';

function counted(
  fetch?: typeof globalThis.fetch,
  members: readonly WorkosUser[] = [],
): { readonly users: UserSource; readonly calls: string[] } {
  const memberships = [
    ...MEMBERSHIPS,
    ...members.map((user): StubMembership => ({ user_id: user.id, organization_id: ORGANIZATION, status: 'active' })),
  ];

  const stub = stubWorkos([MEMBER, SECOND_MEMBER, FORMER, OUTSIDER, OTHER_MEMBER, ...members], memberships, ROLES);
  const calls: string[] = [];

  const counting: typeof globalThis.fetch = (input, init) => {
    const url = new URL(new Request(input, init).url);

    if (!url.searchParams.has('statuses')) return stub.fetch(input, init);

    calls.push(LIST);

    return (fetch ?? stub.fetch)(input, init);
  };

  return { users: workosUsers(STUB_WORKOS_KEY, { fetch: counting }), calls };
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(testIr(), twinFunctions('0.6.3'));
});

afterAll(() => service?.stop());

beforeEach(() => service.clear());

function assign(parameters: Record<string, unknown>, options: object, users: UserSource) {
  return service.apply(
    ASSIGN_ACCOUNT,
    { parameters: { accountId: 'acc-assigned', name: 'Assigned', ...parameters }, options },
    { users },
  );
}

async function accounts(): Promise<unknown[]> {
  return (await rowsOf(service.db, ACCOUNT, 'account_id')).map((row) => row['account_id']);
}

describe('a parameter with the user allowed values', () => {
  it('ontology/action-types/action-types#parameters: the User ID of an active member is valid, and the apply writes', async () => {
    const { users, calls } = counted();

    expect(await assign({ assignee: MEMBER.id }, VALIDATE_ONLY, users)).toEqual({
      status: 200,
      body: { validation: validation('VALID') },
    });

    expect(await accounts()).toEqual([]);

    expect(await assign({ assignee: MEMBER.id }, EXECUTE, users)).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(/^ri\.actions\.main\.action\./),
        validation: { result: 'VALID', submissionCriteria: [], parameters: {} },
      },
    });

    expect(await accounts()).toEqual(['acc-assigned']);

    expect(calls).toEqual([LIST]);
  });

  it.each([
    ['a former member', FORMER.id, [LIST]],
    ['a person of the WorkOS environment who is no member', OUTSIDER.id, [LIST]],
    ['an unknown User ID', UNKNOWN, [LIST]],
    ['a member of another Organization', OTHER_MEMBER.id, [LIST]],
    ['a GitHub subject', GITHUB_SUBJECT, []],
  ])(
    'ontology/action-types/action-types#parameters: %s is refused as a value outside the allowed values, and the apply writes nothing',
    async (_name, assignee, reads) => {
      const { users, calls } = counted();

      expect(await assign({ assignee }, EXECUTE, users)).toEqual({
        status: 200,
        body: { validation: validation('INVALID') },
      });

      expect(await accounts()).toEqual([]);

      expect(calls).toEqual(reads);
    },
  );

  it('ontology/action-types/action-types#parameters: the client ID of a service user of the Organization is valid, at VALIDATE_ONLY and at apply, from 1 read of the kept application list', async () => {
    const reads: string[] = [];
    const stub = stubWorkos([MEMBER], MEMBERSHIPS, ROLES);

    const fetch: typeof globalThis.fetch = (url, init) => {
      reads.push(new URL(new Request(url, init).url).pathname);

      return stub.fetch(url, init);
    };

    const users = workosUsers(STUB_WORKOS_KEY, { fetch });

    expect(await assign({ assignee: SERVICE_USER, watchers: [MEMBER.id, SERVICE_USER] }, VALIDATE_ONLY, users)).toEqual(
      { status: 200, body: { validation: validation('VALID') } },
    );

    expect(await accounts()).toEqual([]);

    expect((await assign({ assignee: SERVICE_USER }, EXECUTE, users)).status).toBe(200);

    expect(await accounts()).toEqual(['acc-assigned']);

    expect(reads.filter((path) => path.startsWith('/connect/applications'))).toEqual(['/connect/applications']);
  });

  it('ontology/action-types/action-types#parameters: the client ID of a service user of another Organization gets the bytes of an unknown User ID, and the apply writes nothing', async () => {
    for (const options of [EXECUTE, VALIDATE_ONLY]) {
      const answers = new Set<string>();

      for (const assignee of [FOREIGN_SERVICE, UNKNOWN_CLIENT, UNKNOWN])
        answers.add(JSON.stringify(await assign({ assignee }, options, counted().users)));

      expect(answers.size).toBe(1);
      expect(JSON.parse([...answers][0] ?? '')).toEqual({ status: 200, body: { validation: validation('INVALID') } });
    }

    expect(await accounts()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a former member, a non-member, and an unknown User ID get the same bytes, at apply and at VALIDATE_ONLY', async () => {
    for (const options of [EXECUTE, VALIDATE_ONLY]) {
      const answers = new Set<string>();

      for (const assignee of [FORMER.id, OUTSIDER.id, UNKNOWN, OTHER_MEMBER.id]) {
        answers.add(JSON.stringify(await assign({ assignee }, options, counted().users)));
      }

      expect(answers.size).toBe(1);
      expect(JSON.parse([...answers][0] ?? '')).toEqual({ status: 200, body: { validation: validation('INVALID') } });
    }

    expect(await accounts()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: VALIDATE_ONLY reads the member list, and refuses a former member', async () => {
    const { users, calls } = counted();

    expect(await assign({ assignee: FORMER.id }, VALIDATE_ONLY, users)).toEqual({
      status: 200,
      body: { validation: validation('INVALID') },
    });

    expect(calls).toEqual([LIST]);
  });

  it('ontology/action-types/action-types#parameters: an optional user parameter with no value is valid, and needs no WorkOS call', async () => {
    const { users, calls } = counted();

    expect(await assign({ assignee: null }, VALIDATE_ONLY, users)).toEqual({
      status: 200,
      body: { validation: validation('VALID') },
    });

    expect(await assign({}, EXECUTE, users)).toMatchObject({ status: 200, body: { validation: { result: 'VALID' } } });

    expect(await accounts()).toEqual(['acc-assigned']);

    expect(calls).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a list of users checks each element, and reads the member list once', async () => {
    const { users, calls } = counted();

    expect(
      await assign({ assignee: MEMBER.id, watchers: [MEMBER.id, SECOND_MEMBER.id, MEMBER.id] }, VALIDATE_ONLY, users),
    ).toEqual({ status: 200, body: { validation: validation('VALID') } });

    expect(calls).toEqual([LIST]);

    const refused = counted();

    expect(await assign({ watchers: [SECOND_MEMBER.id, FORMER.id] }, EXECUTE, refused.users)).toEqual({
      status: 200,
      body: { validation: validation('VALID', 'INVALID') },
    });

    expect(refused.calls).toEqual([LIST]);

    expect(await accounts()).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: a value that is not a String gets the type error, and needs no WorkOS call', async () => {
    const { users, calls } = counted();

    const answer = await assign({ assignee: 7 }, EXECUTE, users);

    expect(errorAnswer(answer)).toEqual({
      status: 400,
      body: {
        errorCode: 'INVALID_ARGUMENT',
        errorName: 'InvalidParameterValue',
        parameters: { parameterBaseType: 'String', parameterId: 'assignee', parameterValue: 7 },
      },
    });

    expect(calls).toEqual([]);
  });

  it('ontology/action-types/action-types#parameters: the MCP tool refuses a former member as the OSDK route does', async () => {
    const { users, calls } = counted();

    const answer = await service.applyOverMcp(
      ASSIGN_ACCOUNT,
      { accountId: 'acc-assigned', name: 'Assigned', assignee: FORMER.id },
      { users },
    );

    expect(answer.status).toBe(200);
    expect(JSON.stringify(answer.body)).toContain('INVALID');

    expect(await accounts()).toEqual([]);

    expect(calls).toEqual([LIST]);
  });

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a request with a parameter that fails its check makes 0 member reads and shows each user parameter that passes its other checks as VALID (%o)',
    async (options) => {
      const { users, calls } = counted();

      const answer = await service.apply(
        ASSIGN_ACCOUNT,
        { parameters: { accountId: 'acc-assigned', assignee: FORMER.id, watchers: [OUTSIDER.id] }, options },
        { users },
      );

      expect(answer).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: {
              ...CREATE_ACCOUNT_RESULTS,
              name: parameterResult('INVALID', true),
              assignee: parameterResult('VALID', false, [GROUP_MEMBER]),
              watchers: parameterResult('VALID', false, [GROUP_MEMBER]),
            },
          },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a required user parameter with no value is INVALID, makes 0 member reads, and the user parameter with a value shows VALID (%o)',
    async (options) => {
      const { users, calls } = counted();

      const answer = await service.apply(
        ASSIGN_OWNER,
        { parameters: { accountId: 'acc-assigned', name: 'Assigned', assignee: FORMER.id }, options },
        { users },
      );

      expect(answer).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: {
              ...CREATE_ACCOUNT_RESULTS,
              owner: parameterResult('INVALID', true, [GROUP_MEMBER]),
              assignee: parameterResult('VALID', false, [GROUP_MEMBER]),
            },
          },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a user list parameter above the list limit is INVALID and makes 0 member reads (%o)',
    async (options) => {
      const { users, calls } = counted();

      const answer = await assign({ watchers: Array.from({ length: 10_001 }, () => MEMBER.id) }, options, users);

      expect(answer).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: {
              ...CREATE_ACCOUNT_RESULTS,
              assignee: parameterResult('VALID', false, [GROUP_MEMBER]),
              watchers: parameterResult('INVALID', false, [{ type: 'arraySize', lte: 10_000 }, GROUP_MEMBER]),
            },
          },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a user list parameter outside its list length is INVALID and makes 0 member reads (%o)',
    async (options) => {
      for (const watchers of [[MEMBER.id], [MEMBER.id, SECOND_MEMBER.id, MEMBER.id, SECOND_MEMBER.id]]) {
        const { users, calls } = counted();

        const answer = await service.apply(
          ASSIGN_BOUNDED,
          { parameters: { accountId: 'acc-assigned', name: 'Assigned', watchers }, options },
          { users },
        );

        expect(answer).toEqual({
          status: 200,
          body: {
            validation: {
              result: 'INVALID',
              submissionCriteria: [],
              parameters: {
                ...CREATE_ACCOUNT_RESULTS,
                watchers: parameterResult('INVALID', true, [{ type: 'arraySize', gte: 2, lte: 3 }, GROUP_MEMBER]),
              },
            },
          },
        });

        expect(calls).toEqual([]);
      }

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a failed criterion does not stop the member check (%o)',
    async (options) => {
      const failed = { configuredFailureMessage: 'The name must be ok.', result: 'INVALID' };

      for (const [assignee, result] of [
        [FORMER.id, 'INVALID'],
        [MEMBER.id, 'VALID'],
      ] as const) {
        const { users, calls } = counted();

        const answer = await service.apply(
          ASSIGN_CHECKED,
          { parameters: { accountId: 'acc-assigned', name: 'Assigned', assignee }, options },
          { users },
        );

        expect(answer).toEqual({
          status: 200,
          body: {
            validation: {
              result: 'INVALID',
              submissionCriteria: [failed],
              parameters: { ...CREATE_ACCOUNT_RESULTS, assignee: parameterResult(result, false, [GROUP_MEMBER]) },
            },
          },
        });

        expect(calls).toEqual([LIST]);
      }

      expect(await accounts()).toEqual([]);
    },
  );

  const members = (count: number): WorkosUser[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `user_01BOUND${String(i).padStart(4, '0')}`,
      email: `member${i}@example.com`,
      first_name: null,
      last_name: null,
    }));

  it('ontology/action-types/action-types#parameters: 500 distinct user values read the member list once, 1 page for each 100 memberships', async () => {
    const list = members(499);
    const { users, calls } = counted(undefined, list);

    const answer = await assign(
      { assignee: MEMBER.id, watchers: [...list.map((user) => user.id), MEMBER.id] },
      VALIDATE_ONLY,
      users,
    );

    expect(answer).toEqual({ status: 200, body: { validation: validation('VALID') } });
    expect(calls).toEqual(Array.from({ length: 6 }, () => LIST));
  });

  it('ontology/action-types/action-types#parameters: 501 distinct user values are refused as a non-member list, with no WorkOS read', async () => {
    const list = members(501);
    const { users, calls } = counted(undefined, list);

    const answer = await assign({ watchers: list.map((user) => user.id) }, VALIDATE_ONLY, users);

    const nonMember = await assign({ watchers: [SECOND_MEMBER.id, FORMER.id] }, VALIDATE_ONLY, counted().users);

    expect(answer).toEqual({ status: 200, body: { validation: validation('VALID', 'INVALID') } });
    expect(JSON.stringify(answer)).toBe(JSON.stringify(nonMember));
    expect(calls).toEqual([]);
  });

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: 501 distinct user values with another INVALID parameter make 0 member reads and show the user parameter as VALID (%o)',
    async (options) => {
      const list = members(501);
      const { users, calls } = counted(undefined, list);

      const answer = await service.apply(
        ASSIGN_ACCOUNT,
        { parameters: { accountId: 'acc-assigned', watchers: list.map((user) => user.id) }, options },
        { users },
      );

      expect(answer).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: {
              ...CREATE_ACCOUNT_RESULTS,
              name: parameterResult('INVALID', true),
              assignee: parameterResult('VALID', false, [GROUP_MEMBER]),
              watchers: parameterResult('VALID', false, [GROUP_MEMBER]),
            },
          },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: 501 distinct user values across 2 parameters make 0 member reads and are INVALID in each (%o)',
    async (options) => {
      const list = members(501);
      const { users, calls } = counted(undefined, list);
      const ids = list.map((user) => user.id);

      const answer = await service.apply(
        ASSIGN_LISTS,
        {
          parameters: {
            accountId: 'acc-assigned',
            name: 'Assigned',
            watchers: ids.slice(0, 300),
            others: ids.slice(300),
          },
          options,
        },
        { users },
      );

      expect(answer).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: {
              ...CREATE_ACCOUNT_RESULTS,
              watchers: parameterResult('INVALID', false, [GROUP_MEMBER]),
              others: parameterResult('INVALID', false, [GROUP_MEMBER]),
            },
          },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: with 501 distinct user values, an empty user list stays VALID and keeps its groupMember constraint (%o)',
    async (options) => {
      const list = members(501);
      const { users, calls } = counted(undefined, list);

      const answer = await service.apply(
        ASSIGN_LISTS,
        {
          parameters: {
            accountId: 'acc-assigned',
            name: 'Assigned',
            watchers: list.map((user) => user.id),
            others: [],
          },
          options,
        },
        { users },
      );

      expect(answer).toEqual({
        status: 200,
        body: {
          validation: {
            result: 'INVALID',
            submissionCriteria: [],
            parameters: {
              ...CREATE_ACCOUNT_RESULTS,
              watchers: parameterResult('INVALID', false, [GROUP_MEMBER]),
              others: parameterResult('VALID', false, [GROUP_MEMBER]),
            },
          },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a user list with a null element gets 400 InvalidParameterValue with the base type String and the whole list (%o)',
    async (options) => {
      const answer = await service.apply(
        ASSIGN_LISTS,
        { parameters: { accountId: 'acc-assigned', name: 'Assigned', others: [null] }, options },
        { users: counted().users },
      );

      expect(errorAnswer(answer)).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidParameterValue',
          parameters: { parameterBaseType: 'String', parameterId: 'others', parameterValue: [null] },
        },
      });

      expect(await accounts()).toEqual([]);
    },
  );

  const NOT_FOUND = {
    status: 404,
    body: { errorCode: 'NOT_FOUND', errorName: 'ObjectNotFound', parameters: { primaryKey: {} } },
  };

  const onMissing = (parameters: Record<string, unknown>, options: object, users: UserSource) =>
    service.apply(
      ASSIGN_ENGAGEMENT,
      { parameters: { objectToModifyParameter: 'eng-missing', status: 'won', ...parameters }, options },
      { users },
    );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a missing Object reads the member list, then gets 404 ObjectNotFound (%o)',
    async (options) => {
      await seedClient(service.db);

      const one = counted();

      expect(errorAnswer(await onMissing({ assignee: MEMBER.id }, options, one.users))).toEqual(NOT_FOUND);

      expect(one.calls).toEqual([LIST]);

      const list = members(500);
      const many = counted(undefined, list);

      expect(errorAnswer(await onMissing({ watchers: list.map((user) => user.id) }, options, many.users))).toEqual(
        NOT_FOUND,
      );

      expect(many.calls).toEqual(Array.from({ length: 6 }, () => LIST));
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: 501 distinct user values and a missing Object make 0 member reads, and get 404 ObjectNotFound (%o)',
    async (options) => {
      await seedClient(service.db);

      const list = members(501);
      const { users, calls } = counted(undefined, list);

      expect(errorAnswer(await onMissing({ watchers: list.map((user) => user.id) }, options, users))).toEqual(
        NOT_FOUND,
      );

      expect(calls).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: an INVALID parameter and a missing Object make 0 member reads, and get 404 ObjectNotFound (%o)',
    async (options) => {
      await seedClient(service.db);

      const { users, calls } = counted();

      expect(
        errorAnswer(
          await onMissing(
            { assignee: FORMER.id, watchers: Array.from({ length: 10_001 }, () => MEMBER.id) },
            options,
            users,
          ),
        ),
      ).toEqual(NOT_FOUND);

      expect(calls).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a value of the wrong type gets 400 InvalidParameterValue and makes 0 member reads (%o)',
    async (options) => {
      const { users, calls } = counted();

      expect(errorAnswer(await assign({ name: 5, assignee: MEMBER.id }, options, users))).toEqual({
        status: 400,
        body: {
          errorCode: 'INVALID_ARGUMENT',
          errorName: 'InvalidParameterValue',
          parameters: { parameterBaseType: 'String', parameterId: 'name', parameterValue: 5 },
        },
      });

      expect(calls).toEqual([]);

      expect(await accounts()).toEqual([]);
    },
  );

  it('ontology/action-types/action-types#parameters: a User ID longer than a WorkOS ID is refused as a non-member, with no WorkOS read', async () => {
    const { users, calls } = counted();

    const answer = await assign({ assignee: `user_${'a'.repeat(200_000)}` }, EXECUTE, users);

    const nonMember = await assign({ assignee: OUTSIDER.id }, EXECUTE, counted().users);

    expect(answer).toEqual({ status: 200, body: { validation: validation('INVALID') } });
    expect(JSON.stringify(answer)).toBe(JSON.stringify(nonMember));
    expect(calls).toEqual([]);
  });

  it.each([
    ['a rule-backed Action', SET_ENGAGEMENT_STATUS, { objectToModifyParameter: 'eng-2', status: 'won' }],
    ['a function-backed Action', CLOSE_ACCOUNT_ACTION, { account: 'acc-1' }],
  ])(
    'ontology/action-types/action-types#parameters: %s with no user parameter makes no WorkOS call',
    async (_name, actionType, parameters) => {
      await seedClient(service.db);

      const { users, calls } = counted();

      expect(await service.apply(actionType, { parameters, options: VALIDATE_ONLY }, { users })).toMatchObject({
        status: 200,
        body: { validation: { result: 'VALID' } },
      });

      expect(calls).toEqual([]);
    },
  );
});

describe('a WorkOS fault in the member check', () => {
  const answering =
    (status: number, headers: Record<string, string> = {}) =>
    () =>
      Promise.resolve(Response.json({ message: 'WorkOS fault' }, { status, headers }));

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a 429 of WorkOS gives 503 OntologyService:WorkosRateLimited, and the apply writes nothing (%o)',
    async (options) => {
      const { users, calls } = counted(answering(429, { 'retry-after': '3' }));

      expect(errorAnswer(await assign({ assignee: MEMBER.id }, options, users))).toEqual({
        status: 503,
        body: { errorCode: 'INTERNAL', errorName: 'OntologyService:WorkosRateLimited', parameters: {} },
      });

      expect(calls).toEqual([LIST]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: a 5xx of WorkOS gives 503 OntologyService:WorkosUnavailable, and the apply writes nothing (%o)',
    async (options) => {
      const { users, calls } = counted(answering(500));

      expect(errorAnswer(await assign({ assignee: MEMBER.id }, options, users))).toEqual({
        status: 503,
        body: { errorCode: 'INTERNAL', errorName: 'OntologyService:WorkosUnavailable', parameters: {} },
      });

      expect(calls).toEqual([LIST]);

      expect(await accounts()).toEqual([]);
    },
  );

  it.each([EXECUTE, VALIDATE_ONLY])(
    'ontology/action-types/action-types#parameters: another WorkOS fault gives 500 Default:Internal, and the apply writes nothing (%o)',
    async (options) => {
      const { users, calls } = counted(answering(401));

      expect(errorAnswer(await assign({ assignee: MEMBER.id }, options, users))).toEqual({
        status: 500,
        body: { errorCode: 'INTERNAL', errorName: 'Default:Internal', parameters: {} },
      });

      expect(calls).toEqual([LIST]);

      expect(await accounts()).toEqual([]);
    },
  );

  it('ontology/action-types/action-types#parameters: a member whose read fails never looks like a non-member', async () => {
    let reads = 0;
    const stub = stubWorkos([MEMBER, SECOND_MEMBER], MEMBERSHIPS, ROLES);

    const failsOnce: typeof globalThis.fetch = (input, init) =>
      reads++ === 0 ? answering(429)() : stub.fetch(input, init);

    const { users } = counted(failsOnce);

    expect((await assign({ assignee: MEMBER.id }, EXECUTE, users)).status).toBe(503);

    expect(await accounts()).toEqual([]);

    expect((await assign({ assignee: MEMBER.id }, EXECUTE, users)).status).toBe(200);

    expect(await accounts()).toEqual(['acc-assigned']);
  });
});
