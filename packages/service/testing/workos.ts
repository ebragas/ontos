import type { WorkosUser } from '../src/auth/index.ts';
import { attempt, caught, settle, type AsyncFallible } from '../src/errors/index.ts';
import { ORGANIZATION, SERVICE_USER } from './tokens.ts';
import { STUB_APPLICATION, STUB_PERSON, STUB_WORKOS_KEY } from './workosDefaults.ts';
import type { StubFailure, StubMembership, StubOptions, StubWorkos } from './workosTypes.ts';
import { applicationJson, failWorkosRequest, handleWorkosWrite } from './workosWrites.ts';

export * from './workosDefaults.ts';

export * from './workosTypes.ts';

const rejection = (error: unknown): unknown => error;

const STUB_ROLE = 'member';

const STUB_APPLICATION_ID = 'connect_app_01JSERV1CEAPP00000000000AB';

type StubRead = NonNullable<NonNullable<Parameters<StubWorkos['fail']>[1]>['reads']>[number];

type StubWrite = StubWorkos['writes'][number];

const ALL_READS: readonly StubRead[] = [
  'user',
  'membership',
  'role',
  'permissions',
  'roles',
  'organizations',
  'write',
  'application',
  'organization',
];

export function stubWorkos(
  users: readonly WorkosUser[] = [STUB_PERSON],
  memberships: readonly StubMembership[] = users.map((user) => ({
    user_id: user.id,
    organization_id: ORGANIZATION,
    status: 'active',
    organization_name: 'Test Organization',
  })),
  options: StubOptions = {},
): StubWorkos {
  const requests: string[] = [];
  const kept = [...memberships];

  const roles = new Map(
    Object.entries(options.roles ?? { [ORGANIZATION]: { [STUB_ROLE]: [] } }).map(([organization, slugs]) => [
      organization,
      new Map(Object.entries(slugs)),
    ]),
  );

  const applications = new Map(
    Object.entries(options.applications ?? { [SERVICE_USER]: STUB_APPLICATION }).map(([clientId, app]) => [
      clientId,
      { ...app, id: app.id ?? STUB_APPLICATION_ID },
    ]),
  );

  const secrets = new Map<string, string>();
  let created = 0;

  const clientIdOf = (id: string): string | undefined =>
    applications.has(id) ? id : [...applications].find(([, app]) => app.id === id)?.[0];

  const organizationNames = new Map(
    Object.entries(options.organizationNames ?? { [ORGANIZATION]: 'Test Organization' }),
  );

  let failure:
    { readonly kind: StubFailure; readonly reads: readonly StubRead[]; readonly retryAfter?: string } | undefined;

  const permissions = new Map(Object.entries(options.environment?.permissions ?? {}));

  const environmentRoles = new Map(
    Object.entries(options.environment?.roles ?? {}).map(([slug, held]) => [slug, [...held]]),
  );

  const writes: StubWrite[] = [];
  const calls: string[] = [];
  let writeFailure: { after: number; count: number; readonly kind: StubFailure | 'answer lost' } | undefined;
  let held: { readonly promise: Promise<void>; readonly release: () => void } | undefined;
  const waiting: { readonly count: number; readonly resolve: () => void }[] = [];

  const writeState = {
    applications,
    secrets,
    permissions,
    environmentRoles,
    options,
    clientIdOf,
    nextCreated: () => (created += 1),
  };

  const answer = (url: URL): Response => {
    if (url.origin === 'https://api.workos.com' && url.pathname === '/user_management/organization_memberships')
      return Response.json(membershipList(url.searchParams, users, kept));

    const role = /^\/authorization\/organizations\/([^/]+)\/roles\/([^/]+)$/.exec(url.pathname);

    if (url.origin === 'https://api.workos.com' && role) {
      const [organization, slug] = [decodeURIComponent(role[1] ?? ''), decodeURIComponent(role[2] ?? '')];
      const held = roles.get(organization)?.get(slug) ?? environmentRoles.get(slug);

      if (!held) return Response.json({ code: 'entity_not_found', message: 'Role not found.' }, { status: 404 });

      return Response.json({ object: 'role', slug, name: slug, type: 'EnvironmentRole', permissions: held });
    }

    if (url.origin === 'https://api.workos.com' && url.pathname === '/authorization/permissions') {
      return Response.json(
        page(
          url.searchParams,
          [...permissions].map(([slug, description]) => ({ object: 'permission', slug, name: slug, description })),
        ),
      );
    }

    if (url.origin === 'https://api.workos.com' && url.pathname === '/authorization/roles') {
      return Response.json({
        object: 'list',
        data: [...environmentRoles].map(([slug, held]) => ({
          object: 'role',
          slug,
          name: slug,
          type: 'EnvironmentRole',
          permissions: held,
        })),
      });
    }

    if (url.origin === 'https://api.workos.com' && url.pathname === '/organizations') {
      const ids = [
        ...new Set([...kept.map((membership) => membership.organization_id), ...(options.organizations ?? [])]),
      ];

      return Response.json(
        page(
          url.searchParams,
          ids.map((id) => ({ object: 'organization', id, name: id })),
        ),
      );
    }

    if (url.origin === 'https://api.workos.com' && url.pathname === '/connect/applications') {
      const organization = url.searchParams.get('organization_id');

      const listed = [...applications].filter(
        ([, app]) => organization === null || app.organization_id === organization,
      );

      return Response.json(
        page(
          url.searchParams,
          listed.map(([clientId, app]) => applicationJson(clientId, app)),
        ),
      );
    }

    const application = /^\/connect\/applications\/([^/]+)$/.exec(url.pathname);

    if (url.origin === 'https://api.workos.com' && application) {
      const id = decodeURIComponent(application[1] ?? '');
      const clientId = clientIdOf(id);
      const found = clientId === undefined ? undefined : applications.get(clientId);

      if (clientId === undefined || !found)
        return Response.json({ code: 'entity_not_found', message: `Application not found: '${id}'.` }, { status: 404 });

      return Response.json(applicationJson(clientId, found));
    }

    const organization = /^\/organizations\/([^/]+)$/.exec(url.pathname);

    if (url.origin === 'https://api.workos.com' && organization) {
      const id = decodeURIComponent(organization[1] ?? '');
      const name = organizationNames.get(id);

      if (name === undefined)
        return Response.json({ code: 'entity_not_found', message: 'Organization not found.' }, { status: 404 });

      return Response.json({ object: 'organization', id, name, domains: [] });
    }

    const id = decodeURIComponent(url.pathname.replace('/user_management/users/', ''));
    const user = users.find((candidate) => candidate.id === id);

    if (url.origin !== 'https://api.workos.com' || !user)
      return Response.json({ message: 'User not found.' }, { status: 404 });

    return Response.json({ object: 'user', email_verified: true, profile_picture_url: null, ...user });
  };

  const serve = async function* (
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ): AsyncFallible<Response, unknown> {
    const made = caught(() => new Request(input, init));

    if (!made.ok) return yield made.error;

    const request = made.value;
    const url = new URL(request.url);

    requests.push(url.pathname + url.search);

    calls.push(`${request.method} ${url.pathname}${url.search}`);

    for (const wait of waiting.filter(({ count }) => count <= requests.length)) {
      waiting.splice(waiting.indexOf(wait), 1);

      wait.resolve();
    }

    if (request.headers.get('authorization') !== `Bearer ${STUB_WORKOS_KEY}`)
      return Response.json({ message: 'Unauthorized' }, { status: 401 });

    const paused = held;

    if (paused) yield* attempt(() => paused.promise, rejection);

    if (request.method !== 'GET') {
      const text = yield* attempt(() => request.text(), rejection);
      const parsed = caught((): unknown => (text === '' ? undefined : JSON.parse(text)));

      if (!parsed.ok) return yield parsed.error;

      const body = parsed.value;

      writes.push({ method: request.method, path: url.pathname, body });

      if (writeFailure && writeFailure.after-- <= 0 && writeFailure.count-- > 0) {
        if (writeFailure.kind !== 'answer lost') return yield* failWorkosRequest(writeFailure.kind, request);

        handleWorkosWrite(writeState, request.method, url.pathname, body);

        return yield new TypeError('fetch failed');
      }
    }

    const kind = request.method === 'GET' ? readOf(url.pathname) : 'write';

    if (failure?.reads.includes(kind)) return yield* failWorkosRequest(failure.kind, request, failure.retryAfter);

    return request.method === 'GET'
      ? answer(url)
      : handleWorkosWrite(writeState, request.method, url.pathname, writes.at(-1)?.body);
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const served = await settle(serve(input, init));

    // oxlint-disable-next-line fallible/no-throw -- D1: the stub fetch is a typeof fetch that a WorkOS caller reads the rejection of, such as a network error.
    if (!served.ok) throw served.error;

    return served.value;
  };

  return {
    fetch,
    requests,
    calls,
    writes,
    memberships: kept,
    environment: () => ({
      permissions: Object.fromEntries(permissions),
      roles: Object.fromEntries([...environmentRoles].map(([slug, held]) => [slug, [...held]])),
    }),
    failWrites: (after, kind = '5xx', count = Infinity) => {
      writeFailure = after === undefined ? undefined : { after, count, kind };
    },
    setRole: (organization, slug, permissions) => {
      const slugs = roles.get(organization) ?? new Map<string, readonly string[]>();

      if (permissions === undefined) slugs.delete(slug);
      else slugs.set(slug, permissions);

      roles.set(organization, slugs);
    },
    setApplication: (clientId, application) => {
      if (application === undefined) applications.delete(clientId);
      else applications.set(clientId, { ...application, id: application.id ?? STUB_APPLICATION_ID });
    },
    applications: () => Object.fromEntries(applications),
    clientSecret: (clientId) => secrets.get(clientId),
    fail: (kind, { reads = ALL_READS, retryAfter } = {}) => {
      failure = kind === undefined ? undefined : { kind, reads, ...(retryAfter === undefined ? {} : { retryAfter }) };
    },
    reached: (count) =>
      count <= requests.length ? Promise.resolve() : new Promise<void>((resolve) => waiting.push({ count, resolve })),
    hold: () => {
      let release = (): void => undefined;
      const promise = new Promise<void>((resolve) => (release = resolve));

      held = { promise, release };
    },
    release: () => {
      held?.release();

      held = undefined;
    },
  };
}

