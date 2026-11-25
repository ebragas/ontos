import { z } from 'zod';
import {
  ApiError,
  attempt,
  outsideFailure,
  settle,
  step,
  type AsyncFallible,
  type Fallible,
  type FallibleStream,
} from '../errors/index.ts';
import type { RoleSlug, WorkosPort, WorkosRoles, WorkosStep } from '../publish/index.ts';
import type { StartAttributes } from '../spans/index.ts';
import { workosPage, workosUnavailable, type Failure } from './workosErrors.ts';
import { fetchOrUnavailable, jsonOrUndefined, tracedFallible } from './workosCalls.ts';
import { WORKOS_API } from './users.ts';

type ReadKind = NonNullable<StartAttributes<'workos read'>['workos.read']>;

type WriteKind = NonNullable<StartAttributes<'workos write'>['workos.write']>;

const PAGE = '100';

const CALL_LIMIT_MS = 5000;

const ALL_STATUSES = 'active,inactive,pending';

const ALREADY_RAN: Partial<Record<WorkosStep['step'], string>> = {
  createPermission: 'permission_slug_conflict',
  createRole: 'role_slug_conflict',
};

const Slug = z.object({ slug: z.string() });
const Permission = z.object({ slug: z.string(), description: z.string().nullable() });
const Role = z.object({ slug: z.string(), permissions: z.array(z.string()) });
const Organization = z.object({ id: z.string() });
const Membership = z.object({ role: Slug.nullish(), roles: z.array(Slug).nullish() });

export function workosPublish(apiKey: string, options: { readonly fetch?: typeof globalThis.fetch } = {}): WorkosPort {
  const fetch = options.fetch ?? globalThis.fetch;

  const send = (method: string, path: string, body?: object): AsyncFallible<Response, Failure> =>
    attempt(
      () =>
        fetchOrUnavailable(fetch, `${WORKOS_API}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(CALL_LIMIT_MS),
        }),
      outsideFailure,
    );

  const read = <T>(kind: ReadKind, path: string, schema: z.ZodType<T>): AsyncFallible<T, Failure> =>
    tracedFallible('workos read', { 'workos.read': kind }, async function* (s): AsyncFallible<T, Failure> {
      const response = yield* send('GET', path);

      s.set('http.status_code', response.status);

      const body: unknown = response.ok ? yield* attempt(() => jsonOrUndefined(response), outsideFailure) : undefined;
      const parsed = schema.safeParse(body);

      if (!parsed.success) return yield workosUnavailable();

      return parsed.data;
    });

  async function* items<T>(
    kind: ReadKind,
    path: string,
    item: z.ZodType<T>,
    query: Record<string, string> = {},
  ): FallibleStream<T, Failure> {
    let after: string | undefined;

    do {
      const found = await settle(
        read(
          kind,
          `${path}?${new URLSearchParams({ ...query, limit: PAGE, order: 'asc', ...(after ? { after } : {}) }).toString()}`,
          workosPage(item),
        ),
      );

      if (!found.ok) return found.error;

      yield* found.value.data;

      after = found.value.list_metadata?.after ?? undefined;
    } while (after);

    return undefined;
  }

  const roles = async function* (): AsyncFallible<Map<RoleSlug, ReadonlySet<string>>, Failure> {
    const list = yield* read('roles', '/authorization/roles', workosPage(Role));

    if (list.list_metadata?.after) return yield workosUnavailable();

    return new Map(list.data.map((role) => [role.slug, new Set(role.permissions)]));
  };

  const write = (
    kind: WriteKind,
    method: string,
    path: string,
    body: object,
    alreadyRan?: string,
  ): AsyncFallible<void, Failure> =>
    tracedFallible('workos write', { 'workos.write': kind }, async function* (s): AsyncFallible<void, Failure> {
      const response = yield* send(method, path, body);

      s.set('http.status_code', response.status);

      const answer: unknown = yield* attempt(() => jsonOrUndefined(response), outsideFailure);

      if (response.ok) return;

      if (
        response.status === 409 &&
        alreadyRan !== undefined &&
        z.object({ code: z.literal(alreadyRan) }).safeParse(answer).success
      )
        return;

      return yield workosUnavailable();
    });

  return {
    read: async function* (): AsyncFallible<WorkosRoles, Failure> {
      const permissions = new Map<string, string>();
      const found = items('permissions', '/authorization/permissions', Permission);

      for (;;) {
        const next = yield* step(found);

        if (next.done) break;

        permissions.set(next.value.slug, next.value.description ?? '');
      }

      return { permissions, roles: yield* roles() };
    },
    memberRoles: async function* (): FallibleStream<readonly RoleSlug[], Failure> {
      const organizations = items('organizations page', '/organizations', Organization);

      for (;;) {
        const organization = await settle(step(organizations));

        if (!organization.ok) return organization.error;

        if (organization.value.done) return undefined;

        const memberships = items('memberships page', '/user_management/organization_memberships', Membership, {
          organization_id: organization.value.value.id,
          statuses: ALL_STATUSES,
        });

        for (;;) {
          const membership = await settle(step(memberships));

          if (!membership.ok) return membership.error;

          if (membership.value.done) break;

          const slugs = roleSlugs(membership.value.value);

          if (slugs.length === 0) return workosUnavailable();

          yield slugs;
        }
      }
    },
    apply: async function* (stepToApply): AsyncFallible<void, Failure> {
      const [method, path, body] = yield* request(stepToApply);

      return yield* write(stepToApply.step, method, path, body, ALREADY_RAN[stepToApply.step]);
    },
    setPermissions: async function* (role, permissions): AsyncFallible<void, Failure> {
      const path = yield* segment(role);

      return yield* write('setPermissions', 'PUT', `/authorization/roles/${path}/permissions`, { permissions });
    },
  };
}

function* request(step: WorkosStep): Fallible<[string, string, object], ApiError> {
  switch (step.step) {
    case 'createPermission':
      return ['POST', '/authorization/permissions', { slug: step.permission, name: step.permission }];
    case 'setDescription':
      return [
        'PATCH',
        `/authorization/permissions/${yield* segment(step.permission)}`,
        { description: step.description },
      ];
    case 'createRole':
      return ['POST', '/authorization/roles', { slug: step.role, name: step.role }];
    case 'addPermission':
      return ['POST', `/authorization/roles/${yield* segment(step.role)}/permissions`, { slug: step.permission }];
  }
}

function* segment(slug: string): Fallible<string, ApiError> {
  const encoded = encodeURIComponent(slug);

  if (encoded === '' || new URL(`${WORKOS_API}/${encoded}/x`).pathname !== `/${encoded}/x`) {
    return yield new ApiError(400, 'Default:InvalidArgument', {
      part: 'grants',
      problems: [`WorkOS refuses the slug ${JSON.stringify(slug)}.`],
    });
  }

  return encoded;
}

function roleSlugs({ role, roles }: z.infer<typeof Membership>): RoleSlug[] {
  return [...new Set([...(role ? [role] : []), ...(roles ?? [])].map(({ slug }) => slug))];
}
