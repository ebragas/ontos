import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handle, routes, type HandleInput, type Settings } from './index.ts';
import { ONTOLOGY_RID, publishBody, startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { roleUsers } from '../people.test-utils.ts';
import { USE } from '../ontology/stored.test-utils.ts';
import { testInput } from '../service.test-utils.ts';
import { createTestIssuer, type Claims, type TestIssuer } from '../tokens.test-utils.ts';

type PublishRoute = Extract<(typeof routes)[number], { readonly access: 'publish' }>;

const publishRoute = routes.find((route): route is PublishRoute => route.access === 'publish');

if (!publishRoute) throw new Error('The route table has no publish route.');

const settings: Settings = {
  ...testInput.settings,
  productRid: ONTOLOGY_RID,
  auth: {
    workosClientId: 'client_test',
    baseUrl: 'https://ontology-staging.example.com',
    app: { repository: 'example/test-app', environment: 'publish-staging' },
  },
};

const body = publishBody(true);
let installed: InstalledOntology;
let issuer: TestIssuer;
let input: HandleInput;
let consoleLog: MockInstance<typeof console.log>;
let publishRun: MockInstance<PublishRoute['run']>;

beforeAll(async () => {
  installed = await startInstalled();

  issuer = await createTestIssuer(settings.auth);

  input = {
    ...installed.input,
    settings,
    keys: issuer.keys,
    users: roleUsers({ member: [USE, 'ontology:install'] }),
  };
});

afterAll(async () => {
  await installed?.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');

  publishRun = vi.spyOn(publishRoute, 'run');
});

afterEach(() => {
  consoleLog.mockRestore();

  publishRun.mockRestore();
});

function lastCaller(): unknown {
  return publishRun.mock.calls.at(-1)?.[1].caller;
}

function send(token: string, base = 'https://ontology-staging.example.com', handleInput = input): Promise<Response> {
  return handle(
    new Request(`${base}/api/ontology-service/v1/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    handleInput,
  );
}

function workflow(repository: string, environment: string | undefined, claims: Claims = {}): Promise<string> {
  const sub =
    environment === undefined ? `repo:${repository}:pull_request` : `repo:${repository}:environment:${environment}`;

  return issuer.github({ repository, environment, sub, ...claims });
}

async function expectCaller(response: Response, kind: string, user: string): Promise<void> {
  expect([response.status, 'version' in ((await response.json()) as object)]).toEqual([200, false]);

  expect(lastCaller()).toEqual({ user, kind });
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);

  expect(await response.json()).toEqual({
    errorCode: 'UNAUTHORIZED',
    errorName: 'Default:Unauthorized',
    errorInstanceId: expect.any(String),
    parameters: {},
  });
}

describe('the 2 issuers', () => {
  it('a WorkOS token of the app passes', async () => {
    const response = await send(await issuer.workos());

    expect([response.status, 'version' in ((await response.json()) as object)]).toEqual([200, false]);

    expect(lastCaller()).toEqual({
      user: 'user_01TEST00000000000000000001',
      kind: 'person',
      organization: 'org_01TEST0RG00000000000000001',
    });
  });

  it('a GitHub Actions token passes', async () => {
    await expectCaller(
      await send(await workflow('example/test-app', 'publish-staging')),
      'publish',
      'repo:example/test-app:environment:publish-staging',
    );
  });

  it('a token of a third issuer gets 401', async () => {
    await expectUnauthorized(
      await send(await workflow('example/test-app', 'publish-staging', { iss: 'https://gitlab.example.com' })),
    );
  });
});

describe('service/authentication#ci-workflows: a GitHub token passes only when all its checks pass', () => {
  it('service/authentication#ci-workflows: a token with each claim right passes', async () => {
    await expectCaller(
      await send(await workflow('example/test-app', 'publish-staging')),
      'publish',
      'repo:example/test-app:environment:publish-staging',
    );
  });

  it.each([
    ['a token signed by a key that is not in the GitHub JWKS', { key: 'stranger' as const }],
    ['a token with a kid that the GitHub JWKS does not have', { kid: 'unknown-key' }],
  ])('service/authentication#ci-workflows: %s gets 401', async (_case, options) => {
    await expectUnauthorized(await send(await issuer.github({}, options)));
  });

  it('service/authentication#ci-workflows: an expired token gets 401', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expectUnauthorized(await send(await issuer.github({ iat: now - 600, nbf: now - 600, exp: now - 300 })));
  });

  it('service/authentication#ci-workflows: a GitHub token signed by the WorkOS key gets 401', async () => {
    const workos = await issuer.workos({
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'https://ontology-staging.example.com',
      sub: 'repo:example/test-app:environment:publish-staging',
      repository: 'example/test-app',
      environment: 'publish-staging',
      client_id: undefined,
    });

    await expectUnauthorized(await send(workos));
  });
});

describe('service/authentication#ci-workflows: the iss of a GitHub token', () => {
  it('service/authentication#ci-workflows: iss https://token.actions.githubusercontent.com passes', async () => {
    const token = await workflow('example/test-app', 'publish-staging', {
      iss: 'https://token.actions.githubusercontent.com',
    });

    await expectCaller(await send(token), 'publish', 'repo:example/test-app:environment:publish-staging');
  });

  it('service/authentication#ci-workflows: the iss of GitHub Enterprise Server gets 401', async () => {
    const token = await workflow('example/test-app', 'publish-staging', {
      iss: 'https://ghe.example.com/_services/token',
    });

    await expectUnauthorized(await send(token));
  });
});

describe('service/authentication#ci-workflows: aud is the base URL of the environment', () => {
  it('service/authentication#ci-workflows: aud as the base URL passes on the base URL', async () => {
    const token = await workflow('example/test-app', 'publish-staging', {
      aud: 'https://ontology-staging.example.com',
    });

    await expectCaller(await send(token), 'publish', 'repo:example/test-app:environment:publish-staging');
  });

  it('service/authentication#ci-workflows: aud as the base URL passes on a Vercel deployment URL', async () => {
    const token = await workflow('example/test-app', 'publish-staging', {
      aud: 'https://ontology-staging.example.com',
    });

    const response = await send(token, 'https://ontology-service-k3j2h1g0f-example-org.vercel.app');

    await expectCaller(response, 'publish', 'repo:example/test-app:environment:publish-staging');
  });

  it('service/authentication#ci-workflows: aud as the Vercel deployment URL of the request gets 401', async () => {
    const deployment = 'https://ontology-service-k3j2h1g0f-example-org.vercel.app';

    const token = await workflow('example/test-app', 'publish-staging', { aud: deployment });

    await expectUnauthorized(await send(token, deployment));
  });

  it('service/authentication#ci-workflows: the default aud of GitHub, the owner URL, gets 401', async () => {
    const token = await workflow('example/test-app', 'publish-staging', { aud: 'https://github.com/example' });

    await expectUnauthorized(await send(token));
  });

  it('service/authentication#ci-workflows: the base URL of another environment gets 401', async () => {
    const token = await workflow('example/test-app', 'publish-staging', { aud: 'https://ontos.example.com' });

    await expectUnauthorized(await send(token));
  });

  it('service/authentication#ci-workflows: a token with no aud gets 401', async () => {
    await expectUnauthorized(await send(await workflow('example/test-app', 'publish-staging', { aud: undefined })));
  });
});

const environmentSettings = (repository: string, environment: string): HandleInput => ({
  ...input,
  settings: { ...settings, auth: { ...settings.auth, app: { repository, environment } } },
});

describe('service/authentication#ci-workflows: repository is the repository of a trusted pair of the environment', () => {
  it('service/authentication#ci-workflows: the trusted repository passes', async () => {
    await expectCaller(
      await send(await workflow('example/test-app', 'publish-staging')),
      'publish',
      'repo:example/test-app:environment:publish-staging',
    );
  });

  it.each([
    ['another repository, with the trusted environment', 'example/other-app', 'publish-staging'],
    ['another repository, with no environment', 'example/other-app', undefined],
    ['a fork of the app, with the trusted environment', 'someone/test-app', 'publish-staging'],
    ['this repo, with its release environment', 'ebragas/ontos', 'release'],
  ])('service/authentication#ci-workflows: %s gets 401', async (_case, repository, environment) => {
    await expectUnauthorized(await send(await workflow(repository, environment)));
  });

  it('service/authentication#ci-workflows: the repository claim decides, not the sub', async () => {
    const token = await workflow('example/other-app', 'publish-staging', {
      sub: 'repo:example/test-app:environment:publish-staging',
    });

    await expectUnauthorized(await send(token));
  });

  it('service/authentication#ci-workflows: a token with no repository gets 401', async () => {
    await expectUnauthorized(
      await send(await workflow('example/test-app', 'publish-staging', { repository: undefined })),
    );
  });
});

describe('service/authentication#ci-workflows: environment is the environment of a trusted pair of the environment', () => {
  it('service/authentication#ci-workflows: the trusted repository with no environment is a pull request check', async () => {
    await expectCaller(
      await send(await workflow('example/test-app', undefined)),
      'check',
      'repo:example/test-app:pull_request',
    );
  });

  it('service/authentication#ci-workflows: the environment claim decides, not the sub', async () => {
    const token = await workflow('example/test-app', undefined, {
      sub: 'repo:example/test-app:environment:publish-staging',
    });

    await expectCaller(await send(token), 'check', 'repo:example/test-app:environment:publish-staging');
  });

  it('service/authentication#ci-workflows: the trusted repository with another environment gets 401, because only a token with no environment is a pull request check', async () => {
    await expectUnauthorized(await send(await workflow('example/test-app', 'release')));
  });
});

describe('service/authentication#ci-workflows: an app trusts only its Ontology deployment repository, in the environment of each branch', () => {
  const staging = () => environmentSettings('example/acme-ontology', 'ontology-staging');
  const production = () => environmentSettings('example/acme-ontology', 'ontology-production');
  const base = 'https://ontology-staging.example.com';

  it('service/authentication#ci-workflows: a token of ontology-staging passes in staging, and fails in production', async () => {
    const token = await workflow('example/acme-ontology', 'ontology-staging');

    await expectCaller(
      await send(token, base, staging()),
      'publish',
      'repo:example/acme-ontology:environment:ontology-staging',
    );

    await expectUnauthorized(await send(token, base, production()));
  });

  it('service/authentication#ci-workflows: a token of ontology-production passes in production, and fails in staging', async () => {
    const token = await workflow('example/acme-ontology', 'ontology-production');

    await expectCaller(
      await send(token, base, production()),
      'publish',
      'repo:example/acme-ontology:environment:ontology-production',
    );

    await expectUnauthorized(await send(token, base, staging()));
  });
});

describe('service/authentication#ci-workflows: a deployment trusts only its configured repository and environment', () => {
  const base = 'https://ontology-staging.example.com';

  it('service/authentication#ci-workflows: a token for a repository and environment fails on another deployment and passes on its own', async () => {
    const token = await workflow('ebragas/ontos', 'gate');

    for (const environment of ['ontology-staging', 'ontology-production']) {
      await expectUnauthorized(await send(token, base, environmentSettings('example/acme-ontology', environment)));
    }

    await expectCaller(
      await send(token, base, environmentSettings('ebragas/ontos', 'gate')),
      'publish',
      'repo:ebragas/ontos:environment:gate',
    );
  });
});

describe('service/authentication#ci-workflows the trusted pair comes from the settings of the deployment', () => {
  it('service/authentication#ci-workflows: the pair of the settings passes, and the pair of other settings fails', async () => {
    const other = environmentSettings('example/prod-app', 'publish');
    const base = 'https://ontology-staging.example.com';

    await expectCaller(
      await send(await workflow('example/prod-app', 'publish'), base, other),
      'publish',
      'repo:example/prod-app:environment:publish',
    );

    await expectUnauthorized(await send(await workflow('example/test-app', 'publish-staging'), base, other));
  });
});

describe('the user ID of a CI workflow is the GitHub subject', () => {
  it('a GitHub token gives its sub as it is, as the user ID', async () => {
    const sub = 'repo:example@123456/test-app@456789:environment:publish-staging';

    const token = await workflow('example/test-app', 'publish-staging', { sub });

    await expectCaller(await send(token), 'publish', sub);
  });
});

describe('service/authentication#ci-workflows: a token of the trusted pair is the publish caller', () => {
  it('service/authentication#ci-workflows: the trusted repository with the trusted environment is the publish caller', async () => {
    await expectCaller(
      await send(await workflow('example/test-app', 'publish-staging')),
      'publish',
      'repo:example/test-app:environment:publish-staging',
    );
  });

  it('service/authentication#ci-workflows: another repository with the trusted environment gets 401', async () => {
    await expectUnauthorized(await send(await workflow('example/test-web-app', 'publish-staging')));
  });
});
