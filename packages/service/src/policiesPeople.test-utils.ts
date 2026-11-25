import type { OntologyIr } from '@osdk/client.unstable';
import type { UserSource } from './auth/index.ts';
import type { GrantsFile } from './ontology/index.ts';
import { grantsOf, USE } from './ontology/stored.test-utils.ts';
import type { RolePermissions } from './people.test-utils.ts';
import { ORGANIZATION } from './tokens.test-utils.ts';
import { STUB_PERSON, stubUsers } from './workos.test-utils.ts';

export interface PolicyPerson {
  readonly sub: string;
  readonly role?: string;
}

export interface AsPerson {
  readonly claims: { readonly sub: string };
  readonly users: UserSource;
}

export function asPerson(person: PolicyPerson, roles: RolePermissions): AsPerson {
  const user = { ...STUB_PERSON, id: person.sub, email: 'person@example.com' };

  const memberships = [
    {
      user_id: person.sub,
      organization_id: ORGANIZATION,
      status: 'active' as const,
      organization_name: 'Test Organization',
      roles: person.role === undefined ? [] : [person.role],
    },
  ];

  return { claims: { sub: person.sub }, users: stubUsers([user], memberships, { roles: { [ORGANIZATION]: roles } }) };
}

export function policyPeople<P extends string>(
  people: Readonly<Record<P, PolicyPerson>>,
  roles: RolePermissions,
): Readonly<Record<P, AsPerson>> {
  return Object.fromEntries(
    Object.entries<PolicyPerson>(people).map(([name, person]) => [name, asPerson(person, roles)]),
  ) as Record<P, AsPerson>;
}

export function groupGrants(ir: OntologyIr, roles: RolePermissions): GrantsFile {
  const grants = grantsOf(ir);

  const slugs = [...new Set(Object.values(roles).flat())].filter(
    (slug) => slug !== 'ontology:install' && !(slug in grants.permissions),
  );

  return {
    ...grants,
    permissions: {
      ...grants.permissions,
      ...Object.fromEntries(slugs.map((slug) => [slug, { description: `The group ${slug}` }])),
    },
    defaultRoles: roles,
  };
}

export const PROPERTY_ROLES = {
  admin: ['ontology:install', USE, 'admin'],
  member: [USE, 'member'],
  guest: [USE, 'guest'],
  auditor: [USE, 'auditor'],
} as const satisfies RolePermissions;
