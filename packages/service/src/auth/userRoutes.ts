import type { GetUsersBatchResponse, User } from '@osdk/foundry.admin';
import { ApiError, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { RouteInput } from '../handler/index.ts';
import type { DataCaller, PersonCaller } from './caller.ts';
import { permittedCaller } from './permissions.ts';
import type { CallerProfile } from './providers/types.ts';
import type { UserSource } from './users.ts';
import { workosFault, type Failure } from './workosErrors.ts';

type UserStatus = User['status'];

export const MAX_BATCH = 500;

function syntheticUser(caller: PersonCaller & { readonly profile: CallerProfile }): User {
  const { profile } = caller;

  return {
    id: caller.user,
    username: profile.username,
    ...(profile.email === undefined ? {} : { email: profile.email }),
    ...(profile.givenName === undefined ? {} : { givenName: profile.givenName }),
    ...(profile.familyName === undefined ? {} : { familyName: profile.familyName }),
    realm: profile.realm,
    status: 'ACTIVE',
    attributes: {},
  };
}

export async function* getUser(
  input: RouteInput,
  users: UserSource,
  caller: DataCaller,
): AsyncFallible<Response, Failure> {
  const { organization } = yield* permittedCaller(caller, users.permissions, input.signal);
  const status = yield* requestedStatus(input.query.get('status') ?? undefined);
  const userId = input.params.userId ?? '';

  const found = (yield* users.members([userId], organization, input.signal)).get(userId);

  const user =
    found ??
    (caller.kind === 'person' && caller.profile !== undefined && userId === caller.user
      ? syntheticUser({ ...caller, profile: caller.profile })
      : undefined);

  if (!user) return yield new ApiError(404, 'UserNotFound', { userId });

  if (user.status !== status)
    return yield new ApiError(400, status === 'ACTIVE' ? 'UserDeleted' : 'UserIsActive', { principalId: userId });

  return Response.json(user);
}

export async function* getCurrentUser(
  input: RouteInput,
  users: UserSource,
  caller: DataCaller,
): AsyncFallible<Response, Failure> {
  if (caller.kind === 'person' && caller.profile !== undefined)
    return Response.json(syntheticUser({ ...caller, profile: caller.profile }));

  const user =
    caller.kind === 'service'
      ? (yield* users.members([caller.user], caller.organization, input.signal)).get(caller.user)
      : yield* users.get(caller.user, input.signal);

  if (!user) return yield new ApiError(404, 'UserNotFound', { userId: caller.user });

  return Response.json(user);
}

export async function* getUsersBatch(
  input: RouteInput,
  users: UserSource,
  caller: DataCaller,
): AsyncFallible<Response, Failure> {
  const { organization } = yield* permittedCaller(caller, users.permissions, input.signal);
  const requested = yield* batchRequest(input.body);
  const foundMap = new Map(yield* users.members([...requested.keys()], organization, input.signal));

  if (
    caller.kind === 'person' &&
    caller.profile !== undefined &&
    requested.has(caller.user) &&
    !foundMap.has(caller.user)
  )
    foundMap.set(caller.user, syntheticUser({ ...caller, profile: caller.profile }));

  const found = foundMap.values();
  const isRequested = (user: User) => requested.get(user.id)?.has(user.status);

  const body: GetUsersBatchResponse = {
    data: Object.fromEntries([...found].flatMap((user) => (isRequested(user) ? [[user.id, user]] : []))),
  };

  return Response.json(body);
}

function* batchRequest(body: unknown): Fallible<Map<string, Set<UserStatus>>, ApiError> {
  if (!Array.isArray(body) || body.length === 0 || body.length > MAX_BATCH)
    return yield new ApiError(400, 'Default:InvalidArgument');

  const requested = new Map<string, Set<UserStatus>>();

  for (const element of body as unknown[]) {
    const { userId, status } = (typeof element === 'object' && element !== null ? element : {}) as {
      userId?: unknown;
      status?: unknown;
    };

    if (typeof userId !== 'string') return yield new ApiError(400, 'Default:InvalidArgument');

    requested.set(userId, (requested.get(userId) ?? new Set<UserStatus>()).add(yield* requestedStatus(status)));
  }

  return requested;
}

function* requestedStatus(status: unknown): Fallible<UserStatus, ApiError> {
  if (status === undefined) return 'ACTIVE';

  if (status === 'ACTIVE' || status === 'DELETED') return status;

  return yield new ApiError(400, 'Default:InvalidArgument');
}

export async function* listOrganizations(
  input: RouteInput,
  users: UserSource,
  caller: DataCaller,
): AsyncFallible<Response, Failure> {
  if (caller.kind === 'person' && caller.profile !== undefined)
    return Response.json({ data: caller.organization === undefined ? [] : [{ id: caller.organization }] });

  if (caller.kind === 'service') {
    const organization = yield* users.organization(caller.organization, input.signal);

    if (!organization)
      return yield workosFault(`WorkOS does not find the Organization ${caller.organization} of a service user.`);

    return Response.json({ data: [organization] });
  }

  return Response.json({ data: yield* users.organizations(caller.user, input.signal) });
}
