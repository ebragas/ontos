import { ApiError, type AsyncFallible, type Fallible } from '../errors/index.ts';
import type { Caller, DataCaller, OrganizationId, PersonCaller, ServiceCaller, UserId } from './caller.ts';
import { dataCaller, type PermissionSource } from './permissions.ts';
import type { Failure } from './workosErrors.ts';

export type OrganizationData = (PersonCaller & { readonly organization: OrganizationId }) | ServiceCaller;

export function* organizationCaller(caller: Caller): Fallible<OrganizationData, ApiError> {
  const data = yield* dataCaller(caller);

  if (data.kind === 'service') return data;

  const { organization } = data;

  if (organization === undefined) return yield new ApiError(403, 'OntologyService:NoOrganization');

  return { ...data, organization };
}

export type MembershipCheck = (
  user: UserId,
  organization: OrganizationId,
  signal?: AbortSignal,
) => AsyncFallible<void, Failure>;

interface MembershipSource {
  readonly membership?: MembershipCheck;
  readonly permissions: PermissionSource;
}

export async function* memberCaller(
  caller: DataCaller,
  source: MembershipSource,
  signal?: AbortSignal,
): AsyncFallible<OrganizationData, Failure> {
  if (caller.kind === 'service') return caller;

  const person = yield* organizationCaller(caller);

  if (person.permissions !== undefined) return person;

  if (source.membership !== undefined) yield* source.membership(person.user, person.organization, signal);
  else yield* source.permissions(person.user, person.organization, signal);

  return person;
}
