import type { User } from '@osdk/foundry.admin';
import { z } from 'zod';
import { ApiError, type AsyncFallible } from '../errors/index.ts';
import type { StartAttributes } from '../spans/index.ts';
import type { OrganizationId, UserId } from './caller.ts';
import {
  allOf,
  keptAnswers,
  READ_LIMIT_MS,
  withinLimit,
  workosFault,
  workosPage,
  workosUnavailable,
  type Failure,
  type OnBackground,
} from './kept.ts';
import type { MembershipCheck } from './membership.ts';
import type { Permission, PermissionSource } from './permissions.ts';
import { CLIENT_ID, workosApplications, type ApplicationSource } from './service.ts';
import { workosReader, type WorkosReader } from './workosCalls.ts';
import { MAX_LIST_PAGES, PERSON_ID, toUser, WORKOS_MAX_PAGE, WorkosUser } from './workosUser.ts';

export const WORKOS_API = 'https://api.workos.com';

type MemberSource = (
  userIds: readonly string[],
  organization: OrganizationId,
  signal?: AbortSignal,
) => AsyncFallible<ReadonlyMap<string, User>, Failure>;

export interface UserSource {
  readonly get: (userId: string, signal?: AbortSignal) => AsyncFallible<User | undefined, Failure>;
  readonly members: MemberSource;
  readonly organizations: (
    userId: string,
    signal?: AbortSignal,
  ) => AsyncFallible<readonly OrganizationSummary[], Failure>;
  readonly permissions: PermissionSource;
  readonly membership?: MembershipCheck;
  readonly applications: ApplicationSource;
  readonly organization: (
    id: OrganizationId,
    signal?: AbortSignal,
  ) => AsyncFallible<OrganizationSummary | undefined, Failure>;
}

interface OrganizationSummary {
  readonly id: string;
  readonly name?: string | undefined;
}

type RoleSlug = string;

type WorkosRead = NonNullable<StartAttributes<'workos read'>['workos.read']>;

const MembershipList = z.object({
  data: z.array(
    z.object({
      user_id: z.string(),
      organization_id: z.string(),
      status: z.string(),
      roles: z.array(z.object({ slug: z.string() })),
    }),
  ),
});

const Role = z.object({ permissions: z.array(z.string()) });

const WorkosMembership = z.object({
  user_id: z.string(),
  organization_id: z.string(),
  status: z.string(),
  user: WorkosUser.optional(),
});

const WorkosApplication = z.object({
  client_id: z.string(),
  application_type: z.string(),
  organization_id: z.string().nullish(),
  name: z.string(),
});

const WorkosMembershipPage = z.object({
  data: z.array(
    z.object({
      user_id: z.string(),
      organization_id: z.string(),
      organization_name: z.string().optional(),
      status: z.string(),
    }),
  ),
  list_metadata: z.object({ after: z.string().nullish() }),
});

const WorkosOrganization = z.object({ id: z.string(), name: z.string() });

const TOO_LARGE = 'too large';

type Directory = ReadonlyMap<string, User> | typeof TOO_LARGE;

const ROLE_FRESH_MS = 300_000;
const ROLE_USABLE_MS = 600_000;

interface WorkosAccess {
  readonly permissions: PermissionSource;
  readonly membership: MembershipCheck;
}

function workosAccess(
  apiKey: string,
  apiUrl: string,
  fetch: typeof globalThis.fetch,
  onBackground?: OnBackground,
): WorkosAccess {
  const memberships = keptAnswers<readonly RoleSlug[] | undefined>({ onBackground });

  const roles = keptAnswers<readonly Permission[] | undefined>({
    freshMs: ROLE_FRESH_MS,
    usableMs: ROLE_USABLE_MS,
    onBackground,
  });

  const read = workosReader(apiKey, apiUrl, fetch);

  const membership = (user: UserId, organization: OrganizationId) =>
    async function* (signal: AbortSignal): AsyncFallible<readonly RoleSlug[] | undefined, Failure> {
      const query = new URLSearchParams({ user_id: user, organization_id: organization });

      const list = yield* read(
        'membership',
        `/user_management/organization_memberships?${query.toString()}`,
        MembershipList,
        signal,
      );

      return list?.data
        .find((item) => item.user_id === user && item.organization_id === organization && item.status === 'active')
        ?.roles.map((role) => role.slug);
    };

  const role = (organization: OrganizationId, slug: RoleSlug) =>
    async function* (signal: AbortSignal): AsyncFallible<readonly Permission[] | undefined, Failure> {
      const found = yield* read(
        'role',
        `/authorization/organizations/${encodeURIComponent(organization)}/roles/${encodeURIComponent(slug)}`,
        Role,
        signal,
      );

      return found?.permissions;
    };

  const activeRoles = async function* (
    user: UserId,
    organization: OrganizationId,
    limit: Parameters<typeof memberships.get>[2],
  ): AsyncFallible<readonly RoleSlug[], Failure> {
    const slugs = yield* memberships.get(JSON.stringify([user, organization]), membership(user, organization), limit);

    if (slugs === undefined) return yield new ApiError(403, 'Default:PermissionDenied');

    return slugs;
  };

  return {
    membership: (user, organization, signal) =>
      withinLimit(async function* (limit): AsyncFallible<void, Failure> {
        yield* activeRoles(user, organization, limit);
      }, signal),
    permissions: (user, organization, signal) =>
      withinLimit(async function* (limit): AsyncFallible<readonly Permission[], Failure> {
        const slugs = yield* activeRoles(user, organization, limit);

        const held = yield* allOf(
          slugs.map((slug) => roles.get(JSON.stringify([organization, slug]), role(organization, slug), limit)),
        );

        return [
          ...new Set(held.flatMap((permissions) => permissions ?? []).filter((permission) => permission !== '*')),
        ].sort();
      }, signal),
  };
}

