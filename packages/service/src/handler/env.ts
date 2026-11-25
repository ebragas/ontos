import {
  authSettingsFromEnv,
  devIdentityProvider,
  oidcIdentityProvider,
  remoteKeys,
  requiredEnv,
  trustedPair,
  unusedKeys,
  workosIdentityProvider,
  workosPublish,
  workosUsers,
  type AuthMode,
  type OidcPublishConfig,
  type OidcPublishOidcConfig,
} from '../auth/index.ts';
import { createDb } from '../db/index.ts';
import { invariant } from '../errors/index.ts';
import type { HandleInput, MissingSettings, Settings } from './context.ts';

type Env = Readonly<Record<string, string | undefined>>;

type PoolFactory = (connectionString: string) => Parameters<typeof createDb>[0];

interface InputOptions {
  readonly onBackground?: ((pending: Promise<void>) => void) | undefined;
}

const DEFAULT_DEV_PRODUCT_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000001';

export const DEV_PRODUCTION_REASON = 'ONTOS_AUTH_MODE=dev is refused when ONTOLOGY_ENVIRONMENT=production.';

export function isProductionEnvironment(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();

  return normalized === 'production' || normalized === 'prod';
}

function isProductionEnv(env: Env): boolean {
  return (
    isProductionEnvironment(env['ONTOLOGY_ENVIRONMENT']) ||
    isProductionEnvironment(env['NODE_ENV']) ||
    isProductionEnvironment(env['VERCEL_ENV'])
  );
}

const WORKOS_REQUIRED = [
  'PRODUCT_RID',
  'ONTOLOGY_ENVIRONMENT',
  'ONTOLOGY_BASE_URL',
  'WORKOS_CLIENT_ID',
  'AUTHKIT_DOMAIN',
  'TRUSTED_GITHUB_REPOSITORY',
  'TRUSTED_GITHUB_ENVIRONMENT',
  'DATABASE_URL',
  'WORKOS_API_KEY',
] as const;

const OIDC_REQUIRED = [
  'PRODUCT_RID',
  'ONTOLOGY_ENVIRONMENT',
  'ONTOLOGY_BASE_URL',
  'ONTOS_OIDC_ISSUER',
  'DATABASE_URL',
] as const;

function parseAuthMode(env: Env): AuthMode | 'invalid' {
  const raw = env['ONTOS_AUTH_MODE'];

  if (raw === undefined || raw === '' || raw === 'workos') return 'workos';

  if (raw === 'dev' || raw === 'oidc') return raw;

  return 'invalid';
}

function isHttpUrl(value: string): boolean {
  const parsed = URL.parse(value);

  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

const DOMAIN_FORM = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;

function isDomain(value: string): boolean {
  return DOMAIN_FORM.test(value) && !value.includes('..');
}

function nonEmpty(env: Env, name: string): string | undefined {
  const value = env[name];

  return value === undefined || value === '' ? undefined : value;
}

function nonEmptyTrimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === undefined || value === '' ? undefined : value;
}

function environmentFromEnv(env: Env): string | undefined {
  const value = env['ONTOLOGY_ENVIRONMENT']?.trim();

  return value === undefined || value === '' ? undefined : value;
}

