import { CliError } from '../cliError.ts';
import type { Fallible } from '../fallible.ts';
import type { Io } from '../io.ts';

export const WORKOS = 'https://api.workos.com/user_management';

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
}

export type SignInTokens = Tokens & { readonly user?: { readonly id?: unknown } };

export function authenticate(io: Io, params: Record<string, string>): Promise<Response> {
  return io.fetch(`${WORKOS}/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

export function workosFields(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return {};

  return value as Readonly<Record<string, unknown>>;
}

function* workosString(
  fields: Readonly<Record<string, unknown>>,
  name: string,
  source: string,
): Fallible<string, CliError> {
  const value = fields[name];

  if (typeof value !== 'string') return yield new CliError(`${source} gave no string for ${name}.`);

  return value;
}

function* workosPositive(
  fields: Readonly<Record<string, unknown>>,
  name: string,
  source: string,
): Fallible<number, CliError> {
  const value = fields[name];

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return yield new CliError(`${source} gave no positive number for ${name}.`);

  return value;
}

const DEVICE_SOURCE = 'The device authorization';

interface DeviceAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

export function* deviceAuthorization(value: unknown): Fallible<DeviceAuthorization, CliError> {
  const fields = workosFields(value);

  return {
    device_code: yield* workosString(fields, 'device_code', DEVICE_SOURCE),
    user_code: yield* workosString(fields, 'user_code', DEVICE_SOURCE),
    verification_uri: yield* workosString(fields, 'verification_uri', DEVICE_SOURCE),
    verification_uri_complete: yield* workosString(fields, 'verification_uri_complete', DEVICE_SOURCE),
    expires_in: yield* workosPositive(fields, 'expires_in', DEVICE_SOURCE),
    interval: yield* workosPositive(fields, 'interval', DEVICE_SOURCE),
  };
}

export function* signInTokens(value: unknown, source: string): Fallible<SignInTokens, CliError> {
  const fields = workosFields(value);
  const access_token = yield* workosString(fields, 'access_token', source);
  const refresh_token = yield* workosString(fields, 'refresh_token', source);
  const user = fields['user'];

  if (typeof user !== 'object' || user === null || !('id' in user)) return { access_token, refresh_token };

  return { access_token, refresh_token, user: { id: user.id } };
}
