import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import { CliError, errorBodyOf } from '../cliError.ts';
import { failureOf } from '../errors.ts';
import { attempt, caught, settle, type AsyncFallible } from '../fallible.ts';
import { warn, type Io } from '../io.ts';
import { transientStatus } from '../retry.ts';
import type { Target } from '../targets.ts';
import { loginCommand, nextStep, storeKey } from './keys.ts';
import { setStored } from './provider.ts';
import { refreshIntoOrganization, unverifiedClaims } from './refresh.ts';
import type { SignInTokens } from './workos.ts';

interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
}

export interface SignedIn {
  readonly user?: unknown;
  readonly organization?: unknown;
  readonly role?: unknown;
  readonly organizations?: readonly OrganizationSummary[];
}

type OrganizationList =
  | { readonly kind: 'listed'; readonly organizations: readonly OrganizationSummary[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: string };

const ORGANIZATIONS_TIMEOUT_MS = 10_000;

async function* store(target: Target, user: unknown, tokens: SignInTokens, io: Io): AsyncFallible<SignedIn, CliError> {
  yield* setStored(target, tokens.refresh_token, io);

  const { org_id, role } = unverifiedClaims(tokens.access_token);

  return { user, organization: org_id, role };
}

async function* storeInOrganization(
  target: Target,
  user: unknown,
  tokens: SignInTokens,
  organization: string,
  io: Io,
): AsyncFallible<SignedIn, CliError> {
  const signedIn = yield* store(target, user, tokens, io);

  if (signedIn.organization === organization) return signedIn;

  const answered =
    signedIn.organization === undefined
      ? 'no Organization'
      : `the Organization ${typeof signedIn.organization === 'string' ? signedIn.organization : JSON.stringify(signedIn.organization)}`;

  return yield new CliError(
    `WorkOS answered for ${answered}, not ${organization}. The new token is stored. Run ${loginCommand(target)} --org ${organization} again.`,
  );
}

function organizationsRefused(target: Target, status: number, body: unknown): CliError {
  const errorName = (body as { readonly errorName?: unknown } | null)?.errorName;
  const message = `The list of your Organizations gave ${status}. The token is stored. ${nextStep(target)}`;

  return new CliError(message, { message, status, ...(errorName === undefined ? {} : { errorName }) });
}

function parseOrganizations(text: string): OrganizationList {
  const parsed = caught((): unknown => JSON.parse(text));
  const body = parsed.ok ? parsed.value : undefined;
  const data = (body as { readonly data?: unknown } | null | undefined)?.data;

  const isOrganization = (item: unknown): item is OrganizationSummary =>
    typeof (item as OrganizationSummary | null)?.id === 'string' &&
    typeof (item as OrganizationSummary | null)?.name === 'string';

  return Array.isArray(data) && data.every(isOrganization)
    ? { kind: 'listed', organizations: data }
    : { kind: 'failed', reason: 'an answer that the CLI cannot read' };
}

async function* readOrganizations(
  target: Target,
  accessToken: string,
  io: Io,
): AsyncFallible<OrganizationList, CliError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORGANIZATIONS_TIMEOUT_MS).unref();

  const failed = (error: unknown): OrganizationList => ({
    kind: 'failed',
    reason: controller.signal.aborted
      ? `no answer in ${ORGANIZATIONS_TIMEOUT_MS / 1000} seconds`
      : error instanceof Error
        ? error.message
        : String(error),
  });

  try {
    const sent = await caught(() =>
      io.fetch(new URL('/api/ontology-service/v1/organizations', target.url), {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      }),
    );

    if (!sent.ok) return failed(sent.error);

    const response = sent.value;

    if (response.status === 404) return { kind: 'absent' };

    if (transientStatus(response.status)) return { kind: 'failed', reason: `HTTP ${response.status}` };

    const text = await caught(() => response.text());

    if (!text.ok) return failed(text.error);

    if (response.status !== 200)
      return yield organizationsRefused(target, response.status, errorBodyOf(response.status, text.value));

    return parseOrganizations(text.value);
  } finally {
    clearTimeout(timer);
  }
}

export async function* finishSignIn(
  target: Target,
  config: ClientConfig,
  signIn: SignInTokens,
  organization: string | undefined,
  io: Io,
): AsyncFallible<SignedIn, CliError> {
  if (organization !== undefined)
    return yield* storeInOrganization(
      target,
      signIn.user?.id,
      yield* refreshIntoOrganization(config, signIn.refresh_token, organization, io),
      organization,
      io,
    );

  const stored = yield* store(target, signIn.user?.id, signIn, io);

  if (stored.organization !== undefined) return stored;

  const list = yield* readOrganizations(target, signIn.access_token, io);

  if (list.kind === 'absent') {
    warn(io, `This token has no Organization. ${nextStep(target)}`);

    return stored;
  }

  if (list.kind === 'failed') {
    warn(
      io,
      `The list of your Organizations failed: ${list.reason}. The sign-in worked, and the token is stored. ${nextStep(target)}`,
    );

    return stored;
  }

  const [only, ...others] = list.organizations;

  if (only === undefined) {
    warn(io, 'You belong to no Organization of this environment. Join or create an Organization.');

    return stored;
  }

  if (others.length === 0)
    return yield* storeInOrganization(
      target,
      signIn.user?.id,
      yield* refreshIntoOrganization(config, signIn.refresh_token, only.id, io),
      only.id,
      io,
    );

  warn(io, `You belong to more than 1 Organization. Run ${loginCommand(target)} --org <id> with 1 of the listed IDs.`);

  return { ...stored, organizations: list.organizations };
}

export async function* trySwitchingStoredToken(
  target: Target,
  config: ClientConfig,
  organization: string,
  io: Io,
): AsyncFallible<SignedIn | undefined, CliError> {
  const stored = yield* attempt(() => io.tokenStore.read(storeKey(target)), failureOf);

  if (stored === undefined) return undefined;

  const refreshed = await settle(refreshIntoOrganization(config, stored, organization, io));

  if (!refreshed.ok) return undefined;

  return yield* storeInOrganization(target, refreshed.value.user?.id, refreshed.value, organization, io);
}
