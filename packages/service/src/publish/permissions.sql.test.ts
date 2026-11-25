import type { Claims } from '../tokens.test-utils.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  account,
  insertObjects,
  NS,
  ONTOLOGY_RID,
  startActions,
  twinFunctions,
  twinIr,
  type ActionsService,
  type RawAnswer,
} from '../actions/actions.test-utils.ts';
import { twinGrants } from '../ontology/stored.test-utils.ts';
import { claimsOf, NO_ROLE, personOf, roleUsers } from '../people.test-utils.ts';
import { routeRecording } from '../tracing.test-utils.ts';
import { installOnce } from '../install.test-utils.ts';
import { installOntology } from '../install.test-utils.ts';
import { sql } from './publish.test-utils.ts';
import { ORGANIZATION } from '../tokens.test-utils.ts';
import { OTHER_ORGANIZATION, SERVICE_USER } from '../tokens.test-utils.ts';
import { STUB_APPLICATION, STUB_PERSON, stubUsers } from '../workos.test-utils.ts';

const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const STRUCT_PROBE = `${NS}StructProbe`;
const INSTALL = '/api/ontology-service/v1/ontologies';

const grants = twinGrants('0.7.0');

const ROLES = {
  ...grants.defaultRoles,
  'org-auditor': ['accounts:read'],
  'org-closer': ['accounts:read', 'accounts:close'],
  'org-full-closer': ['accounts:read', 'accounts:close', 'engagements:read'],
  'org-writer': ['accounts:read', 'accounts:write'],
  'org-installer': ['ontology:install'],
};

const users = roleUsers(ROLES);

let service: ActionsService;

beforeAll(async () => {
  service = await startActions(twinIr('0.7.0'), twinFunctions('0.7.0'), grants);
});

afterAll(async () => {
  await service.stop();
});

beforeEach(async () => {
  await service.clear();
});

const json = (answer: RawAnswer) => JSON.parse(answer.text) as Record<string, unknown>;

const names = (answer: RawAnswer) =>
  ((json(answer)['data'] ?? []) as { apiName: string }[]).map(({ apiName }) => apiName.replace(NS, ''));

const get = (path: string, claims: Claims) => service.call('GET', `${ONTOLOGY}${path}`, undefined, { claims, users });

const post = (path: string, body: unknown, claims: Claims) =>
  service.call('POST', `${ONTOLOGY}${path}`, body, { claims, users });

