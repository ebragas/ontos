import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authSettingsFromEnv } from '../auth/index.ts';
import { handle, inputFromEnv, settingsFromEnv } from './index.ts';
import { testEnv } from '../service.test-utils.ts';
import { createTestIssuer } from '../tokens.test-utils.ts';

describe('settingsFromEnv', () => {
  it('reads each setting', () => {
    expect(settingsFromEnv(testEnv)).toEqual({
      productRid: 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000',
      environment: 'staging',
      auth: authSettingsFromEnv(testEnv),
      authkitDomain: 'test-app.authkit.app',
    });
  });

  it('service/deployment#deployment-files: PRODUCT_RID is required, and ONTOLOGY_RID is not read', () => {
    expect(() => settingsFromEnv({ ...testEnv, PRODUCT_RID: undefined })).toThrow('PRODUCT_RID');

    const settings = settingsFromEnv({
      ...testEnv,
      ONTOLOGY_RID: 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111',
    });

    expect(settings.productRid).toBe('ri.ontology.main.ontology.00000000-0000-4000-8000-000000000000');
    expect(settings).not.toHaveProperty('ontologyRid');
  });

  it('service/authentication#ci-workflows: trusts only the pair of TRUSTED_GITHUB_REPOSITORY and TRUSTED_GITHUB_ENVIRONMENT', () => {
    expect(authSettingsFromEnv(testEnv).app).toEqual({
      repository: 'example/test-app',
      environment: 'publish-staging',
    });

    expect(
      authSettingsFromEnv({
        ...testEnv,
        TRUSTED_GITHUB_REPOSITORY: 'ebragas/ontos',
        TRUSTED_GITHUB_ENVIRONMENT: 'release',
      }).app,
    ).toEqual({
      repository: 'ebragas/ontos',
      environment: 'release',
    });
  });

  it('service/deployment#deployment-files: the auth settings hold 1 trusted repository and 1 trusted GitHub environment', () => {
    const env = {
      ...testEnv,
      TRUSTED_GITHUB_REPOSITORY: 'example/acme-ontology',
      TRUSTED_GITHUB_ENVIRONMENT: 'ontology-staging',
    };

    expect(authSettingsFromEnv(env)).toEqual({
      workosClientId: testEnv.WORKOS_CLIENT_ID,
      baseUrl: testEnv.ONTOLOGY_BASE_URL,
      app: { repository: 'example/acme-ontology', environment: 'ontology-staging' },
    });
  });

  it.each([
    ['a comma list of repositories', 'example/acme-ontology,example/acme-web-app', 'ontology-staging'],
    ['a comma list of environments', 'example/acme-ontology', 'ontology-staging,ontology-production'],
    ['2 pairs', 'example/acme-ontology,example/acme-web-app', 'ontology-staging,ontology-staging'],
    ['a trailing comma', 'example/acme-ontology,', 'ontology-staging'],
    ['a space before the repository', ' example/acme-ontology', 'ontology-staging'],
    ['a space after the environment', 'example/acme-ontology', 'ontology-staging '],
  ])(
    'service/deployment#deployment-files: %s makes settingsFromEnv throw, and the error names both variables',
    (_case, repository, environment) => {
      const env = { ...testEnv, TRUSTED_GITHUB_REPOSITORY: repository, TRUSTED_GITHUB_ENVIRONMENT: environment };

      expect(() => settingsFromEnv(env)).toThrow(/TRUSTED_GITHUB_REPOSITORY and TRUSTED_GITHUB_ENVIRONMENT/);
    },
  );

  it('service/deployment#deployment-files: the service starts with no ONTOLOGY_MCP and no LOG_REQUEST_BODIES, with both features off', () => {
    const settings = settingsFromEnv(testEnv);

    expect(settings).not.toHaveProperty('mcp');
    expect(settings).not.toHaveProperty('logRequestBodies');
  });

  it('service/deployment#deployment-files: ONTOLOGY_MCP true gives mcp, and LOG_REQUEST_BODIES true gives logRequestBodies', () => {
    const settings = settingsFromEnv({ ...testEnv, ONTOLOGY_MCP: 'true', LOG_REQUEST_BODIES: 'true' });

    expect(settings.mcp).toBe(true);
    expect(settings.logRequestBodies).toBe(true);
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'service/deployment#deployment-files: ONTOLOGY_MCP %j keeps the MCP off',
    (value) => {
      expect(settingsFromEnv({ ...testEnv, ONTOLOGY_MCP: value })).not.toHaveProperty('mcp');
    },
  );

  it('service/deployment#deployment-files: AUTHKIT_DOMAIN gives authkitDomain, with the MCP off', () => {
    const settings = settingsFromEnv({ ...testEnv, AUTHKIT_DOMAIN: 'elegant-tune-12-staging.authkit.app' });

    expect(settings.authkitDomain).toBe('elegant-tune-12-staging.authkit.app');
    expect(settings).not.toHaveProperty('mcp');
  });

  it('service/deployment#deployment-files: ONTOLOGY_LOAD_DERIVED_PROPERTIES true gives loadDerivedProperties, and no value leaves it off', () => {
    expect(settingsFromEnv({ ...testEnv, ONTOLOGY_LOAD_DERIVED_PROPERTIES: 'true' }).loadDerivedProperties).toBe(true);
    expect(settingsFromEnv(testEnv)).not.toHaveProperty('loadDerivedProperties');
  });

  it.each(['', 'false', 'TRUE', '1'])(
    'service/deployment#deployment-files: ONTOLOGY_LOAD_DERIVED_PROPERTIES %j keeps the setting off',
    (value) => {
      expect(settingsFromEnv({ ...testEnv, ONTOLOGY_LOAD_DERIVED_PROPERTIES: value })).not.toHaveProperty(
        'loadDerivedProperties',
      );
    },
  );

  it.each(['', 'false', 'TRUE', '1'])(
    'service/deployment#deployment-files: LOG_REQUEST_BODIES %j keeps the request bodies off',
    (value) => {
      expect(settingsFromEnv({ ...testEnv, LOG_REQUEST_BODIES: value })).not.toHaveProperty('logRequestBodies');
    },
  );

  it.each(Object.keys(testEnv))('throws when %s is missing', (name) => {
    const env = { ...testEnv, [name]: undefined };

    expect(() => settingsFromEnv(env)).toThrow(name);
  });

  it.each(Object.keys(testEnv))('throws when %s is empty', (name) => {
    expect(() => settingsFromEnv({ ...testEnv, [name]: '' })).toThrow(name);
  });
});

describe('inputFromEnv', () => {
  const env = {
    ...testEnv,
    DATABASE_URL: 'postgresql://localhost/pooled',
    DATABASE_URL_DIRECT: 'postgresql://localhost/direct',
    WORKOS_API_KEY: 'sk_test',
  };

  const newPool = (connectionString: string) => new pg.Pool({ connectionString });
  const poolSpy = () => vi.spyOn({ newPool }, 'newPool');

  const KEY_SETS = [
    'https://api.workos.com/sso/jwks/client_test',
    'https://test-app.authkit.app/oauth2/jwks',
    'https://token.actions.githubusercontent.com/.well-known/jwks',
  ];

  const fetched: string[] = [];

  const network = setupServer(
    ...KEY_SETS.map((url) =>
      http.get(url, ({ request }) => {
        fetched.push(request.url);

        return HttpResponse.json({ keys: [] });
      }),
    ),
  );

  beforeAll(() => network.listen({ onUnhandledFrame: 'error' }));

  afterAll(() => network.close());

  it('makes 1 pool from DATABASE_URL and 1 from DATABASE_URL_DIRECT when they differ, with the settings', () => {
    const createPool = poolSpy();
    const input = inputFromEnv(env, createPool);

    expect(input).toMatchObject({ settings: settingsFromEnv(env) });
    expect('db' in input && input.db !== input.directDb).toBe(true);
    expect(createPool.mock.calls).toEqual([[env.DATABASE_URL], [env.DATABASE_URL_DIRECT]]);
  });

  it.each([
    ['omitted', undefined],
    ['empty', ''],
    ['equal to DATABASE_URL', env.DATABASE_URL],
  ])('shares 1 pool and Db instance when DATABASE_URL_DIRECT is %s', (_case, direct) => {
    const createPool = poolSpy();
    const input = inputFromEnv({ ...env, DATABASE_URL_DIRECT: direct }, createPool);

    expect('db' in input && input.db === input.directDb).toBe(true);
    expect(createPool.mock.calls).toEqual([[env.DATABASE_URL]]);
  });

  it('service/deployment#deployment-files: names each missing variable, in the order of the table, and the adapter names after them, with no pool', () => {
    const createPool = poolSpy();

    expect(inputFromEnv({ ...env, DATABASE_URL: '', PRODUCT_RID: undefined }, createPool, ['SENTRY_DSN'])).toEqual({
      missing: ['PRODUCT_RID', 'DATABASE_URL', 'SENTRY_DSN'],
    });

    expect(createPool).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('service/deployment#deployment-files: a %s AUTHKIT_DOMAIN is a missing setting, with no pool', (_case, value) => {
    const createPool = poolSpy();

    expect(inputFromEnv({ ...env, AUTHKIT_DOMAIN: value }, createPool)).toEqual({ missing: ['AUTHKIT_DOMAIN'] });
    expect(createPool).not.toHaveBeenCalled();
  });

  it('service/deployment#deployment-files: with a missing AUTHKIT_DOMAIN, a request gets 503 OntologyService:SettingMissing', async () => {
    const log = vi.spyOn(console, 'log');

    try {
      const input = inputFromEnv({ ...env, AUTHKIT_DOMAIN: undefined }, newPool);

      const response = await handle(new Request('http://localhost/api/v2/ontologies'), input);

      expect(response.status).toBe(503);

      expect(await response.json()).toEqual({
        errorCode: 'INTERNAL',
        errorName: 'OntologyService:SettingMissing',
        errorInstanceId: expect.any(String),
        parameters: {},
      });

      expect(JSON.parse(String(log.mock.calls[0]?.[0])).stack).toContain(
        'These environment variables are missing or not valid: AUTHKIT_DOMAIN.',
      );
    } finally {
      log.mockRestore();
    }
  });

  it('service/authentication#tokens: the production input reads only the listed settings, so no other environment variable changes the trusted issuers', () => {
    const read = new Set<string>();

    const values: Record<string, string> = {
      ...env,
      SENTRY_DSN: 'https://key@sentry.test/1',
      NODE_ENV: 'test',
      ONTOLOGY_TEST_ISSUER: 'true',
      WORKOS_JWKS_URL: 'http://127.0.0.1:1/jwks',
    };

    const watched = new Proxy(values, {
      get: (_target, name) => {
        if (typeof name !== 'string') return undefined;

        read.add(name);

        return values[name];
      },
    });

    expect(inputFromEnv(watched, newPool, ['SENTRY_DSN'])).toHaveProperty('keys');

    expect([...read].sort()).toEqual([
      'AUTHKIT_DOMAIN',
      'DATABASE_URL',
      'DATABASE_URL_DIRECT',
      'LOG_REQUEST_BODIES',
      'ONTOLOGY_BASE_URL',
      'ONTOLOGY_ENVIRONMENT',
      'ONTOLOGY_LOAD_DERIVED_PROPERTIES',
      'ONTOLOGY_MCP',
      'ONTOS_AUTH_MODE',
      'ONTOS_MAX_BODY_BYTES',
      'PRODUCT_RID',
      'SENTRY_DSN',
      'TRUSTED_GITHUB_ENVIRONMENT',
      'TRUSTED_GITHUB_REPOSITORY',
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_ID',
    ]);
  });

  it('service/authentication#tokens: with the production input, a token of the test issuer gets 401, and the keys come only from the remote key sets of the 3 issuers', async () => {
    const log = vi.spyOn(console, 'log');

    try {
      const input = inputFromEnv(env, newPool);

      const issuer = await createTestIssuer(settingsFromEnv(env).auth);

      const person = await handle(
        new Request('http://localhost/api/v2/admin/users/getCurrent', {
          headers: { authorization: `Bearer ${await issuer.workos()}` },
        }),
        input,
      );

      const job = await handle(
        new Request('http://localhost/api/v2/admin/users/getCurrent', {
          headers: { authorization: `Bearer ${await issuer.github()}` },
        }),
        input,
      );

      const service = await handle(
        new Request('http://localhost/api/v2/admin/users/getCurrent', {
          headers: { authorization: `Bearer ${await issuer.m2m()}` },
        }),
        input,
      );

      expect([person.status, job.status, service.status]).toEqual([401, 401, 401]);
      expect([...new Set(fetched)].sort()).toEqual(KEY_SETS);
    } finally {
      log.mockRestore();
    }
  });
});
