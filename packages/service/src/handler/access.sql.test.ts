import type { OntologyIr } from '@osdk/client.unstable';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routes } from './index.ts';
import { unchecked } from '../ontology/stored.test-utils.ts';
import { claimsOf, NO_ROLE, roleUsers } from '../people.test-utils.ts';
import {
  ACCOUNT,
  ACTION_TYPE,
  CAMEL_ACTION,
  ENGAGEMENT,
  HIDDEN_RID,
  LINK,
  MEMBER_ACTION_TYPES,
  OBJECT_TYPE,
  RID,
  SET_ENGAGEMENT_STATUS,
  STRUCT_PROBE,
  twinSplitGrants,
  type Pair,
} from '../roles.test-utils.ts';
import { stubUsers, STUB_APPLICATION, STUB_PERSON } from '../workos.test-utils.ts';
import { ORGANIZATION, OTHER_ORGANIZATION, PERSON, SERVICE_USER } from '../tokens.test-utils.ts';
import {
  ONTOLOGY_RID,
  seedClient,
  startActions,
  twinFunctions,
  twinIr,
  NS,
  type ActionsService,
  type RawAnswer,
  type SendOptions,
} from '../actions/actions.test-utils.ts';

const DELETE_ENGAGEMENT = `${NS}delete-engagement`;
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;

const ADMIN: SendOptions = { claims: claimsOf('admin') };
const MEMBER: SendOptions = { claims: claimsOf('member') };
const NO_ROLE_PERSON: SendOptions = { claims: { sub: NO_ROLE } };

const OWNER: SendOptions = {
  claims: claimsOf('owner'),
  users: roleUsers({ ...twinSplitGrants().defaultRoles, owner: ['billing:read'] }),
};

const VALIDATE_AND_EXECUTE = { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' };
const VALIDATE_ONLY = { mode: 'VALIDATE_ONLY', returnEdits: 'NONE' };

function twinWithHistory(): OntologyIr {
  const ir = twinIr('0.7.0');
  const engagement = ir.ontology.objectTypes[ENGAGEMENT];

  if (!engagement) throw new Error('The twin 0.7.0 IR has no Engagement.');

  engagement.entityMetadata = unchecked({
    ...engagement.entityMetadata,
    editsHistory: { type: 'config', config: { store: ENGAGEMENT, storeAllPreviousProperties: false } },
  });

  return ir;
}

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(twinWithHistory(), twinFunctions('0.7.0'), twinSplitGrants());
});

afterAll(() => service?.stop());

beforeEach(async () => {
  await service.clear();

  await seedClient(service.db);
});

function get(path: string, options: SendOptions): Promise<RawAnswer> {
  return service.call('GET', `${ONTOLOGY}/${path}`, undefined, options);
}

function post(path: string, body: unknown, options: SendOptions): Promise<RawAnswer> {
  return service.call('POST', `${ONTOLOGY}/${path}`, body, options);
}

function json(answer: RawAnswer): Record<string, unknown> {
  return JSON.parse(answer.text) as Record<string, unknown>;
}

const names = (list: unknown): string[] => (list as { apiName: string }[]).map((entry) => entry.apiName).sort();

