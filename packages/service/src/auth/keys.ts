import { createRemoteJWKSet, customFetch, type FetchImplementation, type JWTVerifyGetKey } from 'jose';
import { invariant } from '../errors/index.ts';
import { span } from '../spans/index.ts';
import type { AuthSettings } from './caller.ts';
import { WORKOS_API } from './users.ts';
import { GITHUB_ISSUER } from './workosCalls.ts';

export function authkitIssuer(authkitDomain: string): string {
  return `https://${authkitDomain}`;
}

export interface KeySource {
  readonly workos: JWTVerifyGetKey;
  readonly github: JWTVerifyGetKey;
  readonly authkit: JWTVerifyGetKey;
}

interface RemoteKeysOptions {
  readonly fetch?: FetchImplementation;
  readonly authkitDomain?: string | undefined;
}

async function missingAuthkitDomain(): Promise<never> {
  invariant(false, 'AUTHKIT_DOMAIN is not set.');
}

async function unusedKey(): Promise<never> {
  invariant(false, 'KeySource is not used when IdentityProvider handles authentication.');
}

export function unusedKeys(): KeySource {
  return { workos: unusedKey, github: unusedKey, authkit: unusedKey };
}

export function remoteJwks(url: string, fetchImpl?: FetchImplementation): JWTVerifyGetKey {
  const fetchJwks: FetchImplementation = (target, init) =>
    span('jwks fetch', {}, async (s) => {
      // D1: jose reads the rejection of its fetch, and a rejection of the network fetch passes on as it is.
      const response = await (fetchImpl ?? globalThis.fetch)(target, init);

      s.set('http.status_code', response.status);

      return response;
    });

  return createRemoteJWKSet(new URL(url), { [customFetch]: fetchJwks });
}

export function remoteKeys(settings: AuthSettings, options: RemoteKeysOptions = {}): KeySource {
  const remote = (url: string) => remoteJwks(url, options.fetch);

  return {
    workos: remote(`${WORKOS_API}/sso/jwks/${settings.workosClientId}`),
    github: remote(`${GITHUB_ISSUER}/.well-known/jwks`),
    authkit:
      options.authkitDomain === undefined
        ? missingAuthkitDomain
        : remote(`${authkitIssuer(options.authkitDomain)}/oauth2/jwks`),
  };
}