function readOf(path: string): StubRead {
  if (path === '/user_management/organization_memberships') return 'membership';

  if (path === '/authorization/permissions') return 'permissions';

  if (path === '/authorization/roles') return 'roles';

  if (path === '/organizations') return 'organizations';

  if (path.startsWith('/authorization/')) return 'role';

  if (path.startsWith('/connect/applications')) return 'application';

  if (path.startsWith('/organizations/')) return 'organization';

  return 'user';
}

function page(query: URLSearchParams, items: readonly object[]): unknown {
  const limit = Number(query.get('limit') ?? 10);
  const start = Number(query.get('after') ?? 0);

  return {
    object: 'list',
    data: items.slice(start, start + limit),
    list_metadata: { before: null, after: start + limit < items.length ? String(start + limit) : null },
  };
}

function membershipList(
  query: URLSearchParams,
  users: readonly WorkosUser[],
  memberships: readonly StubMembership[],
): unknown {
  const statuses = query.get('statuses')?.split(',') ?? ['active'];

  const found = memberships.filter(
    (membership) =>
      (membership.user_id === query.get('user_id') ||
        (query.get('user_id') === null && query.get('organization_id') !== null)) &&
      (query.get('organization_id') === null || membership.organization_id === query.get('organization_id')) &&
      statuses.includes(membership.status),
  );

  const limit = Number(query.get('limit') ?? 10);
  const start = Number(query.get('after') ?? 0);
  const page = found.slice(start, start + limit);

  const data = page.map(({ roles = [STUB_ROLE], ...membership }) => ({
    object: 'organization_membership',
    ...membership,
    role: { slug: roles[0] },
    roles: roles.map((slug) => ({ slug })),
    user: users.find((user) => user.id === membership.user_id),
  }));

  return {
    object: 'list',
    data,
    list_metadata: { before: null, after: start + limit < found.length ? String(start + limit) : null },
  };
}
