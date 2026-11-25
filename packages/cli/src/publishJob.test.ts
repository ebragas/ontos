import type { PublishResponse } from '@ericbragas/ontos-service/publish';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTES_GRANTS, NOTES_ONTOLOGY, NO_MIGRATIONS, notesApp } from './apps.test-utils.ts';
import { ACME } from './deployment.fixture.ts';
import type { CliError } from './cliError.ts';
import { answerOf } from './fallible.ts';
import { npmRegistry } from './sdk/sdkPackage.ts';
import {
  cli,
  stubMetadata,
  STUB,
  stubConfig,
  stubFetch,
  stubRegistry,
  tempFolder,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const TOKEN = 'job-token-6b1f0c2e9d';
const env = { ONTOLOGY_TOKEN: TOKEN };
const flags = ['--app', 'notes', '--url', STUB, '--env', 'production'];
const PUBLISH = `${STUB}/api/ontology-service/v1/publish`;
const CLIENT_CONFIG = `${STUB}/api/ontology-service/v1/client-config`;

const STORED: PublishResponse = {
  changes: [],
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The fixture is a synthetic fullMetadata payload, and stubMetadata gives it as a plain record.
  metadata: stubMetadata() as unknown as PublishResponse['metadata'],
  version: 2,
};

function publishRoute(answer: PublishResponse = STORED): Handler {
  return ({ method, url }) => (method === 'POST' && url === PUBLISH ? Response.json(answer) : undefined);
}

const refusingRoute =
  (status: number, body: unknown): Handler =>
  ({ method, url }) =>
    method === 'POST' && url === PUBLISH ? Response.json(body, { status }) : undefined;

const productionConfig: Handler = ({ method, url }) =>
  method === 'GET' && url === CLIENT_CONFIG
    ? Response.json({ productRid: ACME.productRid, workosClientId: 'client_01STUB', environment: 'production' })
    : undefined;

function registry() {
  const stub = stubRegistry();
  const publish = stub.publish.bind(stub);
  const tag = stub.tag.bind(stub);
  const calls: string[] = [];
  const hashes: string[] = [];

  return Object.assign(stub, {
    calls,
    hashes,
    find: (_name: string, ontologyHash: string) => {
      calls.push('find');

      hashes.push(ontologyHash);

      return answerOf<string | undefined, CliError>(Promise.resolve('0.0.7'));
    },
    publish: (...args: Parameters<typeof publish>) => {
      calls.push('publish');

      return publish(...args);
    },
    tag: (...args: Parameters<typeof tag>) => {
      calls.push('tag');

      return tag(...args);
    },
  });
}

const app = () => notesApp({ '.ontology/deployment.json': JSON.stringify(ACME) });

async function runJob(args: readonly string[], environment: 'production' | 'staging', ...handlers: Handler[]) {
  const fetch = stubFetch(...(environment === 'production' ? [productionConfig] : []), ...handlers, stubConfig);
  const packages = registry();

  const run = await cli(args, { cwd: app(), fetch, env, registry: packages });

  return {
    ...run,
    fetch,
    packages,
    lines: run.stderr
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const job = (command: 'publish' | 'validate', ...handlers: Handler[]) =>
  runJob([command, ...flags], 'production', ...handlers);

const serviceCalls = (calls: readonly Call[]) =>
  calls.flatMap(({ method, url }) =>
    url.startsWith(`${STUB}/`) && url !== CLIENT_CONFIG ? [`${method} ${new URL(url).pathname}`] : [],
  );

const PUBLISH_CALL = 'POST /api/ontology-service/v1/publish';

const TAGGED = {
  name: '@ontos/notes-ontology-sdk',
  version: '0.0.7',
  ontologyHash: expect.any(String) as unknown,
  action: 'tagged',
};

describe('the publish job', () => {
  it('service/cli#publish-job: publish releases the Ontology SDK package of the version that the publish call answers, with no other call to the service', async () => {
    const run = await job('publish', publishRoute());

    expect(run.code).toBe(0);
    expect(serviceCalls(run.fetch.calls)).toEqual([PUBLISH_CALL]);
    expect(run.output).toEqual({ changes: [], metadata: STORED.metadata, version: 2, ontologySdk: TAGGED });
    expect(run.packages.calls).toEqual(['find', 'tag', 'tag']);

    expect(run.packages.tags.map(({ tag, version }) => `${tag}@${version}`)).toEqual([
      'production@0.0.7',
      'latest@0.0.7',
    ]);

    expect(run.packages.hashes).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    const renamed = {
      ...STORED.metadata,
      ontology: { ...STORED.metadata.ontology, displayName: 'Renamed' },
    } as PublishResponse['metadata'];

    const other = await job('publish', publishRoute({ ...STORED, metadata: renamed }));

    expect(other.packages.hashes).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(other.packages.hashes).not.toEqual(run.packages.hashes);
    expect(run.stderr).toBe('');
    expect(`${run.stdout}${run.stderr}`).not.toContain(TOKEN);

    expect(run.fetch.calls.filter(({ url }) => url === PUBLISH).map(({ headers }) => headers['authorization'])).toEqual(
      [`Bearer ${TOKEN}`],
    );
  });

  it('service/cli#publish-job: the output of publish on stdout holds the transactionMs of the publish answer', async () => {
    const run = await job('publish', publishRoute({ ...STORED, transactionMs: 812 }));

    expect(run.code).toBe(0);

    expect(run.output).toEqual({
      changes: [],
      metadata: STORED.metadata,
      version: 2,
      transactionMs: 812,
      ontologySdk: TAGGED,
    });
  });

  it('service/cli#publish-job: when the data of 1 installation blocks the publish, the job exits 1, prints the error body with ontologyRid, change, and transactionMs, and makes no call to the package registry', async () => {
    const blocked = {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'Default:InvalidArgument',
      errorInstanceId: 'e-400',
      parameters: {
        change: 'Make Property title required of Object Type Note',
        objectType: 'Note',
        property: 'title',
        badObjects: 1,
        primaryKeys: ['n-1'],
        ontologyRid: 'ri.ontology.main.ontology.acme',
        transactionMs: 812,
      },
    };

    const run = await job('publish', refusingRoute(400, blocked));

    expect(run.code).toBe(1);
    expect(run.lines).toEqual([blocked]);
    expect(run.stdout).toBe('');
    expect(serviceCalls(run.fetch.calls)).toEqual([PUBLISH_CALL]);
    expect(run.packages.calls).toEqual([]);
  });

  it('service/publish#default-roles-in-workos service/cli#publish-job service/publish#reconcile: after a 503 with reconciled false, the job exits 1 and makes no call to the package registry, and the rerun releases the package', async () => {
    const unreconciled = {
      errorCode: 'INTERNAL',
      errorName: 'OntologyService:WorkosUnavailable',
      errorInstanceId: 'e-503',
      parameters: { version: 2, reconciled: false, transactionMs: 812 },
    };

    const failed = await job('publish', refusingRoute(503, unreconciled));

    expect([failed.code, failed.stdout, failed.lines, failed.packages.calls]).toEqual([1, '', [unreconciled], []]);
    expect(serviceCalls(failed.fetch.calls)).toEqual([PUBLISH_CALL]);

    const rerun = await job('publish', publishRoute({ ...STORED, transactionMs: 3 }));

    expect([rerun.code, rerun.output, rerun.packages.calls]).toEqual([
      0,
      { changes: [], metadata: STORED.metadata, version: 2, transactionMs: 3, ontologySdk: TAGGED },
      ['find', 'tag', 'tag'],
    ]);

    expect(serviceCalls(rerun.fetch.calls)).toEqual([PUBLISH_CALL]);
  });

  it('service/cli#publish-job: validate runs only the publish call with validateOnly', async () => {
    const run = await job('validate', publishRoute());

    expect(run.code).toBe(0);
    expect(serviceCalls(run.fetch.calls)).toEqual([PUBLISH_CALL]);

    expect(JSON.parse(run.fetch.calls.find(({ url }) => url === PUBLISH)?.body ?? '{}')).toMatchObject({
      validateOnly: true,
    });

    expect(run.stderr).toBe('');
    expect(run.packages.calls).toEqual([]);
  });
});

describe('publish --skip-sdk-package', () => {
  const SKIP = '--skip-sdk-package';
  const target = (environment: 'production' | 'staging') => ['--app', 'notes', '--url', STUB, '--env', environment];
  const WARNING = 'The RoleInUse check did not run, because only the publish workflow and a pull request check run it.';

  it('service/cli#publish-job: publish --skip-sdk-package makes no call to the package registry, moves no tag, and its output has no ontologySdk', async () => {
    for (const [environment, registryCalls, action] of [
      ['production', ['find', 'tag', 'tag'], 'tagged'],
      ['staging', ['find'], 'unchanged'],
    ] as const) {
      const plain = await runJob(['publish', ...target(environment)], environment, publishRoute());

      expect(plain.code).toBe(0);
      expect(plain.packages.calls).toEqual(registryCalls);

      expect(plain.output).toMatchObject({
        version: 2,
        ontologySdk: { name: '@ontos/notes-ontology-sdk', version: '0.0.7', action },
      });

      const skipped = await runJob(['publish', ...target(environment), SKIP], environment, publishRoute());

      expect(skipped.code).toBe(0);
      expect(skipped.packages.calls).toEqual([]);
      expect(skipped.packages.tags).toEqual([]);
      expect(skipped.packages.published).toEqual([]);
      expect(skipped.output).toEqual({ changes: [], metadata: STORED.metadata, version: 2 });
      expect(skipped.fetch.calls.every(({ url }) => url.startsWith(`${STUB}/`))).toBe(true);
      expect(serviceCalls(skipped.fetch.calls)).toEqual([PUBLISH_CALL]);
    }

    const none = Object.assign(stubRegistry(), { calls: [] });

    const staging = await cli(['publish', ...target('staging'), SKIP], {
      cwd: app(),
      fetch: stubFetch(publishRoute(), stubConfig),
      env,
      registry: none,
    });

    expect(staging.code).toBe(0);
    expect(none.published).toEqual([]);
  });

  it('service/cli#publish-job: only publish takes --skip-sdk-package: validate and each other command exit 1, and call nothing', async () => {
    const validate = await runJob(['validate', ...flags, SKIP], 'production', publishRoute());

    expect(validate.code).toBe(1);
    expect(validate.error).toEqual({ message: 'ontos validate does not take --skip-sdk-package.' });
    expect(validate.fetch.calls).toEqual([]);
    expect(validate.packages.calls).toEqual([]);
    expect(validate.stdout).toBe('');

    for (const [args, message] of [
      [['install', 'notes', ...flags], 'ontos install does not take --skip-sdk-package.'],
      [['describe', ...flags], 'ontos describe does not take --skip-sdk-package.'],
      [['generate-osdk'], 'ontos generate-osdk does not take --skip-sdk-package.'],
    ] as const) {
      const run = await runJob([...args, SKIP], 'production', publishRoute());

      expect(run.code).toBe(1);
      expect(run.error).toEqual({ message });
      expect(run.fetch.calls).toEqual([]);
    }
  });

  it('service/cli#publish-job: a publish call that the route refuses gives the same exit code, stderr, and calls with and without --skip-sdk-package, and no registry call', async () => {
    const fault = {
      errorCode: 'INTERNAL',
      errorName: 'Default:Internal',
      errorInstanceId: 'e-500',
      parameters: { ontologyRid: 'ri.ontology.main.ontology.acme' },
    };

    const invalid = {
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'InvalidOntology',
      errorInstanceId: 'e-400',
      parameters: {},
    };

    for (const [status, body] of [
      [500, fault],
      [400, invalid],
    ] as const) {
      const plain = await runJob(['publish', ...flags], 'production', refusingRoute(status, body));

      const skipped = await runJob(['publish', ...flags, SKIP], 'production', refusingRoute(status, body));

      expect(plain.code).toBe(1);
      expect(plain.lines).toEqual([body]);
      expect(serviceCalls(plain.fetch.calls)).toEqual([PUBLISH_CALL]);

      expect({ code: skipped.code, stderr: skipped.stderr, calls: serviceCalls(skipped.fetch.calls) }).toEqual({
        code: plain.code,
        stderr: plain.stderr,
        calls: serviceCalls(plain.fetch.calls),
      });

      expect([plain.packages.calls, skipped.packages.calls]).toEqual([[], []]);
    }
  });

  it('service/cli#publish-job: with and without --skip-sdk-package, a publish that passes sends the same publish body, prints the same warnings, and gives the same output but ontologySdk', async () => {
    const publish = (...extra: string[]) =>
      runJob(
        ['publish', ...flags, ...extra],
        'production',
        publishRoute({ ...STORED, transactionMs: 41, warnings: [WARNING] }),
      );

    const plain = await publish();

    const skipped = await publish(SKIP);

    const bodyOf = (run: typeof plain) => run.fetch.calls.filter(({ url }) => url === PUBLISH).map(({ body }) => body);

    expect([plain.code, skipped.code]).toEqual([0, 0]);
    expect(plain.lines).toEqual([{ warning: WARNING }]);
    expect(skipped.stderr).toBe(plain.stderr);
    expect(bodyOf(skipped)).toEqual(bodyOf(plain));
    expect(bodyOf(plain)).toHaveLength(1);
    expect(skipped.output).toEqual({ changes: [], metadata: STORED.metadata, version: 2, transactionMs: 41 });

    expect(plain.output).toEqual({
      changes: [],
      metadata: STORED.metadata,
      version: 2,
      transactionMs: 41,
      ontologySdk: TAGGED,
    });

    expect([plain.packages.calls, skipped.packages.calls]).toEqual([['find', 'tag', 'tag'], []]);
  });
});

describe('the branch head check of the publish job', () => {
  const COMMIT = 'a'.repeat(40);
  const API = 'https://api.github.test';

  const ACTIONS = {
    ...env,
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: COMMIT,
    GITHUB_REF_NAME: 'main',
    GITHUB_REPOSITORY: 'example/notes-ontology',
    GITHUB_API_URL: API,
    NODE_AUTH_TOKEN: 'ghs_job',
  };

  const HEAD = `${API}/repos/example/notes-ontology/git/ref/heads/main`;

  const github =
    (answer: Response): Handler =>
    ({ url }) =>
      url === HEAD ? answer : undefined;

  const runIn = async (
    args: readonly string[],
    variables: Readonly<Record<string, string | undefined>>,
    ...handlers: Handler[]
  ) => {
    const fetch = stubFetch(productionConfig, ...handlers, publishRoute(), stubConfig);
    const packages = registry();

    return { ...(await cli(args, { cwd: app(), fetch, env: variables, registry: packages })), fetch, packages };
  };

  it('service/cli#publish-job: in GitHub Actions, publish reads the head of its branch with the token of the job, and goes on when it is the commit of the job', async () => {
    const run = await runIn(['publish', ...flags], ACTIONS, github(Response.json({ object: { sha: COMMIT } })));

    expect(run.code).toBe(0);

    const [read] = run.fetch.calls.filter(({ url }) => url === HEAD);

    expect(read?.headers['authorization']).toBe('Bearer ghs_job');
    expect(serviceCalls(run.fetch.calls)).toEqual([PUBLISH_CALL]);
  });

  it('service/cli#publish-job: publish runs 3 steps in order, the check of the branch head, 1 publish call, and the Ontology SDK package, and calls no other route of the service', async () => {
    const events: string[] = [];

    const seen =
      (handler: Handler): Handler =>
      async (call) => {
        const response = await handler(call);

        if (response && call.url !== CLIENT_CONFIG) events.push(`${call.method} ${call.url}`);

        return response;
      };

    const fetch = stubFetch(
      productionConfig,
      seen(github(Response.json({ object: { sha: COMMIT } }))),
      seen(publishRoute()),
    );

    const packages = registry();
    const find = packages.find.bind(packages);
    const tag = packages.tag.bind(packages);

    Object.assign(packages, {
      find: (...args: Parameters<typeof find>) => (events.push('registry find'), find(...args)),
      tag: (...args: Parameters<typeof tag>) => (events.push('registry tag'), tag(...args)),
    });

    const run = await cli(['publish', ...flags], { cwd: app(), fetch, env: ACTIONS, registry: packages });

    expect(run.code).toBe(0);
    expect(events).toEqual([`GET ${HEAD}`, `POST ${PUBLISH}`, 'registry find', 'registry tag', 'registry tag']);

    expect(fetch.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${HEAD}`,
      `GET ${CLIENT_CONFIG}`,
      `POST ${PUBLISH}`,
    ]);
  });

  it('service/cli#publish-job: publish stops before any call to the service when a variable of the check is missing or GitHub gives no head', async () => {
    const cases = [
      {
        name: 'no NODE_AUTH_TOKEN',
        variables: { ...ACTIONS, NODE_AUTH_TOKEN: undefined },
        answer: Response.json({ object: { sha: COMMIT } }),
        message: 'The publish job needs NODE_AUTH_TOKEN to check that its commit is the head of its branch.',
      },
      {
        name: 'GitHub gives 404',
        variables: ACTIONS,
        answer: Response.json({ message: 'Not Found' }, { status: 404 }),
        message: 'GitHub gave 404 for the head of the branch main.',
      },
      {
        name: 'GitHub gives no commit',
        variables: ACTIONS,
        answer: Response.json({ ref: 'refs/heads/main' }),
        message: 'GitHub gave no commit for the head of the branch main.',
      },
    ];

    for (const { name, variables, answer, message } of cases) {
      const run = await runIn(['publish', ...flags], variables, github(answer));

      expect({
        name,
        code: run.code,
        message: (run.error as { message?: string }).message,
        calls: serviceCalls(run.fetch.calls),
        packages: run.packages.calls,
      }).toEqual({ name, code: 1, message, calls: [], packages: [] });
    }
  });

  const NOT_JSON = ((): string => {
    try {
      JSON.parse('not json');

      return '';
    } catch (error) {
      return (error as Error).message;
    }
  })();

  it('publish prints the error of a GitHub read that fails, and stops before any call to the service', async () => {
    const cases = [
      {
        name: 'GitHub is down',
        answer: () => Promise.reject(new TypeError('fetch failed', { cause: new Error('read ECONNRESET') })),
        error: { message: 'fetch failed', step: 'branch head check' },
      },
      {
        name: 'GitHub gives no JSON',
        answer: () => new Response('not json'),
        error: { message: NOT_JSON, step: 'branch head check' },
      },
      {
        name: 'GitHub gives 500 text',
        answer: () => new Response('down', { status: 500 }),
        error: {
          message: 'GitHub gave 500 for the head of the branch main.',
          github: { status: 500, message: 'down' },
        },
      },
    ];

    for (const { name, answer, error } of cases) {
      const run = await runIn(['publish', ...flags], ACTIONS, ({ url }) => (url === HEAD ? answer() : undefined));

      expect({
        name,
        code: run.code,
        stdout: run.stdout,
        stderr: run.stderr,
        calls: serviceCalls(run.fetch.calls),
      }).toEqual({ name, code: 1, stdout: '', stderr: `${JSON.stringify(error)}\n`, calls: [] });
    }
  });

  it('service/cli#publish-job, service/deployment#projects-and-environments: a publish whose commit is not the head exits 1 before the publish call, with and without --skip-sdk-package, and names both commits', async () => {
    const head = 'b'.repeat(40);

    for (const extra of [[], ['--skip-sdk-package']]) {
      const run = await runIn(
        ['publish', ...flags, ...extra],
        ACTIONS,
        github(Response.json({ object: { sha: head } })),
      );

      expect({
        extra,
        code: run.code,
        message: (run.error as { message?: string }).message,
        calls: serviceCalls(run.fetch.calls),
        packages: run.packages.calls,
      }).toEqual({
        extra,
        code: 1,
        message: `The commit ${COMMIT} is not the head of the branch main, which is ${head}. A re-run of an older commit publishes nothing.`,
        calls: [],
        packages: [],
      });
    }
  });

  it('service/cli#publish-job: validate, and publish outside GitHub Actions, read no branch head', async () => {
    for (const [args, variables] of [
      [['validate', ...flags], ACTIONS],
      [['publish', ...flags], { ...ACTIONS, GITHUB_ACTIONS: undefined }],
    ] as const) {
      const run = await runIn(args, variables, github(Response.json({ object: { sha: 'b'.repeat(40) } })));

      expect(run.code).toBe(0);
      expect(run.fetch.calls.filter(({ url }) => url === HEAD)).toEqual([]);
    }
  });
});

async function withStubBin(binaries: Readonly<Record<string, string>>, run: () => Promise<void>): Promise<void> {
  const bin = join(tempFolder(), 'bin');

  mkdirSync(bin, { recursive: true });

  for (const [name, script] of Object.entries(binaries)) {
    const file = join(bin, name);

    writeFileSync(file, `#!/bin/bash\n${script}\n`);

    chmodSync(file, 0o755);
  }

  const path = process.env['PATH'];

  process.env['PATH'] = `${bin}:${path}`;

  try {
    await run();
  } finally {
    process.env['PATH'] = path;
  }
}

describe('unexpected errors in publish', () => {
  const COMMIT = 'a'.repeat(40);
  const API = 'https://api.github.test';

  const ACTIONS = {
    ...env,
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: COMMIT,
    GITHUB_REF_NAME: 'main',
    GITHUB_REPOSITORY: 'example/notes-ontology',
    GITHUB_API_URL: API,
    NODE_AUTH_TOKEN: 'ghs_job',
  };

  const HEAD = `${API}/repos/example/notes-ontology/git/ref/heads/main`;

  const publishWithNpm = () =>
    cli(['publish', ...flags], {
      cwd: app(),
      fetch: stubFetch(productionConfig, publishRoute(), stubConfig),
      env,
      registry: npmRegistry,
    });

  it('service/cli#output: empty npm pack output in the Ontology SDK package step names the step, the command, and says that it printed nothing', async () => {
    await withStubBin(
      { npm: 'case "$1" in view) printf \'["0.0.1"]\\n\' ;; pack) exit 0 ;; *) exit 2 ;; esac' },
      async () => {
        const run = await publishWithNpm();

        const error = run.error as { message: string; step: string; command: string };

        expect(run.code).toBe(1);
        expect(run.stdout).toBe('');
        expect(error.step).toBe('Ontology SDK package');
        expect(error.command).toMatch(/^npm pack @ontos\/notes-ontology-sdk@0\.0\.1 --json --pack-destination /);
        expect(error.message).toBe(`${error.command} printed nothing. The CLI expected JSON.`);
      },
    );
  });

  it('service/cli#output: non-JSON output from npm view, npm pack, or tar names the step, the command, and quotes the start of stdout', async () => {
    await withStubBin({ npm: 'case "$1" in view) printf "not json\\n" ;; *) exit 2 ;; esac' }, async () => {
      const run = await publishWithNpm();

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message:
          'npm view @ontos/notes-ontology-sdk@>=0.0.0 version --json --registry https://npm.pkg.github.com did not print JSON: "not json"',
        step: 'Ontology SDK package',
        command: 'npm view @ontos/notes-ontology-sdk@>=0.0.0 version --json --registry https://npm.pkg.github.com',
      });
    });

    const longText = 'x'.repeat(300);

    await withStubBin({ npm: `case "$1" in view) printf '%s\\n' '${longText}' ;; *) exit 2 ;; esac` }, async () => {
      const run = await publishWithNpm();

      const error = run.error as { message: string; step: string; command: string };

      expect(run.code).toBe(1);
      expect(error.step).toBe('Ontology SDK package');

      expect(error.command).toBe(
        'npm view @ontos/notes-ontology-sdk@>=0.0.0 version --json --registry https://npm.pkg.github.com',
      );

      expect(error.message).toBe(
        `npm view @ontos/notes-ontology-sdk@>=0.0.0 version --json --registry https://npm.pkg.github.com did not print JSON: "${'x'.repeat(200)}..."`,
      );
    });

    await withStubBin(
      { npm: 'case "$1" in view) printf \'["0.0.1"]\\n\' ;; pack) printf "bad pack\\n" ;; esac' },
      async () => {
        const run = await publishWithNpm();

        const error = run.error as { message: string; step: string; command: string };

        expect(run.code).toBe(1);
        expect(error.step).toBe('Ontology SDK package');
        expect(error.command).toMatch(/^npm pack @ontos\/notes-ontology-sdk@0\.0\.1 --json --pack-destination /);
        expect(error.message).toContain('did not print JSON: "bad pack"');
      },
    );

    await withStubBin(
      {
        npm: 'case "$1" in view) printf \'["0.0.1"]\\n\' ;; pack) printf \'[{"filename":"sdk.tgz"}]\\n\' ;; esac',
        tar: 'exit 0',
      },
      async () => {
        const run = await publishWithNpm();

        const error = run.error as { message: string; step: string; command: string };

        expect(run.code).toBe(1);
        expect(error.step).toBe('Ontology SDK package');
        expect(error.command).toMatch(/^tar -xzOf .*\/sdk\.tgz package\/package\.json$/);
        expect(error.message).toContain('printed nothing. The CLI expected JSON.');
      },
    );
  });

  it('service/cli#output: an unexpected error in each step of publish names its step', async () => {
    const brokenApp = tempFolder({
      'foundry.yml': 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'ontology/src/ontology.mts': NOTES_ONTOLOGY,
      'ontology/src/grants.json': NOTES_GRANTS,
      '.ontology/schema-migrations.json': NO_MIGRATIONS,
      '.ontology/deployment.json': JSON.stringify(ACME),
      'node_modules/@osdk/maker/package.json': '{',
    });

    const buildFailed = await cli(['publish', ...flags], {
      cwd: brokenApp,
      fetch: stubFetch(productionConfig, publishRoute(), stubConfig),
      env,
      registry: registry(),
    });

    expect(buildFailed.code).toBe(1);
    expect(buildFailed.stdout).toBe('');
    expect(buildFailed.error).toMatchObject({ step: 'build Ontology', message: expect.any(String) as unknown });
    expect((buildFailed.error as Record<string, unknown>)['command']).toBeUndefined();

    const headFailed = await cli(['publish', ...flags], {
      cwd: app(),
      fetch: stubFetch(
        productionConfig,
        ({ url }) => (url === HEAD ? Promise.reject(new TypeError('fetch failed')) : undefined),
        publishRoute(),
        stubConfig,
      ),
      env: ACTIONS,
      registry: registry(),
    });

    expect(headFailed.code).toBe(1);
    expect(headFailed.stdout).toBe('');
    expect(headFailed.error).toEqual({ message: 'fetch failed', step: 'branch head check' });

    const publishNotJson = await cli(['publish', ...flags], {
      cwd: app(),
      fetch: stubFetch(
        productionConfig,
        ({ method, url }) => (method === 'POST' && url === PUBLISH ? new Response('not json') : undefined),
        stubConfig,
      ),
      env,
      registry: registry(),
    });

    expect(publishNotJson.code).toBe(1);
    expect(publishNotJson.stdout).toBe('');
    expect(publishNotJson.error).toMatchObject({ step: 'publish call', message: expect.any(String) as unknown });

    const publishRejected = await cli(['publish', ...flags], {
      cwd: app(),
      fetch: stubFetch(
        productionConfig,
        ({ method, url }) =>
          method === 'POST' && url === PUBLISH ? Promise.reject(new TypeError('fetch failed')) : undefined,
        stubConfig,
      ),
      env,
      registry: registry(),
    });

    expect(publishRejected.code).toBe(1);
    expect(publishRejected.error).toEqual({ message: 'fetch failed', step: 'publish call' });

    const crashingRegistry = {
      ...registry(),
      find(): never {
        throw new Error('unexpected registry boom');
      },
    };

    const sdkFailed = await cli(['publish', ...flags], {
      cwd: app(),
      fetch: stubFetch(productionConfig, publishRoute(), stubConfig),
      env,
      registry: crashingRegistry,
    });

    expect(sdkFailed.code).toBe(1);
    expect(sdkFailed.stdout).toBe('');
    expect(sdkFailed.error).toEqual({ message: 'unexpected registry boom', step: 'Ontology SDK package' });
  });
});
