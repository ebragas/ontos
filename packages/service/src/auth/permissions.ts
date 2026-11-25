import { ApiError, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { Caller, DataCaller, OrganizationId, PersonCaller, ServiceCaller, UserId } from './caller.ts';
import { organizationCaller } from './membership.ts';
import type { Failure } from './workosErrors.ts';

export * from './membership.ts';

export function* dataCaller(caller: Caller): Fallible<DataCaller, ApiError> {
  if (caller.kind !== 'person' && caller.kind !== 'service') return yield new ApiError(403, 'Default:PermissionDenied');

  return caller;
}

export type Permission = string;

export type PermittedCaller =
  | (PersonCaller & { readonly organization: OrganizationId; readonly permissions: readonly Permission[] })
  | ServiceCaller;

export type PermissionSource = (
  user: UserId,
  organization: OrganizationId,
  signal?: AbortSignal,
) => AsyncFallible<readonly Permission[], Failure>;

export async function* permittedCaller(
  caller: DataCaller,
  permissions: PermissionSource,
  signal?: AbortSignal,
): AsyncFallible<PermittedCaller, Failure> {
  if (caller.kind === 'service') return caller;

  const person = yield* organizationCaller(caller);

  if (person.permissions !== undefined) return { ...person, permissions: person.permissions };

  return { ...person, permissions: yield* permissions(person.user, person.organization, signal) };
}