export function workosPermissions(
  apiKey: string,
  apiUrl: string,
  fetch: typeof globalThis.fetch,
  onBackground?: OnBackground,
): PermissionSource {
  return workosAccess(apiKey, apiUrl, fetch, onBackground).permissions;
}

function workosMembers(
  apiKey: string,
  apiUrl: string,
  fetch: typeof globalThis.fetch,
  onBackground?: OnBackground,
): MemberSource {
  const usable = (directory: Directory) => directory !== TOO_LARGE;
  const people = keptAnswers<Directory>({ fallback: usable, onBackground });
  const services = keptAnswers<Directory>({ fallback: usable, onBackground });
  const read = workosReader(apiKey, apiUrl, fetch);

  const peopleOf = (organization: OrganizationId) =>
    async function* (signal: AbortSignal): AsyncFallible<Directory, Failure> {
      const items = yield* listDirectory(
        read,
        'members page',
        WorkosMembership,
        '/user_management/organization_memberships',
        { organization_id: organization, statuses: 'active,inactive' },
        signal,
      );

      if (items === TOO_LARGE) return TOO_LARGE;

      return new Map(
        items.flatMap(({ user, user_id, organization_id, status }) =>
          user &&
          user.id === user_id &&
          organization_id === organization &&
          (status === 'active' || status === 'inactive')
            ? [[user_id, toUser(user, status === 'active' ? 'ACTIVE' : 'DELETED')] as const]
            : [],
        ),
      );
    };

  const servicesOf = (organization: OrganizationId) =>
    async function* (signal: AbortSignal): AsyncFallible<Directory, Failure> {
      const items = yield* listDirectory(
        read,
        'applications page',
        WorkosApplication,
        '/connect/applications',
        { organization_id: organization },
        signal,
      );

      if (items === TOO_LARGE) return TOO_LARGE;

      return new Map(
        items.flatMap(({ client_id, application_type, organization_id, name }) =>
          application_type === 'm2m' && organization_id === organization
            ? [[client_id, serviceUser(client_id, name)] as const]
            : [],
        ),
      );
    };

  return (userIds, organization, signal) =>
    withinLimit(async function* (limit): AsyncFallible<ReadonlyMap<string, User>, Failure> {
      const needs = (id: RegExp) => userIds.some((userId) => id.test(userId));

      const [members, applications] = yield* allOf<Directory>([
        needs(PERSON_ID) ? people.get(organization, peopleOf(organization), limit) : undefined,
        needs(CLIENT_ID) ? services.get(organization, servicesOf(organization), limit) : undefined,
      ]);

      if (members === TOO_LARGE || applications === TOO_LARGE)
        return yield workosFault(
          `WorkOS listed more than ${MAX_LIST_PAGES} pages for the Organization ${organization}.`,
        );

      return new Map(
        userIds.flatMap((id) => {
          const user = (CLIENT_ID.test(id) ? applications : members)?.get(id);

          return user ? [[id, user] as const] : [];
        }),
      );
    }, signal);
}

