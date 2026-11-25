import type { ApiError, AsyncFallible, FallibleStream, Fault } from '../../errors/index.ts';
import type { PermissionSlug } from '../../ontology/index.ts';

export type RoleSlug = string;

export interface WorkosRoles {
  readonly permissions: ReadonlyMap<PermissionSlug, string>;
  readonly roles: ReadonlyMap<RoleSlug, ReadonlySet<PermissionSlug>>;
}

export type WorkosStep =
  | { readonly step: 'createPermission'; readonly permission: PermissionSlug }
  | { readonly step: 'setDescription'; readonly permission: PermissionSlug; readonly description: string }
  | { readonly step: 'createRole'; readonly role: RoleSlug }
  | { readonly step: 'addPermission'; readonly role: RoleSlug; readonly permission: PermissionSlug };

export type WorkosFailure = ApiError | Fault;

export interface WorkosPort {
  read(): AsyncFallible<WorkosRoles, WorkosFailure>;
  memberRoles(): FallibleStream<readonly RoleSlug[], WorkosFailure>;
  apply(step: WorkosStep): AsyncFallible<void, WorkosFailure>;
  setPermissions(role: RoleSlug, permissions: readonly PermissionSlug[]): AsyncFallible<void, WorkosFailure>;
}

export interface RoleList {
  readonly role: RoleSlug;
  readonly permissions: readonly PermissionSlug[];
  readonly create: boolean;
}
