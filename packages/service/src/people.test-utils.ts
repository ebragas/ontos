import type { UserSource, WorkosUser } from './auth/index.ts';
import { ORGANIZATION, PERSON } from './tokens.test-utils.ts';
import { STUB_PERSON, stubUsers, type StubMembership, type StubOptions } from './workos.test-utils.ts';

export type RolePermissions = Readonly<Record<string, readonly string[]>>;

export const NO_ROLE = 'user_01HN0R01E000000000000000NR';

export function personOf(role: string): string {
  return role === 'member'
    ? PERSON
    : `user_01HR01E${Array.from(role)
        .map((char) => char.codePointAt(0)?.toString(16))
        .join('')}`;
}

export function claimsOf(role: string): { readonly sub: string } {
  return { sub: personOf(role) };
}

export function roleMembers(roles: RolePermissions): [readonly WorkosUser[], readonly StubMembership[], StubOptions] {
  const slugs = [...new Set(['member', ...Object.keys(roles)])];

  const users = [
    STUB_PERSON,
    ...slugs
      .filter((slug) => slug !== 'member')
      .map((slug) => ({ ...STUB_PERSON, id: personOf(slug), email: `${slug}@example.com` })),
    { ...STUB_PERSON, id: NO_ROLE, email: 'none@example.com' },
  ];

  const memberships: StubMembership[] = slugs.map((slug) => ({
    user_id: personOf(slug),
    organization_id: ORGANIZATION,
    status: 'active',
    organization_name: 'Test Organization',
    roles: [slug],
  }));

  memberships.push({
    user_id: NO_ROLE,
    organization_id: ORGANIZATION,
    status: 'active',
    organization_name: 'Test Organization',
    roles: [],
  });

  return [users, memberships, { roles: { [ORGANIZATION]: { member: [], ...roles } } }];
}

export function roleUsers(roles: RolePermissions): UserSource {
  return stubUsers(...roleMembers(roles));
}