async function* listDirectory<Item>(
  read: WorkosReader,
  kind: WorkosRead,
  item: z.ZodType<Item>,
  path: string,
  filter: Record<string, string>,
  signal: AbortSignal,
): AsyncFallible<Item[] | typeof TOO_LARGE, Failure> {
  const items: Item[] = [];
  let after: string | null = null;

  for (let pages = 0; pages === 0 || after; pages += 1) {
    if (pages === MAX_LIST_PAGES) return TOO_LARGE;

    const query: URLSearchParams = new URLSearchParams({
      ...filter,
      limit: String(WORKOS_MAX_PAGE),
      order: 'asc',
      ...(after ? { after } : {}),
    });

    const found = yield* read(kind, `${path}?${query.toString()}`, workosPage(item), signal);

    if (!found) return yield workosFault(`WorkOS gave no list for ${path}.`);

    items.push(...found.data);

    after = found.list_metadata?.after ?? null;
  }

  return items;
}

function serviceUser(clientId: string, name: string): User {
  return { id: clientId, username: clientId, givenName: name, realm: 'workos', status: 'ACTIVE', attributes: {} };
}

export function workosUsers(
  apiKey: string,
  options: { readonly fetch?: typeof globalThis.fetch; readonly onBackground?: OnBackground | undefined } = {},
): UserSource {
  const fetch = options.fetch ?? globalThis.fetch;
  const { onBackground } = options;
  const reader = workosReader(apiKey, WORKOS_API, fetch);
  const people = keptAnswers<User | undefined>({ onBackground });
  const organizations = keptAnswers<readonly OrganizationSummary[]>({ onBackground });

  const personOf = (userId: string) =>
    async function* (signal: AbortSignal): AsyncFallible<User | undefined, Failure> {
      const user = yield* reader('user', `/user_management/users/${encodeURIComponent(userId)}`, WorkosUser, signal);

      return user && toUser(user, 'ACTIVE');
    };

  const organizationsOf = (userId: string) =>
    async function* (signal: AbortSignal): AsyncFallible<readonly OrganizationSummary[], Failure> {
      const found: OrganizationSummary[] = [];
      let after: string | null | undefined;

      for (let pages = 0; pages === 0 || after; pages += 1) {
        if (pages === MAX_LIST_PAGES)
          return yield workosFault(`WorkOS listed more than ${MAX_LIST_PAGES} pages of memberships for ${userId}.`);

        const query = new URLSearchParams({
          user_id: userId,
          statuses: 'active',
          limit: String(WORKOS_MAX_PAGE),
          ...(after ? { after } : {}),
        });

        const page = yield* reader(
          'memberships page',
          `/user_management/organization_memberships?${query.toString()}`,
          WorkosMembershipPage,
          signal,
        );

        found.push(
          ...(page?.data ?? [])
            .filter((item) => item.user_id === userId && item.status === 'active')
            .map(({ organization_id, organization_name }) => ({ id: organization_id, name: organization_name })),
        );

        after = page?.list_metadata.after;
      }

      return found.sort(
        (a, b) =>
          Buffer.compare(Buffer.from(a.name ?? ''), Buffer.from(b.name ?? '')) ||
          Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      );
    };

  const readPath = async function* <T>(
    kind: WorkosRead,
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): AsyncFallible<T | undefined, Failure> {
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(workosUnavailable()), READ_LIMIT_MS);

    try {
      return yield* reader(kind, path, schema, signal ? AbortSignal.any([limit.signal, signal]) : limit.signal, signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const access = workosAccess(apiKey, WORKOS_API, fetch, onBackground);

  return {
    get: async function* (userId, signal): AsyncFallible<User | undefined, Failure> {
      if (!PERSON_ID.test(userId)) return undefined;

      return yield* withinLimit((limit) => people.get(userId, personOf(userId), limit), signal);
    },
    members: workosMembers(apiKey, WORKOS_API, fetch, onBackground),
    permissions: access.permissions,
    membership: access.membership,
    applications: workosApplications(apiKey, WORKOS_API, fetch, onBackground),
    organization: async function* (id, signal): AsyncFallible<OrganizationSummary | undefined, Failure> {
      if (!/^org_[0-9A-Za-z]{1,64}$/.test(id)) return undefined;

      const found = yield* readPath(
        'organization',
        `/organizations/${encodeURIComponent(id)}`,
        WorkosOrganization,
        signal,
      );

      if (!found) return undefined;

      if (found.id !== id) return yield workosFault('WorkOS gave an Organization with another ID.');

      return { id, name: found.name };
    },
    organizations: async function* (userId, signal): AsyncFallible<readonly OrganizationSummary[], Failure> {
      if (!PERSON_ID.test(userId)) return [];

      return yield* withinLimit((limit) => organizations.get(userId, organizationsOf(userId), limit), signal);
    },
  };
}