interface Call {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

interface Expected {
  readonly status: number;
  readonly errorName: string;
}

const OBJECT_TYPE_NOT_FOUND: Expected = { status: 404, errorName: 'ObjectTypeNotFound' };
const ACTION_TYPE_NOT_FOUND: Expected = { status: 404, errorName: 'ActionTypeNotFound' };
const LINK_TYPE_NOT_FOUND: Expected = { status: 404, errorName: 'LinkTypeNotFound' };
const NOT_SUPPORTED: Expected = { status: 400, errorName: 'Default:InvalidArgument' };
const QUERY_NOT_FOUND: Expected = { status: 404, errorName: 'QueryNotFound' };
const QUERY: Pair = { hidden: 'closeAccount', unknown: 'noSuchQuery' };

type Named = readonly { readonly pair: Pair; readonly call: (name: string) => Call; readonly expected: Expected }[];

type Row = { readonly lists: (member: RawAnswer) => void } | { readonly named: Named };

const base = (objectType: string) => ({ type: 'base', objectType });

const apply =
  (mode: object) =>
  (name: string): Call => ({ method: 'POST', path: `actions/${name}/apply`, body: { parameters: {}, options: mode } });

const applyBatch =
  (mode: object) =>
  (name: string): Call => ({
    method: 'POST',
    path: `actions/${name}/applyBatch`,
    body: { requests: [{ parameters: {} }], options: mode },
  });

const ROWS: Record<string, Row> = {
  'GET /api/v2/ontologies/{ontology}/fullMetadata': {
    lists: (member) => {
      const body = json(member);

      expect(Object.keys(body['objectTypes'] as object).sort()).toEqual([ENGAGEMENT, STRUCT_PROBE]);
      expect(Object.keys(body['actionTypes'] as object).sort()).toEqual(MEMBER_ACTION_TYPES);
    },
  },
  'GET /api/v2/ontologies/{ontology}/objectTypes': {
    lists: (member) => expect(names((json(member) as { data: unknown }).data)).toEqual([ENGAGEMENT, STRUCT_PROBE]),
  },
  'GET /api/v2/ontologies/{ontology}/actionTypes': {
    lists: (member) => expect(names((json(member) as { data: unknown }).data)).toEqual(MEMBER_ACTION_TYPES),
  },
  'GET /api/v2/ontologies/{ontology}/queryTypes': {
    lists: (member) => expect((json(member) as { data: unknown }).data).toEqual([]),
  },
  'GET /api/v2/ontologies/{ontology}/queryTypes/{queryApiName}': {
    named: [
      { pair: QUERY, call: (name) => ({ method: 'GET', path: `queryTypes/${name}` }), expected: QUERY_NOT_FOUND },
    ],
  },
  'POST /api/v2/ontologies/{ontology}/queries/{queryApiName}/execute': {
    named: [
      {
        pair: QUERY,
        call: (name) => ({ method: 'POST', path: `queries/${name}/execute`, body: { parameters: {} } }),
        expected: QUERY_NOT_FOUND,
      },
    ],
  },
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}': {
    named: [
      {
        pair: OBJECT_TYPE,
        call: (name) => ({ method: 'GET', path: `objectTypes/${name}` }),
        expected: OBJECT_TYPE_NOT_FOUND,
      },
    ],
  },
  'GET /api/v2/ontologies/{ontology}/objectTypes/{objectType}/fullMetadata': {
    named: [
      {
        pair: OBJECT_TYPE,
        call: (name) => ({ method: 'GET', path: `objectTypes/${name}/fullMetadata` }),
        expected: OBJECT_TYPE_NOT_FOUND,
      },
    ],
  },
  'GET /api/v2/ontologies/{ontology}/actionTypes/{actionType}': {
    named: [
      {
        pair: ACTION_TYPE,
        call: (name) => ({ method: 'GET', path: `actionTypes/${name}` }),
        expected: ACTION_TYPE_NOT_FOUND,
      },
      {
        pair: CAMEL_ACTION,
        call: (name) => ({ method: 'GET', path: `actionTypes/${name}` }),
        expected: ACTION_TYPE_NOT_FOUND,
      },
    ],
  },
  'GET /api/v2/ontologies/{ontology}/actionTypes/byRid/{actionTypeRid}': {
    named: [
      {
        pair: RID,
        call: (name) => ({ method: 'GET', path: `actionTypes/byRid/${name}` }),
        expected: ACTION_TYPE_NOT_FOUND,
      },
    ],
  },
  'POST /api/v2/ontologies/{ontology}/objectSets/loadObjects': {
    named: [
      {
        pair: OBJECT_TYPE,
        call: (name) => ({ method: 'POST', path: 'objectSets/loadObjects', body: { objectSet: base(name) } }),
        expected: OBJECT_TYPE_NOT_FOUND,
      },
      {
        pair: LINK,
        call: (name) => ({
          method: 'POST',
          path: 'objectSets/loadObjects',
          body: { objectSet: { type: 'searchAround', objectSet: base(ENGAGEMENT), link: name } },
        }),
        expected: LINK_TYPE_NOT_FOUND,
      },
    ],
  },
  'POST /api/v2/ontologies/{ontology}/objectSets/aggregate': {
    named: [
      {
        pair: OBJECT_TYPE,
        call: (name) => ({
          method: 'POST',
          path: 'objectSets/aggregate',
          body: { objectSet: base(name), aggregation: [{ type: 'count', name: 'count' }], groupBy: [] },
        }),
        expected: OBJECT_TYPE_NOT_FOUND,
      },
    ],
  },
  'POST /api/v2/ontologies/{ontology}/actions/{action}/apply': {
    named: [
      { pair: ACTION_TYPE, call: apply(VALIDATE_ONLY), expected: ACTION_TYPE_NOT_FOUND },
      { pair: ACTION_TYPE, call: apply(VALIDATE_AND_EXECUTE), expected: ACTION_TYPE_NOT_FOUND },
      { pair: CAMEL_ACTION, call: apply(VALIDATE_ONLY), expected: ACTION_TYPE_NOT_FOUND },
      { pair: CAMEL_ACTION, call: apply(VALIDATE_AND_EXECUTE), expected: ACTION_TYPE_NOT_FOUND },
    ],
  },
  'POST /api/v2/ontologies/{ontology}/actions/{action}/applyBatch': {
    named: [
      { pair: ACTION_TYPE, call: applyBatch(VALIDATE_ONLY), expected: NOT_SUPPORTED },
      { pair: ACTION_TYPE, call: applyBatch(VALIDATE_AND_EXECUTE), expected: NOT_SUPPORTED },
      { pair: CAMEL_ACTION, call: applyBatch(VALIDATE_ONLY), expected: NOT_SUPPORTED },
      { pair: CAMEL_ACTION, call: applyBatch(VALIDATE_AND_EXECUTE), expected: NOT_SUPPORTED },
    ],
  },
  'POST /api/v2/ontologies/{ontology}/objectTypes/{objectType}/editsHistory': {
    named: [
      {
        pair: OBJECT_TYPE,
        call: (name) => ({ method: 'POST', path: `objectTypes/${name}/editsHistory`, body: {} }),
        expected: OBJECT_TYPE_NOT_FOUND,
      },
    ],
  },
};

