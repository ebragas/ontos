# The Ontology MCP accepts only AuthKit tokens for its own URL

[ADR 0012](./0012-people-sign-in-with-workos-authkit-in-an-organization-and-ci-only-publishes.md) describes WorkOS AuthKit sign-in (one of the three `IdentityProvider` modes in Ontos v1.0 alongside `dev` and `oidc`). This decision separates MCP tokens from API tokens in `workos` mode. The MCP route accepts only a token from the AuthKit domain of the environment, with `aud` equal to its MCP URL. The OSDK HTTP API v2 routes and the publish route refuse the AuthKit issuer, and keep the `client_id` check of ADR 0012, with no rule on `aud`. So an MCP token cannot call an OSDK HTTP API v2 route, and a CLI or web app token cannot call the MCP route. A Resource Indicator can never lock out the CLI or a web app, also when WorkOS adds an `aud` to their tokens. [Ontology MCP tokens](../service/authentication.md#ontology-mcp-tokens) states the rules.

## Considered Options

- An OSDK-route rule that refuses each WorkOS token with an `aud`. If WorkOS adds an `aud` to CLI and web app tokens once a default Resource Indicator exists, it refuses each CLI and web app call. A turn-off leaves the Resource Indicator, so a turn-off does not undo it.
- One token kind for all routes. An MCP client then gets a token that also calls the OSDK HTTP API v2 routes, and a CLI token calls the MCP route with no consent screen.
- A client allowlist on the MCP route. The guard is already the person, who must be invited and must approve the client on the consent screen.
- A scope check. A CIMD client gets only `openid profile email offline_access`, so no scope separates MCP calls.

## Consequences

- Each MCP URL is 1 Resource Indicator in its WorkOS environment. A customer domain can come later as a second Resource Indicator.
- When a person removes the Resource Indicator in the WorkOS dashboard, each MCP call gets `401`, and the smoke checks still pass. Recreate the Resource Indicator with the exact MCP URL to restore access.
- 1 person has 1 user ID across the CLI, the web app, and the MCP, because each token gives the WorkOS user ID as `sub`.
