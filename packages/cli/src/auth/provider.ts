import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import { CliError, errorBodyOf, shared } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { answerOf, attempt, caught, settle, type AsyncFallible, type Result } from '../fallible.ts';
import type { Io, TokenStore, Variables } from '../io.ts';
import { retry, retryAfterMs, transientStatus, type Try } from '../retry.ts';
import type { Target } from '../targets.ts';
import { storeKey } from './keys.ts';
import { expiryMs, refreshStoredToken } from './refresh.ts';

interface KeptToken {
  readonly token: Promise<Result<string, CliError>>;
  renewAt: number;
}

const githubTokens = new Map<string, KeptToken>();

let accessTokens = new WeakMap<TokenStore, Map<string, Map<string, KeptToken>>>();

function keptAccessTokens(tokenStore: TokenStore, key: string): Map<string, KeptToken> {
  let ofStore = accessTokens.get(tokenStore);

  if (!ofStore) accessTokens.set(tokenStore, (ofStore = new Map()));

  let kept = ofStore.get(key);

  if (!kept) ofStore.set(key, (kept = new Map()));

  return kept;
}

export function resetAccessTokens(): void {
  accessTokens = new WeakMap();
}

const OIDC_RENEW_MS = 60_000;

const ACCESS_RENEW_MS = 120_000;

const OIDC_BOUND = { retries: 6, maxWaitMs: 63_000 };

async function* reuse(
  kept: Map<string, KeptToken>,
  key: string,
  renewMs: number,
  request: () => AsyncFallible<string, CliError>,
): AsyncFallible<string, CliError> {
  const held = kept.get(key);

  if (held && Date.now() < held.renewAt) return yield* shared(held.token);

  const entry: KeptToken = { token: settle(request()), renewAt: Infinity };

  kept.set(key, entry);

  void entry.token.then((result) => {
    entry.renewAt = result.ok ? (expiryMs(result.value) ?? 0) - renewMs : 0;
  });

  return yield* shared(entry.token);
}

function githubToken(url: string, requestToken: string, audience: string, io: Io): AsyncFallible<string, CliError> {
  return reuse(githubTokens, `${url} ${audience}`, OIDC_RENEW_MS, () =>
    retry<string, never>(io, OIDC_BOUND, () => tryGithubToken(url, requestToken, audience, io)),
  );
}

async function tryGithubToken(url: string, requestToken: string, audience: string, io: Io): Promise<Try<string>> {
  const request = new URL(url);

  request.searchParams.set('audience', audience);

  const read = await caught(async () => {
    const response = await io.fetch(request, { headers: { authorization: `Bearer ${requestToken}` } });

    const body: unknown =
      response.status === 200 ? await response.json() : errorBodyOf(response.status, await response.text());

    return { response, body };
  });

  if (!read.ok)
    return {
      failure: new CliError(
        `The GitHub OIDC token request failed: ${read.error instanceof Error ? read.error.message : String(read.error)}.`,
      ),
      transient: true,
    };

  const { response, body } = read.value;

  if (response.status === 200) return { value: (body as { value: string }).value };

  return {
    failure: new CliError(`The GitHub OIDC token request gave ${response.status}.`, body),
    transient: transientStatus(response.status),
    retryAfterMs: retryAfterMs(response),
  };
}

function presetToken(
  settings: Variables,
  audience: string,
  io: Io,
): (() => AsyncFallible<string, CliError>) | undefined {
  const fixed = settings['ONTOLOGY_TOKEN'];

  if (fixed) return () => answerOf<string, CliError>(Promise.resolve(fixed));

  const oidcUrl = settings['ACTIONS_ID_TOKEN_REQUEST_URL'];
  const oidcToken = settings['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];

  if (oidcUrl && oidcToken) return () => githubToken(oidcUrl, oidcToken, audience, io);

  return undefined;
}

export function tokenProvider(
  target: Target,
  config: ClientConfig,
  io: Io,
  settings: Variables,
): () => Promise<string> {
  const preset = presetToken(settings, target.baseUrl, io);
  let access: Promise<Result<string, CliError>> | undefined;

  const next =
    preset ??
    (() =>
      shared(
        (access ??= settle(
          reuse(
            keptAccessTokens(io.tokenStore, storeKey(target)),
            `${target.url} ${config.workosClientId}`,
            ACCESS_RENEW_MS,
            () => refreshStoredToken(target, config, io),
          ),
        )),
      ));

  return async () => {
    const token = await settle(next());

    // oxlint-disable-next-line fallible/no-throw -- D1: the stock OSDK client reads the rejection of the token provider that it calls.
    if (!token.ok) throw token.error;

    return token.value;
  };
}

export async function* setStored(
  target: Target,
  refreshToken: string | undefined,
  io: Io,
): AsyncFallible<void, CliError> {
  const key = storeKey(target);

  yield* attempt(
    () => (refreshToken === undefined ? io.tokenStore.remove(key) : io.tokenStore.write(key, refreshToken)),
    failureOf,
  );

  accessTokens.get(io.tokenStore)?.delete(key);
}

export const logout = (target: Target, io: Io): AsyncFallible<void, CliError> => setStored(target, undefined, io);
