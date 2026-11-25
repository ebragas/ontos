# People sign in with WorkOS AuthKit in an Organization, and CI only publishes

The Ontology service must know who sends each request, and whose data that caller can reach. People and agents call it through the CLI. Web apps call it through the Ontology SDK, with a person's token, as [ADR 0007](./0007-consumers-get-the-ontology-sdk-as-a-package.md) says. The Ontology MCP calls it with a person's token, as [ADR 0011](./0011-the-ontology-mcp-accepts-only-authkit-tokens-for-its-own-url.md) says. CI workflows call it directly. One Ontology service deployment serves many companies, and the data of each company is separate from the data of every other company.

Ontos v1.0 implements this authentication architecture behind a pluggable `IdentityProvider` interface supporting three modes: `dev` for local development, `oidc` for any OIDC/JWKS identity provider, and `workos` for WorkOS AuthKit and Organizations (see [Authentication](../service/authentication.md)). This ADR records the original hosted `workos` provider design.

In `workos` mode, each app gets one WorkOS project, and its people sign in through WorkOS AuthKit. AuthKit has a device flow for the CLI, and it is an OAuth server for MCP clients. Each company is 1 WorkOS Organization, and a person works in 1 Organization at a time. A service user, which is a WorkOS M2M application of 1 Organization, reads and writes data with no person, as [ADR 0014](./0014-workos-holds-the-permissions-of-each-caller-and-a-service-user-reads-and-writes-data.md) says. CI publishes a product with a GitHub Actions OIDC token, and reads or writes no Ontology data. The Ontology service checks both kinds of token by JWKS, and stores no secret for them.

## Decision

- An Organization is one company and the boundary of its data. In `workos` mode it is 1 WorkOS Organization. A person can be in many Organizations, and each session has 1 active Organization. A switch is a token refresh. A person has 1 role in each Organization, and the identity provider holds the permissions of each role, as [ADR 0014](./0014-workos-holds-the-permissions-of-each-caller-and-a-service-user-reads-and-writes-data.md) says.
- A product is a versioned Ontology definition with no data. CI publishes it. An Ontology is 1 installation of 1 product, with its own RID and exactly 1 owner Organization. A person or a service user of that Organization that holds the permission `ontology:install` installs it. No Ontology is shared between Organizations.
- Each call that reads or writes Ontology data carries a token scoped to an Organization: the token of a person, or of a service user. The Ontology service serves a RID only when the token's Organization owns it. Each other RID gets the same 404 as an unknown RID.
- A GitHub Actions OIDC token only publishes: the publish job, and the pull request check with `validateOnly`.
- CI tests against non-production environments sign in as a dedicated test user in a test Organization.

## Considered Options

- Personal API tokens. They need the fewest parts, but OSDK recommends against user API tokens in production applications. Web apps and the Ontology MCP need an identity provider anyway.
- Neon Auth (Managed Better Auth). Users would stay in Neon, and Neon does not allow custom Better Auth plugins. It also lacks a device flow, passkeys, and a user API with a server key for CLI sign-in. Source: [OAuth Provider](https://neon.com/docs/auth/guides/plugins/oauth-provider.md).
- Better Auth with its MCP and CIMD plugins, inside the Ontology service. Its docs meet the MCP needs, but the Ontology service then becomes an OAuth server that owns signing keys and refresh token rotation.
- Supabase Auth. Its tokens carry `aud: "authenticated"`, it ignores the `resource` that MCP clients send, it has no CIMD, and its loopback redirects must match the port.
- Auth0. It meets the MCP needs, but each Claude client needs a manual CIMD import, or Dynamic Client Registration must be on.
- GitHub tokens that read and write data for CI and for consumer repositories. Such a token carries no Organization, so its data would belong to no company.
- One Ontology service deployment for each Organization. Each sign-up would then need new automation that creates a deployment.
- An Ontology that several Organizations share. OSDK allows it, but then the Ontology is no longer the boundary of a company's data.

## Consequences

- In `workos` mode, the WorkOS project of each app is the only list of the people who have access, and WorkOS holds each membership. The Ontology service keeps no copy. The user ID of a person is the WorkOS user ID.
- A move to another identity provider changes every user ID, so it must map the old IDs to the new ones.
- A person signs in again when the refresh token expires, after 7 days by default.
- When a person is removed from an Organization or from WorkOS, their access ends within 60 seconds when WorkOS answers, and within 5 minutes when it fails.
- A custom sign-in domain changes the token issuer. V1 uses none by default.
- An app with self-serve sign-up turns sign-up on in its WorkOS environment. Apps with invite-only access keep it off.
- No CI job reads or writes production data, because the production environment of an app has no test user.
