import { invariant } from '../errors/index.ts';
import type { AuthSettings, GithubTrust } from './caller.ts';

export function mcpUrl(baseUrl: string): string {
  return `${baseUrl}/api/mcp`;
}

export function metadataUrl(baseUrl: string): string {
  return `${baseUrl}/api/oauth-protected-resource`;
}

export function authSettingsFromEnv(env: Readonly<Record<string, string | undefined>>): AuthSettings {
  const app = trustedPair(env);

  invariant(
    app,
    'TRUSTED_GITHUB_REPOSITORY and TRUSTED_GITHUB_ENVIRONMENT must each hold 1 value, with no comma and no space at either end.',
  );

  return {
    workosClientId: requiredEnv(env, 'WORKOS_CLIENT_ID'),
    baseUrl: requiredEnv(env, 'ONTOLOGY_BASE_URL'),
    app,
  };
}

export function trustedPair(env: Readonly<Record<string, string | undefined>>): GithubTrust | undefined {
  const { TRUSTED_GITHUB_REPOSITORY: repository = '', TRUSTED_GITHUB_ENVIRONMENT: environment = '' } = env;

  return [repository, environment].every((value) => value !== '' && !value.includes(',') && value === value.trim())
    ? { repository, environment }
    : undefined;
}

export function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];

  invariant(value, `The environment variable ${name} is not set.`);

  return value;
}