function requiredEnvironment(env: Env): string {
  const value = environmentFromEnv(env);

  invariant(value !== undefined, 'The environment variable ONTOLOGY_ENVIRONMENT is not set.');

  return value;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function optionalFlags(env: Env): Pick<Settings, 'logRequestBodies' | 'loadDerivedProperties' | 'maxBodyBytes'> {
  const rawMaxBodyBytes = nonEmpty(env, 'ONTOS_MAX_BODY_BYTES');
  const maxBodyBytes = rawMaxBodyBytes === undefined ? undefined : parsePositiveInteger(rawMaxBodyBytes);

  invariant(
    rawMaxBodyBytes === undefined || maxBodyBytes !== undefined,
    'ONTOS_MAX_BODY_BYTES must be a positive safe integer.',
  );

  return {
    ...(env['LOG_REQUEST_BODIES'] === 'true' ? { logRequestBodies: true } : {}),
    ...(env['ONTOLOGY_LOAD_DERIVED_PROPERTIES'] === 'true' ? { loadDerivedProperties: true } : {}),
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  };
}

function devSettingsFromEnv(env: Env): Settings {
  const environment = environmentFromEnv(env) ?? 'development';

  invariant(!isProductionEnv(env), DEV_PRODUCTION_REASON);

  const port = nonEmpty(env, 'PORT') ?? '8080';
  const baseUrl = nonEmpty(env, 'ONTOLOGY_BASE_URL') ?? `http://localhost:${port}`;

  invariant(isHttpUrl(baseUrl), 'ONTOLOGY_BASE_URL must be a valid http or https URL.');

  return {
    productRid: nonEmpty(env, 'PRODUCT_RID') ?? DEFAULT_DEV_PRODUCT_RID,
    environment,
    auth: {
      workosClientId: nonEmpty(env, 'WORKOS_CLIENT_ID') ?? 'dev',
      baseUrl,
      app: { repository: '', environment: '' },
    },
    authMode: 'dev',
    ...(env['ONTOLOGY_MCP'] === 'false' ? {} : { mcp: true }),
    ...optionalFlags(env),
  };
}

function oidcSettingsFromEnv(env: Env): Settings {
  const issuer = requiredEnv(env, 'ONTOS_OIDC_ISSUER');
  const baseUrl = requiredEnv(env, 'ONTOLOGY_BASE_URL');

  invariant(isHttpUrl(issuer), 'ONTOS_OIDC_ISSUER must be a valid http or https URL.');

  invariant(isHttpUrl(baseUrl), 'ONTOLOGY_BASE_URL must be a valid http or https URL.');

  const github = trustedPair(env);

  return {
    productRid: requiredEnv(env, 'PRODUCT_RID'),
    environment: requiredEnvironment(env),
    auth: {
      workosClientId: nonEmpty(env, 'WORKOS_CLIENT_ID') ?? 'oidc',
      baseUrl,
      app: github ?? { repository: '', environment: '' },
    },
    authMode: 'oidc',
    oidcIssuer: issuer,
    ...(env['ONTOLOGY_MCP'] === 'true' ? { mcp: true } : {}),
    ...optionalFlags(env),
  };
}

export function settingsFromEnv(env: Env): Settings {
  const mode = parseAuthMode(env);

  invariant(mode !== 'invalid', 'ONTOS_AUTH_MODE must be one of dev, oidc, or workos.');

  if (mode === 'dev') return devSettingsFromEnv(env);

  if (mode === 'oidc') return oidcSettingsFromEnv(env);

  const auth = authSettingsFromEnv(env);
  const authkitDomain = requiredEnv(env, 'AUTHKIT_DOMAIN');

  invariant(isHttpUrl(auth.baseUrl), 'ONTOLOGY_BASE_URL must be a valid http or https URL.');

  invariant(isDomain(authkitDomain), 'AUTHKIT_DOMAIN must be a valid domain.');

  return {
    productRid: requiredEnv(env, 'PRODUCT_RID'),
    environment: requiredEnvironment(env),
    auth,
    authkitDomain,
    ...(env['ONTOLOGY_MCP'] === 'true' ? { mcp: true } : {}),
    ...optionalFlags(env),
  };
}

function databasesFromEnv(
  env: Env,
  createPool: PoolFactory,
): { readonly db: ReturnType<typeof createDb>; readonly directDb: ReturnType<typeof createDb> } {
  const databaseUrl = requiredEnv(env, 'DATABASE_URL');
  const directUrl = nonEmpty(env, 'DATABASE_URL_DIRECT') ?? databaseUrl;
  const db = createDb(createPool(databaseUrl));

  return {
    db,
    directDb: directUrl === databaseUrl ? db : createDb(createPool(directUrl)),
  };
}

function devInputFromEnv(
  env: Env,
  createPool: PoolFactory,
  adapterNames: readonly string[],
  options: InputOptions,
): HandleInput | MissingSettings {
  if (isProductionEnv(env)) {
    return { missing: ['ONTOS_AUTH_MODE'], reason: DEV_PRODUCTION_REASON };
  }

  const missing = ['DATABASE_URL', ...adapterNames].filter((name) => !env[name]);
  const baseUrl = nonEmpty(env, 'ONTOLOGY_BASE_URL');

  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) missing.push('ONTOLOGY_BASE_URL');

  if (missing.length > 0) return { missing };

  const settings = devSettingsFromEnv(env);
  const devToken = nonEmptyTrimmed(env, 'ONTOS_DEV_TOKEN');
  const identity = devIdentityProvider(devToken === undefined ? {} : { token: devToken });

  return {
    ...databasesFromEnv(env, createPool),
    settings,
    keys: unusedKeys(),
    users: identity.users,
    workos: identity.workos,
    identity,
    ...(options.onBackground === undefined ? {} : { onBackground: options.onBackground }),
  };
}

