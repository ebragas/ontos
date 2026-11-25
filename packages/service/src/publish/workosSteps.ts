import { ApiError, caught, step, type AsyncFallible } from '../errors/index.ts';
import { SERVICE_PERMISSION_DESCRIPTIONS, type GrantsFile, type PermissionSlug } from '../ontology/index.ts';
import type { RoleList, RoleSlug, WorkosFailure, WorkosPort, WorkosRoles, WorkosStep } from './workos/types.ts';

export * from './workos/types.ts';

export function planWorkosSteps(grants: GrantsFile, workos: WorkosRoles, stored: ReadonlySet<RoleSlug>): WorkosStep[] {
  const wanted = new Map(Object.entries(grants.permissions).map(([slug, { description }]) => [slug, description]));

  for (const slug of Object.values(grants.defaultRoles).flat()) {
    if (Object.hasOwn(SERVICE_PERMISSION_DESCRIPTIONS, slug))
      wanted.set(slug, SERVICE_PERMISSION_DESCRIPTIONS[slug] ?? '');
  }

  const permissions = [...wanted.keys()].sort();

  const roles = Object.keys(grants.defaultRoles)
    .filter((role) => stored.has(role))
    .sort();

  return [
    ...permissions
      .filter((permission) => !workos.permissions.has(permission))
      .map((permission): WorkosStep => ({ step: 'createPermission', permission })),
    ...permissions.flatMap((permission): WorkosStep[] => {
      const description = wanted.get(permission) ?? '';

      return (workos.permissions.get(permission) ?? '') === description
        ? []
        : [{ step: 'setDescription', permission, description }];
    }),
    ...roles.filter((role) => !workos.roles.has(role)).map((role): WorkosStep => ({ step: 'createRole', role })),
    ...roles.flatMap((role) =>
      [...new Set(grants.defaultRoles[role])]
        .sort()
        .filter((permission) => !workos.roles.get(role)?.has(permission))
        .map((permission): WorkosStep => ({ step: 'addPermission', role, permission })),
    ),
  ];
}

export function droppedRoles(newest: GrantsFile | undefined, grants: GrantsFile): RoleSlug[] {
  return Object.keys(newest?.defaultRoles ?? {})
    .filter((role) => !Object.hasOwn(grants.defaultRoles, role))
    .sort();
}

export async function* refuseRoleInUse(
  port: WorkosPort,
  dropped: readonly RoleSlug[],
): AsyncFallible<void, WorkosFailure> {
  if (dropped.length === 0) return;

  const members = port.memberRoles();

  try {
    for (;;) {
      const next = yield* step(members);

      if (next.done) return;

      const held = next.value.find((role) => dropped.includes(role));

      if (held !== undefined) return yield new ApiError(409, 'OntologyService:RoleInUse', { role: held });
    }
  } finally {
    await caught(() => members.return(undefined));
  }
}

export function planReconcile(newest: GrantsFile, named: Iterable<RoleSlug>, workos: WorkosRoles): RoleList[] {
  const roles = [...new Set([...named, ...Object.keys(newest.defaultRoles)])].sort();

  return roles.flatMap((role): RoleList[] => {
    const permissions = [...new Set(givenTo(newest, role))].sort();
    const held = workos.roles.get(role);

    if (!held) return Object.hasOwn(newest.defaultRoles, role) ? [{ role, permissions, create: true }] : [];

    const same = permissions.length === held.size && permissions.every((permission) => held.has(permission));

    return same ? [] : [{ role, permissions, create: false }];
  });
}

function givenTo(grants: GrantsFile, role: RoleSlug): readonly PermissionSlug[] {
  return Object.hasOwn(grants.defaultRoles, role) ? (grants.defaultRoles[role] ?? []) : [];
}
