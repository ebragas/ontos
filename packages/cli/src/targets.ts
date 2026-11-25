import type { ClientConfig } from '@ericbragas/ontos-service/client-config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { CliError, errorBody } from './cliError.ts';
import { failureOf } from './errors.ts';
import { attempt, type AsyncFallible, type Fallible } from './fallible.ts';
import type { Io, Variables } from './io.ts';
import { metadataFetch } from './metadataCache.ts';
import { serviceFetch } from './serviceFetch.ts';

type Environment = 'staging' | 'production';

const STAGING_APP_MAX = 63 - '-staging'.length;
const DEFAULT_BASE_DOMAIN = 'ontos.example';
const BASE_DOMAIN_FORM = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

const ENV_ONLY_VARIABLES = new Set([
  'ONTOS_BASE_DOMAIN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
]);

function appBaseUrl(app: string, environment: Environment, domain: string): string {
  const host = environment === 'production' ? app : `${app}-staging`;

  return `https://${host}.${domain}`;
}

function appKeyFromUrl(url: URL): string {
  const cleaned = url.host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned === '' || /^\.+$/.test(cleaned) ? 'local' : cleaned;
}

export interface Target {
  readonly app: string;
  readonly environment: Environment;
  readonly baseUrl: string;
  readonly url: string;
  readonly testUser: boolean;
  readonly urlOnly?: true;
  readonly domain?: string;
}

export function findUp(folder: string, name: string): string | undefined {
  for (let at = folder; ; at = dirname(at)) {
    const file = join(at, name);

    if (existsSync(file)) return file;

    if (dirname(at) === at) return undefined;
  }
}

export function cliSettings(io: Pick<Io, 'cwd' | 'env'>): Variables {
  const file = findUp(io.cwd, '.env');

  if (!file) return io.env;

  const fromFile = Object.fromEntries(
    Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(([name]) => !ENV_ONLY_VARIABLES.has(name)),
  );

  return { ...fromFile, ...io.env };
}

export interface TargetFlags {
  readonly app?: string | undefined;
  readonly env?: string | undefined;
  readonly url?: string | undefined;
  readonly 'test-user'?: boolean | undefined;
}

const NO_TARGET = 'No target: pass --url <url>, --app <name>, or set ONTOLOGY_APP.';

export function* resolveTarget(flags: TargetFlags, settings: Variables): Fallible<Target, CliError> {
  const app = flags.app ?? settings['ONTOLOGY_APP'];
  const explicitUrl = flags.url;

  if (!app && !explicitUrl) return yield new CliError(NO_TARGET);

  const environment = flags.env ?? 'staging';

  if (environment !== 'staging' && environment !== 'production') {
    return yield new CliError(`The environment is staging or production, not ${environment}.`);
  }

  const testUser = flags['test-user'] === true;

  if (explicitUrl !== undefined) {
    const parsed = URL.parse(explicitUrl);

    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return yield new CliError(`--url must be a valid http or https URL, not ${explicitUrl}.`);
    }

    if (!app) {
      const derivedApp = appKeyFromUrl(parsed);

      if (testUser && environment === 'production') {
        return yield new CliError(
          `--test-user acts on staging only. The production environment of ${derivedApp} has no test user.`,
        );
      }

      return { app: derivedApp, environment, baseUrl: parsed.origin, url: explicitUrl, testUser, urlOnly: true };
    }
  }

  const appName = app as string;

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appName))
    return yield new CliError(`The app name is 1 DNS label of lowercase letters, digits, and hyphens, not ${appName}.`);

  if (environment === 'staging' && appName.length > STAGING_APP_MAX) {
    return yield new CliError(
      `The app name has at most ${STAGING_APP_MAX} characters in staging, so the staging host ${appName}-staging is 1 DNS label of at most 63 characters. ${appName} has ${appName.length}.`,
    );
  }

  if (testUser && environment === 'production') {
    return yield new CliError(
      `--test-user acts on staging only. The production environment of ${appName} has no test user.`,
    );
  }

  const rawDomain = settings['ONTOS_BASE_DOMAIN']?.trim();
  const domain = rawDomain && rawDomain !== '' ? rawDomain : DEFAULT_BASE_DOMAIN;

  if (!BASE_DOMAIN_FORM.test(domain)) {
    return yield new CliError(`ONTOS_BASE_DOMAIN must be a valid DNS domain, not ${domain}.`);
  }

  const baseUrl = appBaseUrl(appName, environment, domain);

  return {
    app: appName,
    environment,
    baseUrl,
    url: explicitUrl ?? baseUrl,
    testUser,
    ...(domain === DEFAULT_BASE_DOMAIN ? {} : { domain: domain.toLowerCase() }),
  };
}

export async function* readClientConfig(
  target: Target,
  io: Pick<Io, 'fetch' | 'sleep'>,
): AsyncFallible<ClientConfig, CliError> {
  const response = yield* attempt(
    () => metadataFetch(serviceFetch(io))(new URL('/api/ontology-service/v1/client-config', target.url)),
    failureOf,
  );

  if (response.status !== 200) {
    const body = yield* errorBody(response);

    if (response.status === 404 && JSON.stringify(body).includes('DEPLOYMENT_NOT_FOUND'))
      return yield environmentNotDeployed(target);

    return yield new CliError(`client-config gave ${response.status}.`, body);
  }

  return (yield* attempt(() => response.json(), failureOf)) as ClientConfig;
}

function environmentNotDeployed({ app, environment, url }: Target): CliError {
  const message = `${url} has no deployment yet. Deploy the ${environment} environment of ${app} first. Until then, ontos validate and the other commands fail on it.`;

  return new CliError(message, { errorName: 'EnvironmentNotDeployed', message, url });
}