function oidcPublishMissing(env: Env): string[] {
  const missing: string[] = [];
  const jwksUri = nonEmpty(env, 'ONTOS_OIDC_JWKS_URI');

  if (jwksUri !== undefined && !isHttpUrl(jwksUri)) missing.push('ONTOS_OIDC_JWKS_URI');

  const pubIssuer = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_ISSUER');
  const pubSub = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_SUB');
  const pubJwks = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_JWKS_URI');

  if (pubIssuer !== undefined && !isHttpUrl(pubIssuer)) missing.push('ONTOS_PUBLISH_OIDC_ISSUER');

  if ((pubIssuer !== undefined) !== (pubSub !== undefined)) {
    if (pubIssuer === undefined) missing.push('ONTOS_PUBLISH_OIDC_ISSUER');

    if (pubSub === undefined) missing.push('ONTOS_PUBLISH_OIDC_SUB');
  }

  if (pubJwks !== undefined && !isHttpUrl(pubJwks)) missing.push('ONTOS_PUBLISH_OIDC_JWKS_URI');

  const hasGithub =
    nonEmpty(env, 'TRUSTED_GITHUB_REPOSITORY') !== undefined ||
    nonEmpty(env, 'TRUSTED_GITHUB_ENVIRONMENT') !== undefined;

  if (hasGithub && !trustedPair(env)) missing.push('TRUSTED_GITHUB_REPOSITORY', 'TRUSTED_GITHUB_ENVIRONMENT');

  return missing;
}

function oidcPublishFromEnv(env: Env): OidcPublishConfig {
  const token = nonEmptyTrimmed(env, 'ONTOS_PUBLISH_TOKEN');
  const pubIssuer = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_ISSUER');
  const pubSub = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_SUB');
  const pubJwks = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_JWKS_URI');
  const pubAudience = nonEmpty(env, 'ONTOS_PUBLISH_OIDC_AUDIENCE');

  const oidc: OidcPublishOidcConfig | undefined =
    pubIssuer !== undefined && pubSub !== undefined
      ? {
          issuer: pubIssuer,
          subject: pubSub,
          ...(pubJwks === undefined ? {} : { jwksUri: pubJwks }),
          ...(pubAudience === undefined ? {} : { audience: pubAudience }),
        }
      : undefined;

  const github = trustedPair(env);

  return {
    ...(token === undefined ? {} : { token }),
    ...(oidc === undefined ? {} : { oidc }),
    ...(github === undefined ? {} : { github }),
  };
}

