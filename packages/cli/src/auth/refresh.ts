import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import { CliError, errorBodyOf } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { attempt, caught, type AsyncFallible } from '../fallible.ts';
import type { Io } from '../io.ts';
import { retry, retryAfterMs, transientStatus, type Try } from '../retry.ts';
import type { Target } from '../targets.ts';
import { loginCommand, storeKey } from './keys.ts';
import { authenticate, signInTokens, workosFields, type SignInTokens } from './workos.ts';

const REFRESH_BOUND = { retries: 3, maxWaitMs: 20_000 };

export function unverifiedClaims(jwt: string): Readonly<Record<string, unknown>> {
  const parsed = caught((): unknown => JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')));
  const claims = parsed.ok ? parsed.value : undefined;

  return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : {};
}

export function expiryMs(jwt: string): number | undefined {
  const { exp } = unverifiedClaims(jwt);

  return typeof exp === 'number' ? exp * 1000 : undefined;
}

async function* tryRefresh(
  io: Io,
  params: Record<string, string>,
  invalidGrant: (body: unknown) => CliError,
): AsyncFallible<Try<SignInTokens>, CliError> {
  const read = await caught(async () => {
    const response = await authenticate(io, params);

    const body: unknown = response.ok ? await response.json() : errorBodyOf(response.status, await response.text());

    return { response, body };
  });

  if (!read.ok)
    return {
      failure: new CliError(
        `The token refresh failed: ${read.error instanceof Error ? read.error.message : String(read.error)}.`,
      ),
      transient: true,
    };

  const { response, body } = read.value;

  if (response.ok) return { value: yield* signInTokens(body, 'The token refresh') };

  if (workosFields(body)['error'] === 'invalid_grant') {
    return { failure: invalidGrant(body), transient: false };
  }

  return {
    failure: new CliError(`The token refresh gave ${response.status}.`, body),
    transient: transientStatus(response.status),
    retryAfterMs: retryAfterMs(response),
  };
}

export function refreshIntoOrganization(
  config: ClientConfig,
  refresh_token: string,
  organization: string,
  io: Io,
): AsyncFallible<SignInTokens, CliError> {
  const params = {
    grant_type: 'refresh_token',
    refresh_token,
    client_id: config.workosClientId,
    organization_id: organization,
  };

  return retry(io, REFRESH_BOUND, () =>
    tryRefresh(io, params, (body) => new CliError(`WorkOS refused the Organization ${organization}.`, body)),
  );
}

export async function* refreshStoredToken(
  target: Target,
  config: ClientConfig,
  io: Io,
): AsyncFallible<string, CliError> {
  const key = storeKey(target);
  const loginHint = `run ${loginCommand(target)}`;
  const stored = yield* attempt(() => io.tokenStore.read(key), failureOf);

  if (!stored) return yield new CliError(`No stored token for ${key}: ${loginHint}.`);

  const params = { grant_type: 'refresh_token', refresh_token: stored, client_id: config.workosClientId };

  const tokens = yield* retry(io, REFRESH_BOUND, () =>
    tryRefresh(io, params, () => new CliError(`WorkOS no longer accepts the stored token of ${key}: ${loginHint}.`)),
  );

  yield* attempt(() => io.tokenStore.write(key, tokens.refresh_token, stored), failureOf);

  return tokens.access_token;
}
