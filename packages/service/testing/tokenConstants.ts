import { OrganizationId, UserId } from '../src/auth/caller.ts';

/** The `sub` of the default WorkOS test token. */
export const PERSON = UserId.parse('user_01TEST00000000000000000001');

export const ORGANIZATION = OrganizationId.parse('org_01TEST0RG00000000000000001');

export const OTHER_ORGANIZATION = OrganizationId.parse('org_01TEST0RG00000000000000002');

/** The AuthKit domain of the test environment, with no `https://`. The AuthKit issuer is `https://` plus it. */
export const AUTHKIT_DOMAIN = 'test-app.authkit.app';

/** The client ID of the test service user, the `sub` of the default M2M token: `client_` and 26 uppercase letters and digits. */
export const SERVICE_USER = UserId.parse('client_01JSERV1CEUSER0000000000AB');

/** The `client_id` of the default AuthKit token: an MCP client that registered through CIMD. */
export const MCP_CLIENT = 'https://claude.ai/.well-known/oauth-client-metadata.json';