function masked(answer: RawAnswer): RawAnswer {
  return { ...answer, text: answer.text.replace(/"errorInstanceId":"[^"]*"/, '"errorInstanceId":"<id>"') };
}

describe('the route table', () => {
  const ontologyRoutes = routes
    .filter((route) => route.access === 'ontology')
    .map((route) => `${route.method} ${route.path}`);

  it('has a row for each ontology route, and no row for another route', () => {
    expect(ontologyRoutes.sort()).toEqual(Object.keys(ROWS).sort());
    expect(ontologyRoutes).toHaveLength(15);
  });

  for (const [key, row] of Object.entries(ROWS)) {
    if ('lists' in row) {
      it(`${key} lists only the types of the member`, async () => {
        const [method, path] = key.split(' ') as ['GET' | 'POST', string];

        const member = await service.call(method, path.replace('{ontology}', ONTOLOGY_RID), undefined, MEMBER);

        expect(member.status).toBe(200);

        row.lists(member);
      });

      continue;
    }

    for (const { pair, call, expected } of row.named) {
      const { method, path, body } = call(pair.hidden);

      it(`${key} answers ${pair.hidden} as it answers ${pair.unknown} (${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''})`, async () => {
        const hidden = masked(await service.call(method, `${ONTOLOGY}/${path}`, body, MEMBER));

        const unknownCall = call(pair.unknown);

        const unknown = masked(await service.call(method, `${ONTOLOGY}/${unknownCall.path}`, unknownCall.body, MEMBER));

        expect({
          status: unknown.status,
          contentType: unknown.contentType,
          errorName: json(unknown)['errorName'],
          echoesUnknown: unknown.text.includes(pair.unknown),
        }).toEqual({
          status: expected.status,
          contentType: 'application/json',
          errorName: expected.errorName,
          echoesUnknown: expected.status === 404,
        });

        expect(hidden).toEqual({ ...unknown, text: unknown.text.replaceAll(pair.unknown, pair.hidden) });

        expect({
          leaksRid: pair !== RID && hidden.text.includes(HIDDEN_RID),
          leaksAction: pair !== ACTION_TYPE && hidden.text.includes(SET_ENGAGEMENT_STATUS),
          leaksPublished: hidden.text.includes('publishedApiName'),
        }).toEqual({ leaksRid: false, leaksAction: false, leaksPublished: false });
      });
    }
  }
});

describe('a service user', () => {
  const asService = (organization: string): SendOptions => ({
    service: true,
    claims: { org_id: organization },
    users: stubUsers(undefined, undefined, {
      applications: {
        [SERVICE_USER]: { ...STUB_APPLICATION, organization_id: organization, scopes: ['jobsite:read'] },
      },
    }),
  });

  it('a service user of another Organization gets 404 OntologyNotFound for the Ontology, as a person of that Organization does', async () => {
    const service = await get('objectTypes', asService(OTHER_ORGANIZATION));

    const users = stubUsers(
      [STUB_PERSON],
      [{ user_id: PERSON, organization_id: OTHER_ORGANIZATION, status: 'active', roles: ['admin'] }],
      { roles: { [OTHER_ORGANIZATION]: { admin: ['twin:admin'] } } },
    );

    const person = await get('objectTypes', { claims: { org_id: OTHER_ORGANIZATION }, users });

    expect(service.status).toBe(404);

    expect(json(service)).toEqual({
      errorCode: 'NOT_FOUND',
      errorName: 'OntologyNotFound',
      errorInstanceId: expect.any(String),
      parameters: { ontologyRid: ONTOLOGY_RID },
    });

    expect(person.status).toBe(404);
    expect(json(person)['errorName']).toBe('OntologyNotFound');
  });

  it('service/authentication#service-users: a service user with no scope gets 200 from Users.get, Users.getBatch, List Ontologies, and the catalog, and an Ontology with no type', async () => {
    const options: SendOptions = {
      service: true,
      users: stubUsers(undefined, undefined, { applications: { [SERVICE_USER]: { ...STUB_APPLICATION, scopes: [] } } }),
    };

    const user = await service.call('GET', `/api/v2/admin/users/${PERSON}`, undefined, options);

    const batch = await service.call('POST', '/api/v2/admin/users/getBatch', [{ userId: PERSON }], options);

    const ontologies = await service.call('GET', '/api/v2/ontologies', undefined, options);

    const catalog = await service.call(
      'GET',
      `/api/ontology-service/v1/ontologies/${ONTOLOGY_RID}/permissions`,
      undefined,
      options,
    );

    const metadata = await get('fullMetadata', options);

    expect([
      user.status,
      json(user)['id'],
      batch.status,
      Object.keys(json(batch)['data'] as object),
      ontologies.status,
      catalog.status,
      metadata.status,
    ]).toEqual([200, PERSON, 200, [PERSON], 200, 200, 200]);

    expect((json(ontologies)['data'] as { rid: string }[]).map((ontology) => ontology.rid)).toEqual([ONTOLOGY_RID]);
    expect([json(metadata)['objectTypes'], json(metadata)['actionTypes']]).toEqual([{}, {}]);
  });

  it('a service user has no membership, so the 403 of a person with no active membership refuses none of its routes: Users.get, Users.getBatch, Users.getCurrent, List Ontologies, the catalog, and an OSDK read', async () => {
    const options: SendOptions = {
      service: true,
      users: stubUsers([STUB_PERSON], [], {
        applications: { [SERVICE_USER]: { ...STUB_APPLICATION, scopes: ['twin:admin'] } },
      }),
    };

    const answers = [
      await service.call('GET', `/api/v2/admin/users/${SERVICE_USER}`, undefined, options),
      await service.call('POST', '/api/v2/admin/users/getBatch', [{ userId: SERVICE_USER }], options),
      await service.call('GET', '/api/v2/admin/users/getCurrent', undefined, options),
      await service.call('GET', '/api/v2/ontologies', undefined, options),
      await service.call('GET', `/api/ontology-service/v1/ontologies/${ONTOLOGY_RID}/permissions`, undefined, options),
      await get('objectTypes', options),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200]);

    expect([
      json(answers[0] as RawAnswer)['id'],
      Object.keys(json(answers[1] as RawAnswer)['data'] as object),
      json(answers[2] as RawAnswer)['id'],
    ]).toEqual([SERVICE_USER, [SERVICE_USER], SERVICE_USER]);

    expect(names((json(answers[5] as RawAnswer) as { data: unknown }).data)).toEqual([ACCOUNT]);
  });

  it('a service user of the owner Organization with scope jobsite:read gets an Ontology with no type, and install gets 403', async () => {
    const options = asService(ORGANIZATION);

    const answer = await get('fullMetadata', options);

    expect(answer.status).toBe(200);
    expect(json(answer)['objectTypes']).toEqual({});
    expect(json(answer)['actionTypes']).toEqual({});

    expect((await post('objectSets/loadObjects', { objectSet: base(ENGAGEMENT) }, options)).status).toBe(404);

    const installed = await service.call(
      'POST',
      '/api/ontology-service/v1/ontologies',
      { product: 'twin', apiName: 'twin-2', displayName: 'twin 2' },
      options,
    );

    expect(installed.status).toBe(403);
    expect(JSON.parse(installed.text)).toMatchObject({ errorName: 'Default:PermissionDenied' });
  });
});

