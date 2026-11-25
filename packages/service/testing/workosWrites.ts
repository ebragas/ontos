import { attempt, type AsyncFallible } from '../src/errors/index.ts';
import type { StubApplication, StubFailure, StubOptions } from './workosTypes.ts';

const rejection = (error: unknown): unknown => error;

type StoredApplication = StubApplication & { readonly id: string };

interface WorkosWriteState {
  readonly applications: Map<string, StoredApplication>;
  readonly secrets: Map<string, string>;
  readonly permissions: Map<string, string | null>;
  readonly environmentRoles: Map<string, string[]>;
  readonly options: StubOptions;
  readonly clientIdOf: (id: string) => string | undefined;
  readonly nextCreated: () => number;
}

export function applicationJson(clientId: string, app: StoredApplication) {
  const now = new Date(0).toISOString();

  return {
    object: 'connect_application',
    client_id: clientId,
    description: null,
    ...app,
    created_at: now,
    updated_at: now,
  };
}

export function handleWorkosWrite(state: WorkosWriteState, method: string, path: string, body: unknown): Response {
  const { applications, secrets, permissions, environmentRoles, options, clientIdOf, nextCreated } = state;
  const { slug, description } = (body ?? {}) as { slug?: string; description?: string };
  const app = /^\/connect\/applications\/([^/]+)(\/client_secrets)?$/.exec(path);

  if (method === 'POST' && path === '/connect/applications') {
    const { name, application_type, organization_id } = (body ?? {}) as {
      name?: unknown;
      application_type?: unknown;
      organization_id?: unknown;
    };

    if (typeof name !== 'string' || application_type !== 'm2m' || typeof organization_id !== 'string')
      return Response.json({ code: 'invalid_request' }, { status: 422 });

    const suffix = String(nextCreated()).padStart(10, '0');
    const clientId = `client_01JGATESERV1CEUS${suffix}`;

    const made = {
      id: `connect_app_01JGATESERV1CEAPP0${suffix}`,
      name,
      application_type,
      organization_id,
      scopes: [],
    };

    applications.set(clientId, made);

    return Response.json(applicationJson(clientId, made), { status: 201 });
  }

  const clientId = app ? clientIdOf(decodeURIComponent(app[1] ?? '')) : undefined;
  const found = clientId === undefined ? undefined : applications.get(clientId);

  if (app && (clientId === undefined || !found))
    return Response.json({ code: 'entity_not_found', message: 'Application not found.' }, { status: 404 });

  if (app && clientId !== undefined && found) {
    if (method === 'PUT' && app[2] === undefined) {
      const scopes = (body as { scopes?: unknown } | undefined)?.scopes;

      if (!Array.isArray(scopes) || !scopes.every((each) => typeof each === 'string' && permissions.has(each))) {
        return Response.json({ code: 'invalid_permission_slug', message: 'Permission not found.' }, { status: 422 });
      }

      const changed = { ...found, scopes: [...scopes] as string[] };

      applications.set(clientId, changed);

      return Response.json(applicationJson(clientId, changed));
    }

    if (method === 'POST' && app[2] !== undefined) {
      const secret = options.clientSecret ?? 'stub-client-secret';

      secrets.set(clientId, secret);

      return Response.json(
        { object: 'connect_application_secret', id: `secret_${clientId}`, secret, secret_hint: secret.slice(-4) },
        { status: 201 },
      );
    }

    if (method === 'DELETE' && app[2] === undefined) {
      applications.delete(clientId);

      secrets.delete(clientId);

      return new Response(null, { status: 204 });
    }
  }

  const role = /^\/authorization\/roles\/([^/]+)\/permissions$/.exec(path);
  const permission = /^\/authorization\/permissions\/([^/]+)$/.exec(path);

  if (method === 'POST' && path === '/authorization/permissions' && slug !== undefined) {
    if (permissions.has(slug))
      return Response.json(
        { code: 'permission_slug_conflict', message: 'Permission slug already in use.' },
        { status: 409 },
      );

    permissions.set(slug, null);

    return Response.json({ object: 'permission', slug, name: slug, description: null }, { status: 201 });
  }

  if (method === 'PATCH' && permission && description !== undefined) {
    const found = decodeURIComponent(permission[1] ?? '');

    if (!permissions.has(found))
      return Response.json({ code: 'entity_not_found', message: 'Permission not found.' }, { status: 404 });

    permissions.set(found, description);

    return Response.json({ object: 'permission', slug: found, name: found, description });
  }

  if (method === 'POST' && path === '/authorization/roles' && slug !== undefined) {
    if (environmentRoles.has(slug))
      return Response.json({ code: 'role_slug_conflict', message: 'Role slug already in use' }, { status: 409 });

    environmentRoles.set(slug, []);

    return Response.json(
      { object: 'role', slug, name: slug, type: 'EnvironmentRole', permissions: [] },
      { status: 201 },
    );
  }

  if (method === 'POST' && role && slug !== undefined) {
    const held = environmentRoles.get(decodeURIComponent(role[1] ?? ''));

    if (!held) return Response.json({ code: 'entity_not_found', message: 'Role not found.' }, { status: 404 });

    if (!permissions.has(slug))
      return Response.json(
        { code: 'invalid_permission_slug', message: `Permission not found: '${slug}'.` },
        { status: 422 },
      );

    if (!held.includes(slug)) held.push(slug);

    return Response.json({
      object: 'role',
      slug: decodeURIComponent(role[1] ?? ''),
      type: 'EnvironmentRole',
      permissions: held,
    });
  }

  if (method === 'PUT' && role) {
    const slugs = (body as { permissions?: unknown } | undefined)?.permissions;
    const found = decodeURIComponent(role[1] ?? '');

    if (!environmentRoles.has(found))
      return Response.json({ code: 'entity_not_found', message: 'Role not found.' }, { status: 404 });

    if (!Array.isArray(slugs) || !slugs.every((each) => typeof each === 'string' && permissions.has(each))) {
      return Response.json({ code: 'invalid_permission_slug', message: 'Permission not found.' }, { status: 422 });
    }

    environmentRoles.set(found, [...slugs] as string[]);

    return Response.json({ object: 'role', slug: found, type: 'EnvironmentRole', permissions: slugs });
  }

  return Response.json({ message: `Cannot ${method} ${path}` }, { status: 404 });
}

export async function* failWorkosRequest(
  kind: StubFailure,
  request: Request,
  retryAfter?: string,
): AsyncFallible<Response, unknown> {
  switch (kind) {
    case 'network':
      return yield new TypeError('fetch failed');
    case '5xx':
      return Response.json({ message: 'Internal Server Error' }, { status: 500 });
    case '429':
      return Response.json(
        { message: 'Too Many Requests' },
        { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
      );
    case 'stalled body': {
      const { signal } = request;

      const body = new ReadableStream<Uint8Array>({
        start: (controller) => signal.addEventListener('abort', () => controller.error(signal.reason)),
      });

      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    case 'timeout': {
      const { signal } = request;

      yield* attempt(
        () =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();

            signal.addEventListener('abort', () => resolve());
          }),
        rejection,
      );

      return yield signal.reason;
    }
  }
}
