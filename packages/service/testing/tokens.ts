import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';
import { type AuthSettings, type KeySource } from '../src/auth/index.ts';
import { attempt, settle, type AsyncFallible } from '../src/errors/index.ts';
import { AUTHKIT_DOMAIN, MCP_CLIENT, ORGANIZATION, PERSON, SERVICE_USER } from './tokenConstants.ts';

export * from './tokenConstants.ts';

/** The claims of a token. A claim with the value `undefined` is left out of the token. */
export type Claims = Readonly<Record<string, unknown>>;

interface SignOptions {
  /** `stranger` signs with a key that the key set does not hold, with the `kid` of the issuer's key. */
  readonly key?: 'own' | 'stranger';
  /** The `kid` in the token header. The default is the `kid` of the issuer's key. */
  readonly kid?: string;
}

export interface TestIssuer {
  /** The local key sets, for `HandleInput.keys`. */
  readonly keys: KeySource;
  /** The JWKS JSON of each issuer, for a test that serves it. */
  readonly jwks: { readonly workos: JSONWebKeySet; readonly github: JSONWebKeySet; readonly authkit: JSONWebKeySet };
  /** A WorkOS access token of a person. The defaults pass the checks of `settings`. */
  workos(claims?: Claims, options?: SignOptions): Promise<string>;
  /** A GitHub Actions OIDC token. The defaults are the app's publish workflow, and pass the checks of `settings`. */
  github(claims?: Claims, options?: SignOptions): Promise<string>;
  /** An AuthKit access token of an MCP client, for the MCP URL of `settings`. The defaults pass the checks of the MCP route. */
  authkit(claims?: Claims, options?: SignOptions): Promise<string>;
  /**
   * An M2M access token of a service user from the AuthKit issuer.
   * The defaults pass part 1 of the check of `settings`.
   */
  m2m(claims?: Claims, options?: SignOptions): Promise<string>;
}

/** The time now, in seconds, as JWT claims give it. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

const rejection = (error: unknown): unknown => error;

/** The public function that an app test calls. It rejects with the failure of the issuer. */
export async function createTestIssuer(settings: AuthSettings, authkitDomain = AUTHKIT_DOMAIN): Promise<TestIssuer> {
  const made = await settle(issuerOf(settings, authkitDomain));

  // oxlint-disable-next-line fallible/no-throw -- D1: createTestIssuer is the public testing API, and an app test reads its rejection.
  if (!made.ok) throw made.error;

  return made.value;
}

export async function* issuerOf(settings: AuthSettings, authkitDomain: string): AsyncFallible<TestIssuer, unknown> {
  const workos = yield* signer('workos-key');
  const github = yield* signer('github-key');
  const authkit = yield* signer('authkit-key');
  const { repository, environment } = settings.app;

  return {
    keys: {
      workos: createLocalJWKSet(workos.jwks),
      github: createLocalJWKSet(github.jwks),
      authkit: createLocalJWKSet(authkit.jwks),
    },
    jwks: { workos: workos.jwks, github: github.jwks, authkit: authkit.jwks },
    workos: (claims = {}, options = {}) =>
      workos.sign(
        {
          iss: `https://api.workos.com/user_management/${settings.workosClientId}`,
          sub: PERSON,
          client_id: settings.workosClientId,
          org_id: ORGANIZATION,
          role: 'member',
          sid: 'session_01TESTSESS0000000000000001',
          jti: crypto.randomUUID(),
          iat: now(),
          exp: now() + 300,
          ...claims,
        },
        options,
      ),
    github: (claims = {}, options = {}) =>
      github.sign(
        {
          iss: 'https://token.actions.githubusercontent.com',
          aud: settings.baseUrl,
          sub: `repo:${repository}:environment:${environment}`,
          repository,
          environment,
          ref: 'refs/heads/main',
          jti: crypto.randomUUID(),
          iat: now(),
          nbf: now() - 5,
          exp: now() + 300,
          ...claims,
        },
        options,
      ),
    authkit: (claims = {}, options = {}) =>
      authkit.sign(
        {
          iss: `https://${authkitDomain}`,
          sub: PERSON,
          aud: `${settings.baseUrl}/api/mcp`,
          client_id: MCP_CLIENT,
          org_id: ORGANIZATION,
          role: 'member',
          jti: crypto.randomUUID(),
          iat: now(),
          exp: now() + 300,
          ...claims,
        },
        options,
      ),
    m2m: (claims = {}, options = {}) =>
      authkit.sign(
        {
          iss: `https://${authkitDomain}`,
          aud: settings.workosClientId,
          sub: SERVICE_USER,
          client_id: SERVICE_USER,
          org_id: ORGANIZATION,
          scope: 'jobsite:read',
          jti: crypto.randomUUID(),
          iat: now(),
          exp: now() + 3600,
          ...claims,
        },
        options,
      ),
  };
}

interface Signer {
  readonly jwks: JSONWebKeySet;
  sign(claims: Claims, options: SignOptions): Promise<string>;
}

async function* signer(kid: string): AsyncFallible<Signer, unknown> {
  const own = yield* attempt(() => generateKeyPair('RS256', { extractable: true }), rejection);
  const stranger = yield* attempt(() => generateKeyPair('RS256'), rejection);
  const exported = yield* attempt(() => exportJWK(own.publicKey), rejection);
  const jwk = { ...exported, kid, alg: 'RS256', use: 'sig' };

  return {
    jwks: { keys: [jwk] },
    sign: (claims, options) => {
      const payload = Object.fromEntries(
        Object.entries(claims).filter(([, value]) => value !== undefined),
      ) as JWTPayload;

      const key = options.key === 'stranger' ? stranger.privateKey : own.privateKey;
      const jwt = new SignJWT(payload).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: options.kid ?? kid });

      return settle(attempt(() => jwt.sign(key), rejection)).then((signed) => {
        // oxlint-disable-next-line fallible/no-throw -- D1: each token function of the issuer is the public testing API, and an app test reads its rejection.
        if (!signed.ok) throw signed.error;

        return signed.value;
      });
    },
  };
}