describe('what each caller sees', () => {
  it('on the same RID, an admin token lists Account, and a member token does not', async () => {
    expect(names((json(await get('objectTypes', ADMIN)) as { data: unknown }).data)).toEqual([
      ACCOUNT,
      ENGAGEMENT,
      STRUCT_PROBE,
    ]);

    expect(names((json(await get('objectTypes', MEMBER)) as { data: unknown }).data)).toEqual([
      ENGAGEMENT,
      STRUCT_PROBE,
    ]);

    expect(Object.keys(json(await get('fullMetadata', ADMIN))['actionTypes'] as object)).toHaveLength(13);

    expect(Object.keys(json(await get('fullMetadata', MEMBER))['actionTypes'] as object).sort()).toEqual(
      MEMBER_ACTION_TYPES,
    );
  });

  it.each([
    ['no role', NO_ROLE_PERSON],
    ['the undeclared role owner', OWNER],
  ])('a token with %s gets an Ontology with no type', async (_state, options) => {
    const answer = await get('fullMetadata', options);

    expect(answer.status).toBe(200);

    const body = json(answer);

    expect(body['objectTypes']).toEqual({});
    expect(body['actionTypes']).toEqual({});
    expect(body['ontology']).toEqual({ apiName: 'twin', displayName: 'twin', description: '', rid: ONTOLOGY_RID });

    expect(json(await get('objectTypes', options))).toEqual({ data: [] });

    expect(json(await get('actionTypes', options))).toEqual({ data: [] });

    expect((await post('objectSets/loadObjects', { objectSet: base(ENGAGEMENT) }, options)).status).toBe(404);
  });

  it('a member views the Engagements and applies delete-engagement', async () => {
    const loaded = json(
      await post(
        'objectSets/loadObjects',
        { objectSet: base(ENGAGEMENT), orderBy: { fields: [{ field: 'engagementId', direction: 'asc' }] } },
        MEMBER,
      ),
    );

    expect((loaded['data'] as { engagementId: string }[]).map((object) => object.engagementId)).toEqual([
      'eng-1',
      'eng-2',
      'eng-3',
      'eng-4',
      'eng-5',
      'eng-6',
    ]);

    const applied = await post(
      `actions/${DELETE_ENGAGEMENT}/apply`,
      { parameters: { objectToDeleteParameter: 'eng-1' }, options: VALIDATE_AND_EXECUTE },
      MEMBER,
    );

    expect(applied.status).toBe(200);
    expect(json(applied)['validation']).toEqual({ result: 'VALID', submissionCriteria: [], parameters: {} });

    const rows = await service.db.query<{ n: string }>({
      text: "SELECT count(*)::text AS n FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-1'",
      values: [],
    });

    expect(rows).toEqual([{ n: '0' }]);
  });

  it('service/authentication#access the foreign key accountId stays on the Engagement of a member, and the Link side to Account goes', async () => {
    const loaded = json(
      await post(
        'objectSets/loadObjects',
        {
          objectSet: {
            type: 'filter',
            objectSet: base(ENGAGEMENT),
            where: { type: 'eq', field: 'engagementId', value: 'eng-4' },
          },
        },
        MEMBER,
      ),
    );

    expect(loaded['data']).toEqual([
      {
        __rid: expect.any(String),
        __primaryKey: 'eng-4',
        __apiName: ENGAGEMENT,
        __title: 'Pilot',
        engagementId: 'eng-4',
        accountId: 'acc-2',
        title: 'Pilot',
        amount: 15000,
        status: 'lost',
        createdAt: '2026-10-17T18:20:06.135Z',
      },
    ]);

    const member = json(await get(`objectTypes/${ENGAGEMENT}/fullMetadata`, MEMBER));

    expect(Object.keys((member['objectType'] as { properties: object }).properties)).toContain('accountId');
    expect(member['linkTypes']).toEqual([]);

    const admin = json(await get(`objectTypes/${ENGAGEMENT}/fullMetadata`, ADMIN));

    expect(
      (admin['linkTypes'] as { apiName: string; objectTypeApiName: string }[]).map((side) => [
        side.apiName,
        side.objectTypeApiName,
      ]),
    ).toEqual([['account', ACCOUNT]]);
  });

  it('service/authentication#access: the history of a member keeps the actionTypeRid of the hidden set-engagement-status', async () => {
    const applied = await post(
      `actions/${SET_ENGAGEMENT_STATUS}/apply`,
      { parameters: { objectToModifyParameter: 'eng-2', status: 'won' }, options: VALIDATE_AND_EXECUTE },
      ADMIN,
    );

    expect(applied.status).toBe(200);

    const history = await post(
      `objectTypes/${ENGAGEMENT}/editsHistory`,
      { objectPrimaryKey: { engagementId: 'eng-2' } },
      MEMBER,
    );

    expect(history.status).toBe(200);

    const { data } = json(history) as { data: Record<string, unknown>[] };

    expect(data).toHaveLength(1);
    expect(data[0]?.['actionTypeRid']).toBe(HIDDEN_RID);

    expect(data[0]?.['edit']).toEqual({
      type: 'modifyEdit',
      properties: { status: 'won' },
      previousProperties: { status: 'open' },
      includesAllPreviousValues: false,
    });

    expect((await get(`actionTypes/byRid/${HIDDEN_RID}`, MEMBER)).status).toBe(404);

    expect((await get(`actionTypes/byRid/${HIDDEN_RID}`, ADMIN)).status).toBe(200);
  });

  it('the grant of set-engagement-status decides who can see, validate, and apply it', async () => {
    const body = { parameters: { objectToModifyParameter: 'eng-2', status: 'won' } };

    const notFound = {
      errorCode: 'NOT_FOUND',
      errorName: 'ActionTypeNotFound',
      errorInstanceId: expect.any(String),
      parameters: { actionType: SET_ENGAGEMENT_STATUS },
    };

    expect((await get(`actionTypes/${SET_ENGAGEMENT_STATUS}`, MEMBER)).status).toBe(404);

    expect(json(await get(`actionTypes/${SET_ENGAGEMENT_STATUS}`, MEMBER))).toEqual(notFound);

    expect(
      json(await post(`actions/${SET_ENGAGEMENT_STATUS}/apply`, { ...body, options: VALIDATE_ONLY }, MEMBER)),
    ).toEqual(notFound);

    expect(
      json(await post(`actions/${SET_ENGAGEMENT_STATUS}/apply`, { ...body, options: VALIDATE_AND_EXECUTE }, MEMBER)),
    ).toEqual(notFound);

    const rows = await service.db.query<{ status: string }>({
      text: "SELECT status FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2'",
      values: [],
    });

    expect(rows).toEqual([{ status: 'open' }]);

    expect((await get(`actionTypes/${SET_ENGAGEMENT_STATUS}`, ADMIN)).status).toBe(200);

    expect(
      (
        json(await post(`actions/${SET_ENGAGEMENT_STATUS}/apply`, { ...body, options: VALIDATE_ONLY }, ADMIN))[
          'validation'
        ] as { result: string }
      ).result,
    ).toBe('VALID');

    expect(
      (await post(`actions/${SET_ENGAGEMENT_STATUS}/apply`, { ...body, options: VALIDATE_AND_EXECUTE }, ADMIN)).status,
    ).toBe(200);

    expect(
      await service.db.query({
        text: "SELECT status FROM ontology_1_objects.engagement WHERE engagement_id = 'eng-2'",
        values: [],
      }),
    ).toEqual([{ status: 'won' }]);
  });
});