const errorOf = (answer: RawAnswer, name: string) => {
  const text = answer.text.replaceAll(name, '<name>').replace(/"errorInstanceId":"[^"]*"/, '"errorInstanceId":"<id>"');

  return { status: answer.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
};

describe('the view of each caller is the cut of the version by its permissions', () => {
  it('service/authentication#access service/authentication#organizations service/code-layout#seams: each default role and each custom role gives its permissions, and each caller sees only the types of its permissions', async () => {
    const view = async (claims: Claims) => ({
      objectTypes: names(await get('/objectTypes', claims)),
      actionTypes: names(await get('/actionTypes', claims)),
    });

    expect(await view(claimsOf('admin'))).toEqual({
      objectTypes: ['Account', 'Engagement', 'StructProbe'],
      actionTypes: [
        'close-account-action',
        'copy-account-phase',
        'create-account',
        'create-engagement',
        'create-struct-probe',
        'delete-account',
        'delete-engagement',
        'delete-struct-probe',
        'probe-version-check-action',
        'set-account-phase',
        'set-engagement-status',
        'set-relationship-action',
        'set-struct-probe-relationship',
      ],
    });

    expect(await view(claimsOf('member'))).toEqual({
      objectTypes: ['Account', 'Engagement', 'StructProbe'],
      actionTypes: ['create-account', 'delete-account', 'set-account-phase'],
    });

    expect(await view(claimsOf('org-auditor'))).toEqual({ objectTypes: ['Account'], actionTypes: [] });

    expect(await view({ sub: NO_ROLE })).toEqual({ objectTypes: [], actionTypes: [] });
  });

  it('service/authentication#organizations: the role claim of a token changes no access', async () => {
    const actionTypes = async (claims: Claims) => names(await get('/actionTypes', claims));

    expect(await actionTypes({ sub: personOf('member'), role: 'admin' })).toEqual([
      'create-account',
      'delete-account',
      'set-account-phase',
    ]);

    expect(await actionTypes({ sub: NO_ROLE, role: 'admin' })).toEqual([]);

    expect((await actionTypes({ sub: personOf('admin'), role: 'member' })).length).toBe(13);
  });

  it('service/authentication#access: an Action Type is hidden from a caller that lacks the permission of 1 Object Type that it names', async () => {
    expect(names(await get('/actionTypes', claimsOf('org-closer')))).toEqual([]);

    expect(names(await get('/actionTypes', claimsOf('org-full-closer')))).toEqual([
      'close-account-action',
      'copy-account-phase',
      'probe-version-check-action',
    ]);
  });
});

describe('the cache keeps the compiled Ontology of a version, and no view', () => {
  it('service/code-layout#seams: 2 callers of 1 version get 2 views from 1 compile, and a changed role gives a new view with no compile', async () => {
    await service.publish(twinIr('0.7.0'), twinFunctions('0.7.0'), {
      ...grants,
      permissions: { ...grants.permissions, 'accounts:read': { description: 'View each account' } },
    });

    const recorder = routeRecording.recorder;

    if (!recorder) throw new Error('The sql project records no spans.');

    recorder.reset();

    const objectTypes = async (claims: Claims, from = users) =>
      names(await service.call('GET', `${ONTOLOGY}/objectTypes`, undefined, { claims, users: from }));

    const views = [await objectTypes(claimsOf('member')), await objectTypes(claimsOf('org-auditor'))];

    const wider = await objectTypes(
      claimsOf('org-auditor'),
      roleUsers({ ...ROLES, 'org-auditor': ['accounts:read', 'probes:read'] }),
    );

    const compiles = recorder.spans().filter(({ name }) => name === 'ontology compile');

    const hits = recorder
      .spans()
      .filter(({ name }) => name === 'ontology view')
      .map(({ attributes }) => attributes['ontology.cache.hit']);

    expect({ views, wider, compiles: compiles.length, hits }).toEqual({
      views: [['Account', 'Engagement', 'StructProbe'], ['Account']],
      wider: ['Account', 'StructProbe'],
      compiles: 1,
      hits: [false, true, true],
    });
  });
});

describe('a hidden type gets the answer of an unknown name', () => {
  it('service/authentication#access service/http-api#errors: the Object Type, its full metadata, a load and an aggregation of its Objects, and its Action Types each give the same answer as an unknown API name', async () => {
    const auditor = claimsOf('org-auditor');
    const unknown = `${NS}Nosuchtype`;

    const pairs: readonly [string, string, (name: string) => Promise<RawAnswer>][] = [
      ['objectType', ENGAGEMENT, (name) => get(`/objectTypes/${name}`, auditor)],
      ['objectType fullMetadata', ENGAGEMENT, (name) => get(`/objectTypes/${name}/fullMetadata`, auditor)],
      [
        'loadObjects',
        ENGAGEMENT,
        (name) =>
          post('/objectSets/loadObjects', { objectSet: { type: 'base', objectType: name }, select: [] }, auditor),
      ],
      [
        'aggregate',
        STRUCT_PROBE,
        (name) =>
          post(
            '/objectSets/aggregate',
            {
              objectSet: { type: 'base', objectType: name },
              aggregation: [{ type: 'count', name: 'count' }],
              groupBy: [],
            },
            auditor,
          ),
      ],
      ['actionType', `${NS}create-account`, (name) => get(`/actionTypes/${name}`, auditor)],
    ];

    for (const [what, hidden, call] of pairs) {
      const answers = {
        what,
        hidden: errorOf(await call(hidden), hidden),
        unknown: errorOf(await call(unknown), unknown),
      };

      expect(answers.hidden.status, what).toBe(404);
      expect(answers.hidden, what).toEqual(answers.unknown);
    }

    const visible = [
      await get(`/objectTypes/${ACCOUNT}/fullMetadata`, auditor),
      await post(
        '/objectSets/aggregate',
        {
          objectSet: { type: 'base', objectType: ACCOUNT },
          aggregation: [{ type: 'count', name: 'count' }],
          groupBy: [],
        },
        auditor,
      ),
      await post('/objectSets/loadObjects', { objectSet: { type: 'base', objectType: ACCOUNT }, select: [] }, auditor),
      await get(`/objectTypes/${ACCOUNT}`, auditor),
    ];

    expect(visible.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
  });

  it('ontology/action-types/action-types#permissions: validate and apply of an Action Type that the permissions do not open get the answer of an unknown name', async () => {
    const member = claimsOf('member');
    const hidden = `${NS}close-account-action`;
    const unknown = `${NS}no-such-action`;

    for (const options of [{ mode: 'VALIDATE_ONLY' }, { mode: 'VALIDATE_AND_EXECUTE' }]) {
      const body = { parameters: { account: 'acc-1' }, options };

      const answers = {
        hidden: errorOf(await post(`/actions/${hidden}/apply`, body, member), hidden),
        unknown: errorOf(await post(`/actions/${unknown}/apply`, body, member), unknown),
      };

      expect(answers.hidden).toEqual(answers.unknown);
      expect(answers.hidden.status).toBe(404);
    }
  });

  it('ontology/action-types/action-types#permissions: an apply needs no check beyond the view, so a custom role with the 2 permissions of create-account applies it', async () => {
    const writer = claimsOf('org-writer');

    const applied = await post(
      `/actions/${NS}create-account/apply`,
      { parameters: { accountId: 'acc-9', name: 'Writer' } },
      writer,
    );

    expect(applied.status).toBe(200);

    const read = await post(
      '/objectSets/loadObjects',
      { objectSet: { type: 'base', objectType: ACCOUNT }, select: ['accountId', 'name'] },
      writer,
    );

    expect((json(read)['data'] as unknown[]).map((object) => (object as { accountId: string }).accountId)).toEqual([
      'acc-9',
    ]);
  });
});

describe('a page token after a change of the permissions', () => {
  it('ontology/ontology-sdk/object-sets#paging: a page token after the loss of the permission of the Object Type gets 404 ObjectTypeNotFound', async () => {
    await insertObjects(service.db, ACCOUNT, [
      account('acc-1', 'Acme', 'customer'),
      account('acc-2', 'Globex', 'prospect'),
    ]);

    const body = { objectSet: { type: 'base', objectType: ACCOUNT }, select: ['accountId'], pageSize: 1 };

    const first = await service.call('POST', `${ONTOLOGY}/objectSets/loadObjects`, body, {
      claims: claimsOf('org-auditor'),
      users,
    });

    const token = json(first)['nextPageToken'];

    expect(typeof token).toBe('string');

    const after = roleUsers({ ...ROLES, 'org-auditor': [] });

    const next = await service.call(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      { ...body, pageToken: token },
      { claims: claimsOf('org-auditor'), users: after },
    );

    expect([next.status, json(next)['errorName'], json(next)['parameters']]).toEqual([
      404,
      'ObjectTypeNotFound',
      { objectType: ACCOUNT },
    ]);
  });
});

describe('install by permission', () => {
  it('service/authentication#organizations service/publish#install: a caller that holds ontology:install installs, also with a custom role, and a caller without it gets 403', async () => {
    const install = (claims: Claims, apiName: string) =>
      service.call('POST', INSTALL, { product: 'twin', apiName, displayName: apiName }, { claims, users });

    expect((await install(claimsOf('admin'), 'by-admin')).status).toBe(200);

    expect((await install(claimsOf('org-installer'), 'by-installer')).status).toBe(200);

    const refused = await install(claimsOf('member'), 'by-member');

    expect([refused.status, json(refused)['errorName'], json(refused)['parameters']]).toEqual([
      403,
      'Default:PermissionDenied',
      {},
    ]);

    const listed = names(
      await service.call('GET', '/api/v2/ontologies', undefined, { claims: claimsOf('member'), users }),
    );

    expect(listed.filter((name) => name.startsWith('by-'))).toEqual(['by-admin', 'by-installer']);
  });

  it('service/authentication#organizations service/publish#install: the name of a role decides nothing, so a role named admin without ontology:install gets 403, and a role named boss with it installs', async () => {
    const renamed = roleUsers({ ...ROLES, admin: ['accounts:read'], boss: ['ontology:install'] });

    const install = (role: string, apiName: string) =>
      service.call(
        'POST',
        INSTALL,
        { product: 'twin', apiName, displayName: apiName },
        { claims: claimsOf(role), users: renamed },
      );

    const refused = await install('admin', 'by-named-admin');

    expect([
      refused.status,
      json(refused)['errorName'],
      json(refused)['parameters'],
      (await install('boss', 'by-boss')).status,
    ]).toEqual([403, 'Default:PermissionDenied', {}, 200]);
  });
});

describe('a service user', () => {
  const serviceUsers = (scopes: readonly string[]) =>
    stubUsers([STUB_PERSON], [], { applications: { [SERVICE_USER]: { ...STUB_APPLICATION, scopes } } });

  const asService = (method: 'GET' | 'POST', path: string, body: unknown, scopes: readonly string[]) =>
    service.call(method, path, body, { service: true, users: serviceUsers(scopes) });

  it('service/authentication#service-users: its permissions decide what it loads, applies, and installs, and an Ontology of another Organization gets 404', async () => {
    const scopes = ['accounts:read', 'accounts:write', 'ontology:install'];

    const applied = await asService(
      'POST',
      `${ONTOLOGY}/actions/${NS}create-account/apply`,
      { parameters: { accountId: 'acc-s', name: 'Sync' } },
      scopes,
    );

    const loaded = await asService(
      'POST',
      `${ONTOLOGY}/objectSets/loadObjects`,
      { objectSet: { type: 'base', objectType: ACCOUNT }, select: ['accountId'] },
      scopes,
    );

    const installed = await asService(
      'POST',
      INSTALL,
      { product: 'twin', apiName: 'by-service', displayName: 'by-service' },
      scopes,
    );

    expect([
      applied.status,
      loaded.status,
      (json(loaded)['data'] as { accountId: string }[]).map(({ accountId }) => accountId),
      installed.status,
    ]).toEqual([200, 200, ['acc-s'], 200]);

    const none = await asService('GET', `${ONTOLOGY}/objectTypes`, undefined, []);

    const refused = await asService(
      'POST',
      INSTALL,
      { product: 'twin', apiName: 'by-none', displayName: 'by-none' },
      [],
    );

    expect([names(none), refused.status, json(refused)['errorName']]).toEqual([[], 403, 'Default:PermissionDenied']);

    const other = 'ri.ontology.main.ontology.33333333-3333-4333-8333-333333333333';

    await installOnce(service.db, other, 'twin', OTHER_ORGANIZATION);

    const foreign = await asService('GET', `/api/v2/ontologies/${other}/objectTypes`, undefined, scopes);

    expect([foreign.status, json(foreign)['errorName']]).toEqual([404, 'OntologyNotFound']);
  });
});

describe('each installation is cut by the index of its own product version', () => {
  it('service/code-layout#seams: the same caller on 2 installations of 2 versions sees the types, the Action Types, and the catalog of the grants file of each version', async () => {
    const earlier = 'ri.ontology.main.ontology.44444444-4444-4444-8444-444444444444';

    await installOntology(service.db, {
      rid: earlier,
      product: 'twin',
      apiName: 'earlier',
      displayName: 'earlier',
      organization: ORGANIZATION,
    });

    const swapped = {
      ...grants,
      objectTypes: { ...grants.objectTypes, [ACCOUNT]: 'engagements:read', [ENGAGEMENT]: 'accounts:read' },
    };

    await service.publish(twinIr('0.7.0'), twinFunctions('0.7.0'), swapped);

    await service.db.query(
      sql('UPDATE ontology_registry.ontologies SET version = version - 1 WHERE rid = $1', earlier),
    );

    const at = async (rid: string) => {
      const list = async (path: string, role: string) =>
        names(
          await service.call('GET', `/api/v2/ontologies/${rid}/${path}`, undefined, { claims: claimsOf(role), users }),
        );

      const catalog = await service.call('GET', `/api/ontology-service/v1/ontologies/${rid}/permissions`, undefined, {
        claims: claimsOf('org-writer'),
        users,
      });

      const accountsWrite = (json(catalog)['data'] as { slug: string; requires: string[] }[]).find(
        ({ slug }) => slug === 'accounts:write',
      );

      return {
        objectTypes: await list('objectTypes', 'org-auditor'),
        actionTypes: await list('actionTypes', 'org-writer'),
        requires: accountsWrite?.requires,
      };
    };

    expect({ earlier: await at(earlier), newest: await at(ONTOLOGY_RID) }).toEqual({
      earlier: {
        objectTypes: ['Account'],
        actionTypes: ['create-account', 'delete-account', 'set-account-phase'],
        requires: ['accounts:read'],
      },
      newest: { objectTypes: ['Engagement'], actionTypes: [], requires: ['engagements:read'] },
    });
  });
});
