import { decodeJwt, errors, jwtVerify, type FetchImplementation, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { attempt, caught, outsideFailure, type AsyncFallible, type Fallible } from '../../errors/index.ts';
import { mcpUrl } from '../authSettings.ts';
import { OrganizationId, UserId, type Caller, type GithubTrust, type PersonCaller } from '../caller.ts';
import { remoteJwks } from '../keys.ts';
import { tokenRoute } from '../token.ts';
import type { UserSource } from '../users.ts';
import { GITHUB_ISSUER } from '../workosCalls.ts';
import type { Failure } from '../workosErrors.ts';
import { bearerAuth, constantTimeEqual, noopWorkosPublish } from './shared.ts';
import type { CallerProfile, IdentityProvider, McpCaller } from './types.ts';

const ASYMMETRIC_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'EdDSA'];
const PUBLISH_TOKEN_USER = UserId.parse('publish_token');

export interface OidcPublishOidcConfig {
  readonly issuer: string;
  readonly jwksUri?: string;
  readonly subject: string;
  readonly audience?: string;
}

export interface OidcPublishConfig {
  readonly token?: string;
  readonly oidc?: OidcPublishOidcConfig;
  readonly github?: GithubTrust;
}

export interface OidcIdentityOptions {
  readonly issuer: string;
  readonly jwksUri?: string;
  readonly audience?: string;
  readonly mcpAudience?: string;
  readonly orgClaim?: string;
  readonly defaultOrg?: string;
  readonly permissionsClaim?: string;
  readonly baseUrl: string;
  readonly publish?: OidcPublishConfig;
  readonly fetch?: FetchImplementation;
}

// oxlint-disable-next-line require-yield -- OIDC identity provider derives user info from token claims without remote directory calls.
async function* immediate<T>(value: T): AsyncFallible<T, Failure> {
  return value;
}

function oidcUsers(): UserSource {
  return {
    get: () => immediate(undefined),
    members: () => immediate(new Map()),
    organizations: () => immediate([]),
    organization: (id) => immediate({ id }),
    permissions: () => immediate([]),
    membership: () => immediate(undefined),
    applications: () => immediate(undefined),
  };
}