function oidcInputFromEnv(
  env: Env,
  createPool: PoolFactory,
  adapterNames: readonly string[],
  options: InputOptions,
): HandleInput | MissingSettings {
  const missing = [...OIDC_REQUIRED, ...adapterNames].filter((name) =>
    name === 'ONTOLOGY_ENVIRONMENT' ? environmentFromEnv(env) === undefined : !env[name],
  );

  const issuer = nonEmpty(env, 'ONTOS_OIDC_ISSUER');
  const baseUrl = nonEmpty(env, 'ONTOLOGY_BASE_URL');

  if (issuer !== undefined && !isHttpUrl(issuer)) missing.push('ONTOS_OIDC_ISSUER');

  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) missing.push('ONTOLOGY_BASE_URL');

  missing.push(...oidcPublishMissing(env));

  if (missing.length > 0) return { missing };

  const settings = oidcSettingsFromEnv(env);
  const jwksUri = nonEmpty(env, 'ONTOS_OIDC_JWKS_URI');
  const audience = nonEmpty(env, 'ONTOS_OIDC_AUDIENCE');
  const mcpAudience = nonEmpty(env, 'ONTOS_OIDC_MCP_AUDIENCE');
  const orgClaim = nonEmpty(env, 'ONTOS_OIDC_ORG_CLAIM');
  const defaultOrg = nonEmpty(env, 'ONTOS_OIDC_DEFAULT_ORG');
  const permissionsClaim = nonEmpty(env, 'ONTOS_OIDC_PERMISSIONS_CLAIM');

  const identity = oidcIdentityProvider({
    issuer: requiredEnv(env, 'ONTOS_OIDC_ISSUER'),
    baseUrl: settings.auth.baseUrl,
    ...(jwksUri === undefined ? {} : { jwksUri }),
    ...(audience === undefined ? {} : { audience }),
    ...(mcpAudience === undefined ? {} : { mcpAudience }),
    ...(orgClaim === undefined ? {} : { orgClaim }),
    ...(defaultOrg === undefined ? {} : { defaultOrg }),
    ...(permissionsClaim === undefined ? {} : { permissionsClaim }),
    publish: oidcPublishFromEnv(env),
  });

  return {
    ...databasesFromEnv(env, createPool),
    settings,
    keys: unusedKeys(),
    users: identity.users,
    workos: identity.workos,
    identity,
    ...(options.onBackground === undefined ? {} : { onBackground: options.onBackground }),
  };
}

export function inputFromEnv(
  env: Env,
  createPool: PoolFactory,
  adapterNames: readonly string[] = [],
  options: InputOptions = {},
): HandleInput | MissingSettings {
  const rawMaxBodyBytes = nonEmpty(env, 'ONTOS_MAX_BODY_BYTES');

  if (rawMaxBodyBytes !== undefined && parsePositiveInteger(rawMaxBodyBytes) === undefined)
    return { missing: ['ONTOS_MAX_BODY_BYTES'] };

  const mode = parseAuthMode(env);

  if (mode === 'invalid') return { missing: ['ONTOS_AUTH_MODE'] };

  if (mode === 'dev') return devInputFromEnv(env, createPool, adapterNames, options);

  if (mode === 'oidc') return oidcInputFromEnv(env, createPool, adapterNames, options);

  const missing = [...WORKOS_REQUIRED, ...adapterNames].filter((name) =>
    name === 'ONTOLOGY_ENVIRONMENT' ? environmentFromEnv(env) === undefined : !env[name],
  );

  const baseUrl = nonEmpty(env, 'ONTOLOGY_BASE_URL');
  const authkitDomain = nonEmpty(env, 'AUTHKIT_DOMAIN');

  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) missing.push('ONTOLOGY_BASE_URL');

  if (authkitDomain !== undefined && !isDomain(authkitDomain)) missing.push('AUTHKIT_DOMAIN');

  if (missing.length === 0 && !trustedPair(env))
    missing.push('TRUSTED_GITHUB_REPOSITORY', 'TRUSTED_GITHUB_ENVIRONMENT');

  if (missing.length > 0) return { missing };

  const settings = settingsFromEnv(env);
  const keys = remoteKeys(settings.auth, { authkitDomain: settings.authkitDomain });
  const apiKey = requiredEnv(env, 'WORKOS_API_KEY');
  const users = workosUsers(apiKey, { onBackground: options.onBackground });
  const workos = workosPublish(apiKey);

  const identity = workosIdentityProvider({
    settings: settings.auth,
    authkitDomain: settings.authkitDomain,
    keys,
    users,
    workos,
  });

  return {
    ...databasesFromEnv(env, createPool),
    settings,
    keys,
    users,
    workos,
    identity,
    ...(options.onBackground === undefined ? {} : { onBackground: options.onBackground }),
  };
}
