import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import { CliError, errorBody } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { attempt, type AsyncFallible, type Fallible } from '../fallible.ts';
import type { Io, Variables } from '../io.ts';
import type { Target } from '../targets.ts';
import { finishSignIn, trySwitchingStoredToken, type SignedIn } from './organizations.ts';
import { authenticate, deviceAuthorization, signInTokens, WORKOS, workosFields } from './workos.ts';

const TEST_USER_VARIABLES = ['ONTOLOGY_TEST_USER_EMAIL', 'ONTOLOGY_TEST_USER_PASSWORD', 'WORKOS_API_KEY'] as const;

export interface TestUserCredentials {
  readonly email: string;
  readonly password: string;
  readonly apiKey: string;
}

export function* testUserCredentials(shell: Variables): Fallible<TestUserCredentials, CliError> {
  const [email, password, apiKey] = TEST_USER_VARIABLES.map((name) => shell[name]);

  if (!email || !password || !apiKey) {
    return yield new CliError(
      `ontos login --test-user reads ${TEST_USER_VARIABLES.join(', ')} from the shell, not from .env. Set each of them.`,
    );
  }

  return { email, password, apiKey };
}

export async function* login(
  target: Target,
  config: ClientConfig,
  organization: string | undefined,
  io: Io,
): AsyncFallible<SignedIn, CliError> {
  const switched =
    organization === undefined ? undefined : yield* trySwitchingStoredToken(target, config, organization, io);

  if (switched) return switched;

  const started = yield* attempt(
    () =>
      io.fetch(`${WORKOS}/authorize/device`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.workosClientId }),
      }),
    failureOf,
  );

  if (!started.ok)
    return yield new CliError(`The device authorization gave ${started.status}.`, yield* errorBody(started));

  const device = yield* deviceAuthorization(yield* attempt(() => started.json(), failureOf));

  io.stderr(
    `${JSON.stringify({ userCode: device.user_code, verificationUri: device.verification_uri, open: device.verification_uri_complete })}\n`,
  );

  let interval = device.interval;
  const deadline = Date.now() + device.expires_in * 1000;

  for (;;) {
    const response = yield* attempt(
      () =>
        authenticate(io, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: config.workosClientId,
        }),
      failureOf,
    );

    const body: unknown = yield* attempt(() => response.json(), failureOf);

    if (response.ok)
      return yield* finishSignIn(target, config, yield* signInTokens(body, 'The sign-in'), organization, io);

    const error = workosFields(body)['error'];

    if (error === 'slow_down') interval += 5;
    else if (error !== 'authorization_pending')
      return yield new CliError(`The sign-in failed: ${typeof error === 'string' ? error : response.status}.`, body);

    if (Date.now() + interval * 1000 > deadline) return yield new CliError('The sign-in timed out.', body);

    yield* attempt(() => io.sleep(interval * 1000), failureOf);
  }
}

export async function* testUserLogin(
  target: Target,
  config: ClientConfig,
  credentials: TestUserCredentials,
  organization: string | undefined,
  io: Io,
): AsyncFallible<SignedIn, CliError> {
  const { email, password, apiKey } = credentials;

  const response = yield* attempt(
    () =>
      authenticate(io, {
        grant_type: 'password',
        client_id: config.workosClientId,
        client_secret: apiKey,
        email,
        password,
      }),
    failureOf,
  );

  if (!response.ok)
    return yield new CliError(`The test user sign-in gave ${response.status}.`, yield* errorBody(response));

  return yield* finishSignIn(
    target,
    config,
    yield* signInTokens(yield* attempt(() => response.json(), failureOf), 'The test user sign-in'),
    organization,
    io,
  );
}
