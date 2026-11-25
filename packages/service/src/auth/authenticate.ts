import { decodeJwt, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { attempt, caught, outsideFailure, type AsyncFallible, type Fallible } from '../errors/index.ts';
import { mcpUrl } from './authSettings.ts';
import { OrganizationId, UserId, type AuthSettings, type Caller, type PersonCaller } from './caller.ts';
import { authkitIssuer, type KeySource } from './keys.ts';
import { bearerAuth } from './providers/shared.ts';
import type { McpCaller } from './providers/types.ts';
import { serviceCaller, serviceClaims, type ApplicationSource } from './service.ts';
import { WORKOS_API } from './users.ts';
import { GITHUB_ISSUER } from './workosCalls.ts';
import type { Failure } from './workosErrors.ts';

function workosIssuer(settings: AuthSettings): string {
  return `${WORKOS_API}/user_management/${settings.workosClientId}`;
}

const WORKOS_USER = /^user_[0-9A-Za-z]{1,64}$/;

export interface ServiceAuth {
  readonly authkitDomain: string | undefined;
  readonly applications: ApplicationSource;
}

export type KnownCaller = Pick<Caller, 'user' | 'kind'>;

export function authenticate(
  request: Request,
  settings: AuthSettings,
  keys: KeySource,
  service?: ServiceAuth,
  known?: (caller: KnownCaller) => void,
): AsyncFallible<Caller, Failure> {
  return bearerAuth(request, (token) => check(token, settings, keys, service, request.signal, known));
}

interface McpAuth {
  readonly authkitDomain: string;
  readonly baseUrl: string;
}

export function authenticateMcp(
  request: Request,
  mcp: McpAuth,
  key: JWTVerifyGetKey,
): AsyncFallible<McpCaller, Failure> {
  return bearerAuth(request, (token) => checkAuthKit(token, mcp, key));
}

function* decoded(token: string): Fallible<JWTPayload, Failure> {
  const claims = caught(() => decodeJwt(token));

  if (!claims.ok) return yield outsideFailure(claims.error);

  return claims.value;
}

async function* check(
  token: string,
  settings: AuthSettings,
  keys: KeySource,
  service: ServiceAuth | undefined,
  signal: AbortSignal,
  known?: (caller: KnownCaller) => void,
): AsyncFallible<Caller | undefined, Failure> {
  const { iss } = yield* decoded(token);
  const authkitDomain = service?.authkitDomain;
  let caller: Caller | undefined;

  if (iss === workosIssuer(settings)) caller = yield* person(token, settings, keys.workos);
  else if (iss === GITHUB_ISSUER) caller = yield* workflow(token, settings, keys.github);
  else if (service && authkitDomain !== undefined && iss === authkitIssuer(authkitDomain))
    return yield* serviceUser(token, settings, keys.authkit, authkitDomain, service.applications, signal, known);

  if (caller) known?.({ user: caller.user, kind: caller.kind });

  return caller;
}

async function* serviceUser(
  token: string,
  settings: AuthSettings,
  key: JWTVerifyGetKey,
  authkitDomain: string,
  applications: ApplicationSource,
  signal: AbortSignal,
  known?: (caller: KnownCaller) => void,
): AsyncFallible<Caller | undefined, Failure> {
  const payload = yield* verify(token, key, authkitIssuer(authkitDomain), settings.workosClientId);
  const claims = serviceClaims(payload);

  if (!claims) return undefined;

  known?.({ user: claims.clientId, kind: 'service' });

  return yield* serviceCaller(claims, applications, signal);
}

async function* checkAuthKit(
  token: string,
  mcp: McpAuth,
  key: JWTVerifyGetKey,
): AsyncFallible<McpCaller | undefined, Failure> {
  const issuer = authkitIssuer(mcp.authkitDomain);

  if ((yield* decoded(token)).iss !== issuer) return undefined;

  const payload = yield* verify(token, key, issuer, mcpUrl(mcp.baseUrl));

  if (payload.sub === payload['client_id']) return undefined;

  const person = personOf(payload);

  return (
    person && { ...person, ...(typeof payload['client_id'] === 'string' ? { clientId: payload['client_id'] } : {}) }
  );
}

async function* person(
  token: string,
  settings: AuthSettings,
  key: JWTVerifyGetKey,
): AsyncFallible<Caller | undefined, Failure> {
  const payload = yield* verify(token, key, workosIssuer(settings));

  if (payload.client_id !== settings.workosClientId) return undefined;

  return personOf(payload);
}

const PersonClaims = z.object({
  sub: z.string().regex(WORKOS_USER).pipe(UserId),
  org_id: z
    .unknown()
    .optional()
    .transform((value) => {
      const id = OrganizationId.safeParse(value);

      return id.success ? id.data : undefined;
    }),
});

function personOf(payload: JWTPayload): PersonCaller | undefined {
  const claims = PersonClaims.safeParse(payload);

  if (!claims.success) return undefined;

  const { sub: user, org_id: organization } = claims.data;

  return { user, kind: 'person', ...(organization === undefined ? {} : { organization }) };
}

async function* workflow(
  token: string,
  settings: AuthSettings,
  key: JWTVerifyGetKey,
): AsyncFallible<Caller | undefined, Failure> {
  const payload = yield* verify(token, key, GITHUB_ISSUER, settings.baseUrl);
  const { repository, environment } = payload;

  if (repository === settings.app.repository) {
    if (environment === settings.app.environment) return { user: payload.sub, kind: 'publish' };

    if (environment === undefined) return { user: payload.sub, kind: 'check' };
  }

  return undefined;
}

async function* verify(
  token: string,
  key: JWTVerifyGetKey,
  issuer: string,
  audience?: string,
): AsyncFallible<JWTPayload & { sub: UserId }, Failure> {
  const options = { issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'sub'] };

  const { payload } = yield* attempt(
    () => jwtVerify(token, key, audience === undefined ? options : { ...options, audience }),
    outsideFailure,
  );

  const sub = UserId.safeParse(payload.sub);

  if (!sub.success) return yield outsideFailure(new errors.JWTInvalid('The token has no sub.'));

  return { ...payload, sub: sub.data };
}
