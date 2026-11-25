import type { User } from '@osdk/foundry.admin';
import { ApiError, caught, settle, type AsyncFallible } from '../../errors/index.ts';
import { OrganizationId, UserId, type Caller } from '../caller.ts';
import type { Permission } from '../permissions.ts';
import { NO_STORE, oauthError, readClientCredentialsForm } from '../token.ts';
import type { UserSource } from '../users.ts';
import { tracedFallible } from '../workosCalls.ts';
import type { Failure } from '../workosErrors.ts';
import { bearerAuth, constantTimeEqual, noopWorkosPublish } from './shared.ts';
import type { IdentityProvider } from './types.ts';

export const DEV_USER_ID: UserId = UserId.parse('user_dev');
export const DEV_ORG_ID: OrganizationId = OrganizationId.parse('org_dev');
export const DEFAULT_DEV_TOKEN = 'ontos-dev-token';

const DEV_USER: User = {
  id: DEV_USER_ID,
  username: 'dev@ontos.local',
  email: 'dev@ontos.local',
  givenName: 'Dev',
  familyName: 'User',
  realm: 'dev',
  status: 'ACTIVE',
  attributes: {},
};

const DEV_ORGANIZATION = { id: DEV_ORG_ID, name: 'Local Dev' } as const;

export interface DevIdentityOptions {
  readonly token?: string;
}

// oxlint-disable-next-line require-yield -- synthetic local dev data returns immediately without external I/O.
async function* immediate<T>(value: T): AsyncFallible<T, Failure> {
  return value;
}

function devUsers(): UserSource {
  return {
    get: (userId) => immediate(userId === DEV_USER_ID ? DEV_USER : undefined),
    members: (userIds, organization) =>
      immediate(
        organization === DEV_ORG_ID && userIds.includes(DEV_USER_ID)
          ? new Map<string, User>([[DEV_USER_ID, DEV_USER]])
          : new Map<string, User>(),
      ),
    organizations: (userId) => immediate(userId === DEV_USER_ID ? [DEV_ORGANIZATION] : []),
    organization: (id) => immediate(id === DEV_ORG_ID ? DEV_ORGANIZATION : undefined),
    permissions: async function* (user, organization): AsyncFallible<readonly Permission[], Failure> {
      if (user === DEV_USER_ID && organization === DEV_ORG_ID) return ['*'];

      return yield new ApiError(403, 'Default:PermissionDenied');
    },
    membership: async function* (user, organization): AsyncFallible<void, Failure> {
      if (user === DEV_USER_ID && organization === DEV_ORG_ID) return;

      return yield new ApiError(403, 'Default:PermissionDenied');
    },
    applications: () => immediate(undefined),
  };
}

function basicSecret(request: Request): string | undefined {
  const header = request.headers.get('authorization');

  if (!header?.startsWith('Basic ')) return undefined;

  const decoded = caught(() => Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'));

  if (!decoded.ok) return undefined;

  const colon = decoded.value.indexOf(':');

  return colon === -1 ? undefined : decoded.value.slice(colon + 1);
}

export function devIdentityProvider(options: DevIdentityOptions = {}): IdentityProvider {
  const configured = options.token?.trim();
  const token = configured && configured !== '' ? configured : DEFAULT_DEV_TOKEN;
  const customToken = token !== DEFAULT_DEV_TOKEN;

  return {
    mode: 'dev',
    users: devUsers(),
    workos: noopWorkosPublish(),
    authenticate: (request, { access, known }) =>
      bearerAuth(request, (presented) => {
        if (!constantTimeEqual(presented, token)) return immediate(undefined);

        const caller: Caller =
          access === 'publish'
            ? { user: DEV_USER_ID, kind: 'publish' }
            : { user: DEV_USER_ID, kind: 'person', organization: DEV_ORG_ID };

        known?.({ user: caller.user, kind: caller.kind });

        return immediate(caller);
      }),
    authenticateMcp: (request) =>
      bearerAuth(request, (presented) =>
        immediate(
          constantTimeEqual(presented, token)
            ? { user: DEV_USER_ID, kind: 'person', organization: DEV_ORG_ID, clientId: 'dev-client' }
            : undefined,
        ),
      ),
    tokenRoute: async function* (request): AsyncFallible<Response, ApiError> {
      const read = await caught(() => readClientCredentialsForm(request));

      if (!read.ok) return oauthError(400, 'invalid_request');

      if (read.value instanceof Response) return read.value;

      if (read.value.get('grant_type') !== 'client_credentials') return oauthError(400, 'unsupported_grant_type');

      if (customToken) {
        const presented = read.value.get('client_secret') ?? basicSecret(request);

        if (presented === undefined || !constantTimeEqual(presented, token))
          return Response.json({ error: 'invalid_client' }, { status: 401, headers: NO_STORE });
      }

      const spanned = await caught(() =>
        settle(
          tracedFallible('workos token', {}, (live) => {
            live.set('http.status_code', 200);

            return immediate(
              Response.json(
                { access_token: token, token_type: 'Bearer', expires_in: 3600 },
                { status: 200, headers: NO_STORE },
              ),
            );
          }),
        ),
      );

      if (!spanned.ok || !spanned.value.ok) return yield new ApiError(500, 'Default:Internal');

      return spanned.value.value;
    },
  };
}