function defaultJwksUri(issuer: string): string {
  return `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
}

function* decodeToken(token: string): Fallible<JWTPayload, Failure> {
  const claims = caught(() => decodeJwt(token));

  if (!claims.ok) return yield outsideFailure(claims.error);

  return claims.value;
}

async function* verifyJwt(
  token: string,
  key: JWTVerifyGetKey,
  issuer: string,
  audience?: string,
): AsyncFallible<JWTPayload & { sub: UserId }, Failure> {
  const base = { issuer, algorithms: ASYMMETRIC_ALGORITHMS, requiredClaims: ['exp', 'sub'] };

  const { payload } = yield* attempt(
    () => jwtVerify(token, key, audience === undefined ? base : { ...base, audience }),
    outsideFailure,
  );

  const sub = UserId.safeParse(payload.sub);

  if (!sub.success) return yield outsideFailure(new errors.JWTInvalid('The token has no sub.'));

  return { ...payload, sub: sub.data };
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
}

function extractPermissions(payload: JWTPayload, claim: string): readonly string[] {
  const raw = payload[claim];

  if (Array.isArray(raw)) {
    const valid = raw.filter((item): item is string => typeof item === 'string' && item !== '' && item !== '*');

    return [...new Set(valid)].sort();
  }

  if (typeof raw === 'string') {
    const split = raw
      .trim()
      .split(/\s+/)
      .filter((item) => item !== '' && item !== '*');

    return [...new Set(split)].sort();
  }

  return [];
}

function extractOrganization(
  payload: JWTPayload,
  orgClaim: string,
  defaultOrg: OrganizationId | undefined,
): OrganizationId | undefined {
  const raw = payload[orgClaim];

  if (raw === undefined) return defaultOrg;

  const parsed = OrganizationId.safeParse(raw);

  return parsed.success ? parsed.data : undefined;
}

function profileOf(payload: JWTPayload & { sub: UserId }): CallerProfile {
  const email = stringClaim(payload, 'email');
  const givenName = stringClaim(payload, 'given_name');
  const familyName = stringClaim(payload, 'family_name');
  const username = stringClaim(payload, 'preferred_username') ?? email ?? payload.sub;

  return {
    username,
    ...(email === undefined ? {} : { email }),
    ...(givenName === undefined ? {} : { givenName }),
    ...(familyName === undefined ? {} : { familyName }),
    realm: 'oidc',
  };
}

function personFromPayload(
  payload: JWTPayload & { sub: UserId },
  orgClaim: string,
  defaultOrg: OrganizationId | undefined,
  permissionsClaim: string,
): PersonCaller {
  const organization = extractOrganization(payload, orgClaim, defaultOrg);

  return {
    user: payload.sub,
    kind: 'person',
    ...(organization === undefined ? {} : { organization }),
    permissions: extractPermissions(payload, permissionsClaim),
    profile: profileOf(payload),
  };
}

export function oidcIdentityProvider(options: OidcIdentityOptions): IdentityProvider {
  const jwksUri = options.jwksUri && options.jwksUri !== '' ? options.jwksUri : defaultJwksUri(options.issuer);
  const orgClaim = options.orgClaim && options.orgClaim !== '' ? options.orgClaim : 'org_id';

  const permissionsClaim =
    options.permissionsClaim && options.permissionsClaim !== '' ? options.permissionsClaim : 'permissions';

  const defaultOrgParsed = OrganizationId.safeParse(options.defaultOrg);
  const defaultOrg = defaultOrgParsed.success ? defaultOrgParsed.data : undefined;

  const userKey = remoteJwks(jwksUri, options.fetch);
  const publishOidc = options.publish?.oidc;

  const publishKey = publishOidc
    ? remoteJwks(
        publishOidc.jwksUri && publishOidc.jwksUri !== '' ? publishOidc.jwksUri : defaultJwksUri(publishOidc.issuer),
        options.fetch,
      )
    : undefined;

  const githubTrust = options.publish?.github;
  const githubKey = githubTrust ? remoteJwks(`${GITHUB_ISSUER}/.well-known/jwks`, options.fetch) : undefined;
  const publishToken = options.publish?.token && options.publish.token !== '' ? options.publish.token : undefined;

  async function* verifyPublishOidc(token: string): AsyncFallible<Caller | undefined, Failure> {
    if (!publishOidc || !publishKey) return undefined;

    const audience = publishOidc.audience && publishOidc.audience !== '' ? publishOidc.audience : options.baseUrl;

    const payload = yield* verifyJwt(token, publishKey, publishOidc.issuer, audience);

    return payload.sub === publishOidc.subject ? { user: payload.sub, kind: 'publish' } : undefined;
  }

  async function* verifyGithub(token: string): AsyncFallible<Caller | undefined, Failure> {
    if (!githubTrust || !githubKey) return undefined;

    const payload = yield* verifyJwt(token, githubKey, GITHUB_ISSUER, options.baseUrl);
    const { repository, environment } = payload;

    if (repository === githubTrust.repository) {
      if (environment === githubTrust.environment) return { user: payload.sub, kind: 'publish' };

      if (environment === undefined) return { user: payload.sub, kind: 'check' };
    }

    return undefined;
  }

  const userAudience = options.audience && options.audience !== '' ? options.audience : options.baseUrl;

  const mcpAudience = options.mcpAudience && options.mcpAudience !== '' ? options.mcpAudience : mcpUrl(options.baseUrl);

  async function* verifyUser(
    token: string,
    audience: string = userAudience,
  ): AsyncFallible<{ caller: PersonCaller; payload: JWTPayload }, Failure> {
    const payload = yield* verifyJwt(token, userKey, options.issuer, audience);

    return { caller: personFromPayload(payload, orgClaim, defaultOrg, permissionsClaim), payload };
  }

  return {
    mode: 'oidc',
    users: oidcUsers(),
    workos: noopWorkosPublish(),
    authenticate: (request, { access, known }) =>
      bearerAuth(request, async function* (token): AsyncFallible<Caller | undefined, Failure> {
        if (publishToken !== undefined && constantTimeEqual(token, publishToken)) {
          const caller: Caller = { user: PUBLISH_TOKEN_USER, kind: 'publish' };

          known?.({ user: caller.user, kind: caller.kind });

          return caller;
        }

        const decoded = yield* decodeToken(token);
        let caller: Caller | undefined;

        const matchesPublishOidc =
          publishOidc !== undefined &&
          decoded.iss === publishOidc.issuer &&
          decoded.sub === publishOidc.subject &&
          (publishOidc.issuer !== options.issuer || access === 'publish');

        if (matchesPublishOidc) caller = yield* verifyPublishOidc(token);
        else if (githubTrust !== undefined && decoded.iss === GITHUB_ISSUER) caller = yield* verifyGithub(token);
        else if (decoded.iss === options.issuer) caller = (yield* verifyUser(token)).caller;

        if (caller) known?.({ user: caller.user, kind: caller.kind });

        return caller;
      }),
    authenticateMcp: (request) =>
      bearerAuth(request, async function* (token): AsyncFallible<McpCaller | undefined, Failure> {
        if ((yield* decodeToken(token)).iss !== options.issuer) return undefined;

        const { caller, payload } = yield* verifyUser(token, mcpAudience);
        const clientId = stringClaim(payload, 'client_id') ?? stringClaim(payload, 'azp');

        if (clientId !== undefined && payload.sub === clientId) return undefined;

        return { ...caller, ...(clientId === undefined ? {} : { clientId }) };
      }),
    tokenRoute,
  };
}
