import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  changedPaths,
  committedApp,
  GATE_DEPLOYMENT_FILE,
  linkedApp,
  NO_MIGRATIONS,
  NOTES_GRANTS,
  NOTES_ONTOLOGY,
  notesApp,
  OSDK_SET,
  PINNED_PACKAGE_JSON,
} from '../apps.test-utils.ts';
import { cli, once, ROOT, stubFetch, tempFolder, warm } from '../cli.test-utils.ts';
import { orThrow } from '../fallible.ts';
import { LOCAL_SDK_PACKAGE_JSON } from './generate.ts';
import { manifestFields } from './sdkPackage.ts';

const SDK = 'ontology/osdk-output/ontology';

const BOTH_ENVIRONMENTS = JSON.stringify({
  ...(JSON.parse(GATE_DEPLOYMENT_FILE) as object),
  staging: {
    baseUrl: 'https://twin-staging.ontos.example',
    workosClientId: 'client_twin_staging',
    trustedGithubRepository: 'example/twin-ontology',
    trustedGithubEnvironment: 'ontology-staging',
  },
  production: {
    baseUrl: 'https://twin.ontos.example',
    workosClientId: 'client_twin_production',
    signInMethods: ['google'],
    trustedGithubRepository: 'example/twin-ontology',
    trustedGithubEnvironment: 'ontology-production',
  },
});

async function generate(root: string) {
  const fetch = stubFetch();

  const run = await cli(['generate-osdk'], { cwd: root, fetch });

  expect(fetch.calls).toEqual([]);

  return run;
}

const generateLinked = once(async () => {
  const root = linkedApp();

  expect(existsSync(join(root, SDK))).toBe(false);

  return { root, run: await generate(root) };
});

const generateBothEnvironments = once(async () => {
  const root = linkedApp();

  writeFileSync(join(root, '.ontology/deployment.json'), BOTH_ENVIRONMENTS);

  return { root, run: await generate(root) };
});

const generateCommitted = once(async () => {
  const root = committedApp(linkedApp());

  return { root, run: await generate(root) };
});

const generateQueryFunction = once(async () => {
  const amountLeft = [
    'import type { Client } from "@osdk/client";',
    'type Decimal<T extends string = string> = T & { __decimalBrand?: void };',
    '/**',
    ' * The amount left on an account, as a Decimal.',
    ' * @param accountId - The account to read.',
    ' * @param tags - The tags.',
    ' * @param note - A note.',
    ' */',
    'export default async function amountLeft(client: Client, accountId: string, tags: string[], note?: string): Promise<Decimal | undefined> {',
    '  return undefined;',
    '}',
    '',
  ].join('\n');

  const root = linkedApp(undefined, { 'functions/typescript-functions/src/functions/amountLeft.ts': amountLeft });

  return { root, run: await generate(root) };
});

type NpmResult = { code: number; stdout: string; stderr: string };

let linkedLoaded: string;
let bothEnvironmentsLoaded: { serviceModule: string; closeAccountRid: string | undefined; loaded: string };

let freshClone: {
  lock: NpmResult;
  clone: string;
  trackedManifest: string;
  cloneEntries: string[];
  ci: NpmResult;
  run: Awaited<ReturnType<typeof generate>>;
  status: string;
  loaded: string;
};

let packedInstall: {
  run: Awaited<ReturnType<typeof generate>>;
  refused: NpmResult;
  installed: NpmResult;
  requests: string[];
};

let domainBuild: {
  root: string;
  run: Awaited<ReturnType<typeof generate>>;
  consumer: string;
  loaded: string;
};

async function runFreshClone() {
  const parent = tempFolder();

  symlinkSync(join(ROOT, 'node_modules'), join(parent, 'node_modules'), 'dir');

  const origin = join(parent, 'origin');

  const files: Record<string, string> = {
    '.gitignore': `node_modules/\n/${SDK}/*\n!/${SDK}/package.json\n`,
    'foundry.yml': `apiNamespace: com.example.notes\nosdkOutput: ontology/osdk-output\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n`,
    [`${SDK}/package.json`]: LOCAL_SDK_PACKAGE_JSON,
    'package.json': `${JSON.stringify({ private: true, dependencies: { '@ontology/sdk': `file:./${SDK}` } }, null, 2)}\n`,
    'ontology/src/ontology.mts': NOTES_ONTOLOGY,
    'ontology/src/grants.json': NOTES_GRANTS,
    '.ontology/schema-migrations.json': NO_MIGRATIONS,
    '.ontology/deployment.json': GATE_DEPLOYMENT_FILE,
  };

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(origin, path, '..'), { recursive: true });

    writeFileSync(join(origin, path), text);
  }

  const lock = await npm(
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
    ],
    origin,
  );

  git(origin, 'init', '-q');

  git(origin, 'add', '-A');

  git(origin, 'commit', '-qm', 'seed');

  const clone = join(parent, 'clone');

  git(parent, 'clone', '-q', origin, clone);

  const trackedManifest = readFileSync(join(clone, SDK, 'package.json'), 'utf8');
  const cloneEntries = readdirSync(join(clone, SDK));

  const ci = await npm(
    ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--no-update-notifier'],
    clone,
  );

  const run = await generate(clone);

  const status = git(clone, 'status', '--short');

  const loaded = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { Note } = await import('@ontology/sdk'); const { $actionTypesByRid } = await import('@ontology/sdk/ontology-service'); console.log(JSON.stringify([Note.apiName, Object.keys($actionTypesByRid).length]));",
    ],
    { cwd: clone, encoding: 'utf8' },
  );

  return { lock, clone, trackedManifest, cloneEntries, ci, run, status, loaded };
}

async function runPackedInstall(root: string, run: Awaited<ReturnType<typeof generate>>) {
  const published = tempFolder();

  cpSync(join(root, SDK), published, { recursive: true });

  writeFileSync(
    join(published, 'package.json'),
    `${JSON.stringify({ name: '@ontos/twin-ontology-sdk', version: '0.0.1', ...orThrow(manifestFields(OSDK_SET)) }, null, 2)}\n`,
  );

  const packs = tempFolder();

  const [packed] = JSON.parse(
    (await npm(['pack', published, '--pack-destination', packs, '--json'], packs)).stdout,
  ) as { filename: string }[];

  if (!packed) throw new Error('npm pack wrote no file.');

  const requests: string[] = [];

  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${decodeURIComponent(request.url ?? '')}`);

    if (decodeURIComponent(request.url ?? '') !== '/@osdk/client') return response.writeHead(404).end('{}');

    const versions = Object.fromEntries(
      ['2.91.0', '2.92.0'].map((version) => [
        version,
        { name: '@osdk/client', version, dist: { tarball: `http://127.0.0.1:1/client-${version}.tgz` } },
      ]),
    );

    return response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ name: '@osdk/client', 'dist-tags': { latest: '2.92.0' }, versions }));
  });

  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));

  try {
    const install = async (client: string) => {
      const consumer = tempFolder({
        'package.json': JSON.stringify({
          name: 'consumer',
          version: '1.0.0',
          dependencies: { '@osdk/client': client, '@ontology/sdk': `file:${join(packs, packed.filename)}` },
        }),
        '.npmrc': '',
        'global.npmrc': '',
      });

      const registry = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;

      return npm(
        [
          'install',
          '--package-lock-only',
          '--json',
          '--no-audit',
          '--no-fund',
          '--no-update-notifier',
          '--registry',
          registry,
          '--cache',
          join(consumer, '.cache'),
          '--userconfig',
          join(consumer, '.npmrc'),
          '--globalconfig',
          join(consumer, 'global.npmrc'),
        ],
        consumer,
      );
    };

    const refused = await install('2.79.0');

    const installed = await install('2.92.0');

    return { run, refused, installed, requests };
  } finally {
    server.close();
  }
}

async function runDomainBuild() {
  const moneyTs = [
    'declare const centsBrand: unique symbol;',
    'export type Cents = number & { readonly [centsBrand]: true };',
    'export function cents(value: number): Cents {',
    '  return value as Cents;',
    '}',
    'export function addCents(a: Cents, b: Cents): Cents {',
    '  return (a + b) as Cents;',
    '}',
    '',
  ].join('\n');

  const root = notesApp({
    'foundry.yml':
      'apiNamespace: com.example.notes\nosdkOutput: ontology/osdk-output\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    'domain/index.ts': "export * from './money.ts';\n",
    'domain/money.ts': moneyTs,
    'domain/money.test.ts':
      "import { expect, it } from 'vitest';\nimport { addCents, cents } from './money.ts';\nit('adds', () => expect(addCents(cents(1), cents(2))).toBe(3));\n",
  });

  const run = await generate(root);

  const consumer = tempFolder();

  mkdirSync(join(consumer, 'node_modules', '@ontology'), { recursive: true });

  symlinkSync(join(root, SDK), join(consumer, 'node_modules', '@ontology', 'sdk'));

  const loaded = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { addCents, cents } = await import('@ontology/sdk/domain'); console.log(JSON.stringify(addCents(cents(120), cents(30))));",
    ],
    { cwd: consumer, encoding: 'utf8' },
  );

  return { root, run, consumer, loaded };
}

beforeAll(async () => {
  await warm(generateLinked, generateBothEnvironments, generateCommitted, generateQueryFunction);

  const [linked, both, cloneResult, domainResult] = await Promise.all([
    generateLinked(),
    generateBothEnvironments(),
    runFreshClone(),
    runDomainBuild(),
  ]);

  const linkedConsumer = tempFolder();

  mkdirSync(join(linkedConsumer, 'node_modules', '@ontology'), { recursive: true });

  symlinkSync(join(linked.root, SDK), join(linkedConsumer, 'node_modules', '@ontology', 'sdk'));

  linkedLoaded = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const sdk = await import('@ontology/sdk'); console.log(JSON.stringify([sdk.Account.apiName, sdk.Account.type, sdk.closeAccountAction.type]));",
    ],
    { cwd: linkedConsumer, encoding: 'utf8' },
  );

  const serviceModule = readFileSync(join(both.root, SDK, 'ontology-service.ts'), 'utf8');

  const closeAccountRid =
    /"(ri\.actions\.main\.action-type\.[0-9a-f-]+)": \{ action: closeAccountAction, displayName: "Close account" \}/.exec(
      serviceModule,
    )?.[1];

  const bothConsumer = tempFolder();

  mkdirSync(join(bothConsumer, 'node_modules', '@ontology'), { recursive: true });

  symlinkSync(join(both.root, SDK), join(bothConsumer, 'node_modules', '@ontology', 'sdk'));

  const script = `const { $actionTypesByRid, $environments } = await import('@ontology/sdk/ontology-service'); const { closeAccountAction } = await import('@ontology/sdk'); const entry = $actionTypesByRid['${closeAccountRid ?? ''}']; console.log(JSON.stringify([entry.action === closeAccountAction, entry.action.apiName, entry.displayName, $environments]));`;

  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: bothConsumer,
    encoding: 'utf8',
  });

  bothEnvironmentsLoaded = { serviceModule, closeAccountRid, loaded };

  freshClone = cloneResult;

  domainBuild = domainResult;

  packedInstall = await runPackedInstall(linked.root, linked.run);
}, 180_000);

const paramsDefinition = (root: string, action: string): string | undefined =>
  /export type ParamsDefinition = ([^;]*);/.exec(
    readFileSync(join(root, SDK, `ontology/actions/${action}.ts`), 'utf8'),
  )?.[1];

describe('ontos generate-osdk', () => {
  it('service/deployment#deployment-files ontology/ontology-sdk/ontology-sdk#contract: generate-osdk makes the Ontology SDK with no network and no token, with the product RID of the deployment file', async () => {
    const { root, run } = await generateLinked();

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    expect(readFileSync(join(root, SDK, 'OntologyMetadata.ts'), 'utf8')).toContain(
      `export const $ontologyRid = 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111';`,
    );
  });

  it('service/cli#inputs: generate-osdk does not read the grants file, so an app with no grants file makes its Ontology SDK', async () => {
    const root = notesApp({
      'foundry.yml':
        'apiNamespace: com.example.notes\nosdkOutput: generated/sdk\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    });

    rmSync(join(root, 'ontology/src/grants.json'));

    const run = await generate(root);

    expect([run.code, run.stderr]).toEqual([0, '']);
    expect(existsSync(join(root, 'generated/sdk/ontology/package.json'))).toBe(true);
  });

  it('generate-osdk works without a deployment file, defaulting to the local dev product RID and accepting --product-rid', async () => {
    const root = notesApp({
      'ontos.yml':
        'apiNamespace: com.example.notes\nosdkOutput: generated/sdk\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    });

    rmSync(join(root, 'foundry.yml'));

    rmSync(join(root, '.ontology/deployment.json'));

    const defaultRun = await generate(root);

    expect([defaultRun.code, defaultRun.stderr]).toEqual([0, '']);
    expect(existsSync(join(root, 'generated/sdk/ontology/package.json'))).toBe(true);

    expect(readFileSync(join(root, 'generated/sdk/ontology/OntologyMetadata.ts'), 'utf8')).toContain(
      'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000001',
    );

    const customRid = 'ri.ontology.main.ontology.22222222-2222-4222-8222-222222222222';

    const customRun = await cli(['generate-osdk', '--product-rid', customRid], { cwd: root, fetch: stubFetch() });

    expect([customRun.code, customRun.stderr]).toEqual([0, '']);
    expect(readFileSync(join(root, 'generated/sdk/ontology/OntologyMetadata.ts'), 'utf8')).toContain(customRid);

    const badRid = await cli(['generate-osdk', '--product-rid', 'not-a-rid'], { cwd: root, fetch: stubFetch() });

    expect(badRid.code).toBe(1);
    expect(badRid.error).toEqual({ message: '--product-rid must have the form ri.ontology.main.ontology.<UUID>.' });
  });

  it('service/cli#targets: generate-osdk acts on no app and no environment, so it refuses each target flag', async () => {
    for (const flag of [
      ['--app', 'twin'],
      ['--env', 'production'],
      ['--url', 'http://localhost:1'],
    ]) {
      const run = await cli(['generate-osdk', ...flag], { cwd: linkedApp(), fetch: stubFetch() });

      expect(run.code).toBe(1);
      expect(run.error).toEqual({ message: `ontos generate-osdk does not take ${flag[0] ?? ''}.` });
    }
  });

  it('ontology/ontology-sdk/ontology-sdk#contract, service/cli#commands, ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: generate-osdk writes the Ontology SDK to <osdkOutput>/ontology/, with the package name ontology', async () => {
    const { root, run } = await generateLinked();

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.output).toEqual({ osdkOutput: SDK, passes: 2 });

    expect(JSON.parse(readFileSync(join(root, SDK, 'package.json'), 'utf8'))).toEqual(
      JSON.parse(LOCAL_SDK_PACKAGE_JSON),
    );

    expect([...bareImports(join(root, SDK))].sort()).toEqual(['@osdk/client']);
    expect(JSON.parse(linkedLoaded)).toEqual(['com.example.twin.Account', 'object', 'action']);

    const ours = [
      'objects/Account',
      'objects/Engagement',
      'actions/closeAccountAction',
      'actions/createAccount',
      'actions/createEngagement',
      'actions/deleteAccount',
      'actions/deleteEngagement',
      'actions/setEngagementStatus',
    ];

    for (const name of ours) expect(existsSync(join(root, SDK, `ontology/${name}.ts`))).toBe(true);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: generate-osdk adds the ontology-service module, whose $actionTypesByRid gives the Action constant and the display name of each Action Type RID, and whose $environments gives the base URL and the WorkOS client ID of each environment of the deployment file', async () => {
    const { root, run } = await generateBothEnvironments();

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const { serviceModule, closeAccountRid, loaded } = bothEnvironmentsLoaded;

    expect(closeAccountRid).toBeDefined();
    expect(serviceModule).toContain('export const $actionTypesByRid = {');
    expect(serviceModule).toContain('displayName: "Create Account"');
    expect(serviceModule).toContain('displayName: "Set relationship"');

    expect(serviceModule).toContain(`export const $environments = {
  staging: { baseUrl: "https://twin-staging.ontos.example", workosClientId: "client_twin_staging" },
  production: { baseUrl: "https://twin.ontos.example", workosClientId: "client_twin_production" },
} as const;`);

    expect(readFileSync(join(root, SDK, 'index.ts'), 'utf8')).not.toContain('ontology-service');

    expect(JSON.parse(loaded)).toEqual([
      true,
      'com.example.twin.closeAccountAction',
      'Close account',
      {
        staging: { baseUrl: 'https://twin-staging.ontos.example', workosClientId: 'client_twin_staging' },
        production: { baseUrl: 'https://twin.ontos.example', workosClientId: 'client_twin_production' },
      },
    ]);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: generate-osdk changes no file of the app outside <osdkOutput>/ontology/ in either pass, so the package.json keeps its exact pins', async () => {
    const { root, run } = await generateCommitted();

    expect(run.stderr).toBe('');
    expect(run.output).toEqual({ osdkOutput: SDK, passes: 2 });
    expect(changedPaths(root).filter((path) => !path.startsWith(`${SDK}/`))).toEqual([]);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(PINNED_PACKAGE_JSON);
  });

  it('service/cli#inputs: generate-osdk reads osdkOutput of foundry.yml', async () => {
    const root = notesApp({
      'foundry.yml':
        'apiNamespace: com.example.notes\nosdkOutput: generated/sdk\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    });

    const run = await generate(root);

    expect(run.stderr).toBe('');
    expect(run.output).toEqual({ osdkOutput: 'generated/sdk/ontology', passes: 1 });
    expect(existsSync(join(root, 'generated/sdk/ontology/index.ts'))).toBe(true);
    expect(existsSync(join(root, 'ontology/osdk-output'))).toBe(false);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: the app writes its Ontology SDK with osdk unstable typescript generate, from the Ontology metadata only', async () => {
    const root = notesApp({
      'foundry.yml':
        'apiNamespace: com.example.notes\nosdkOutput: ontology/osdk-output\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    });

    const run = await generate(root);

    expect(run.stderr).toBe('');

    const index = readFileSync(join(root, SDK, 'index.ts'), 'utf8');

    expect(index).toContain(`export { Note } from './ontology/objects.js';`);

    const note = readFileSync(join(root, SDK, 'ontology/objects/Note.ts'), 'utf8');

    expect(note).toContain(`apiName: 'com.example.notes.Note'`);
    expect(note).toMatch(/rid: 'ri\.ontology\.main\.object-type\.[0-9a-f-]{36}'/);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: the first pass has no Function parameters, and the second pass bundles the Functions against the Ontology SDK of the first pass', async () => {
    const { root, run } = await generateLinked();

    expect(run.stderr).toBe('');
    expect(run.output).toEqual({ osdkOutput: SDK, passes: 2 });
    expect(paramsDefinition(root, 'closeAccountAction')).not.toBe('Record<string, never>');
    expect(paramsDefinition(root, 'closeAccountAction')).toContain('account: {');
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: the Ontology SDK of the first pass gives each function-backed Action Type no parameters', async () => {
    const root = linkedApp(['closeAccount']);

    const run = await generate(root);

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message:
        'Action Type com.example.twin.probe-version-check-action has a Function rule for the Function probeVersionCheck, which the version does not have. A function-backed Action needs its Function.',
    });

    expect(paramsDefinition(root, 'closeAccountAction')).toBe('Record<string, never>');
    expect(paramsDefinition(root, 'createAccount')).not.toBe('Record<string, never>');
  });

  it('ontology/object-link-types/derived-properties#ontology-metadata: generate-osdk types a derived Property as a plain Property of its declared type', async () => {
    const objectTypes = ['Account', 'Category', 'Transaction', 'Engagement', 'Invoice', 'Role', 'RoleAssignment'].map(
      (name) => `com.example.twin.${name}`,
    );

    const grants = {
      permissions: { 'twin:use': { description: 'Use the twin' } },
      objectTypes: Object.fromEntries(objectTypes.map((name) => [name, 'twin:use'])),
      actionTypes: {},
      defaultRoles: { admin: ['ontology:install', 'twin:use'], member: ['twin:use'] },
    };

    const root = notesApp({
      'foundry.yml':
        'apiNamespace: com.example.twin.\nosdkOutput: ontology/osdk-output\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'ontology/src/ontology.mts': readFileSync(
        join(ROOT, 'packages/service/twin/ontology/derived/ontology.ts'),
        'utf8',
      ),
      'ontology/src/grants.json': `${JSON.stringify(grants)}\n`,
    });

    const run = await generate(root);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const propertyDef = (objectType: string, property: string) =>
      new RegExp(`${property}: \\$PropertyDef<([^>]*)>`).exec(
        readFileSync(join(root, SDK, `ontology/objects/${objectType}.ts`), 'utf8'),
      )?.[1];

    expect(propertyDef('Account', 'balance')).toBe("'decimal', 'nullable', 'single'");
    expect(propertyDef('Transaction', 'amount')).toBe("'decimal', 'nullable', 'single'");
    expect(propertyDef('Role', 'assignmentCount')).toBe("'integer', 'nullable', 'single'");
    expect(propertyDef('Invoice', 'invoiceAccount')).toBe("'string', 'nullable', 'single'");
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: generate-osdk writes each Query Function with the stock generator, and tsc passes on a call with an optional input, a list input that the call omits or sets, and a Decimal output', async () => {
    const { root, run } = await generateQueryFunction();

    expect([run.code, run.stderr]).toEqual([0, '']);
    expect(readFileSync(join(root, SDK, 'index.ts'), 'utf8')).toContain('amountLeft');
    expect(existsSync(join(root, SDK, 'ontology/queries/closeAccount.ts'))).toBe(false);

    const call = [
      "import type { Client } from '@osdk/client';",
      "import { amountLeft } from './ontology/osdk-output/ontology/index.js';",
      'declare const client: Client;',
      "const withNote: string | undefined = await client(amountLeft).executeFunction({ accountId: 'acc-1', note: 'A note.' });",
      "const withoutNote: string | undefined = await client(amountLeft).executeFunction({ accountId: 'acc-1' });",
      "const withTags: string | undefined = await client(amountLeft).executeFunction({ accountId: 'acc-1', tags: ['a'] });",
      '// @ts-expect-error a list input takes no null',
      "await client(amountLeft).executeFunction({ accountId: 'acc-1', tags: null });",
      '// @ts-expect-error accountId is a required input',
      'await client(amountLeft).executeFunction({});',
      '// @ts-expect-error a Decimal output is a string, not a number',
      "const asNumber: number = await client(amountLeft).executeFunction({ accountId: 'acc-1' });",
      'export { asNumber, withNote, withoutNote, withTags };',
    ].join('\n');

    writeFileSync(join(root, 'call.mts'), call);

    const program = ts.createProgram([join(root, 'call.mts')], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });

    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: on a fresh clone of a seeded Ontology deployment repository, npm ci --ignore-scripts followed by generate-osdk succeeds, keeps the tracked package.json byte-for-byte unchanged, and leaves git status --short empty', () => {
    const { lock, clone, trackedManifest, cloneEntries, ci, run, status, loaded } = freshClone;

    expect(lock.code, lock.stderr).toBe(0);
    expect(cloneEntries).toEqual(['package.json']);
    expect(ci.code, ci.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(readFileSync(join(clone, SDK, 'package.json'), 'utf8')).toBe(trackedManifest);
    expect(status).toBe('');
    expect(JSON.parse(loaded)).toEqual(['com.example.notes.Note', 1]);
  });

  it('ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: npm refuses to install the packed Ontology SDK next to another @osdk/client version, with ERESOLVE', () => {
    const { run, refused, installed, requests } = packedInstall;

    expect(run.code).toBe(0);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout, refused.stderr).toContain('"error"');
    expect((JSON.parse(refused.stdout) as { error: { code: string } }).error.code).toBe('ERESOLVE');
    expect(installed.code, installed.stderr).toBe(0);
    expect(new Set(requests)).toEqual(new Set(['GET /@osdk/client']));
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: when domain/index.ts exists, generate-osdk compiles domain/ to dist/domain/ with types, exposes ./domain, excludes test files, and lets a consumer import it with strict types', () => {
    const { root, run, consumer, loaded } = domainBuild;

    expect([run.code, run.stderr]).toEqual([0, '']);

    const manifest = JSON.parse(readFileSync(join(root, SDK, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(manifest.exports['./domain']).toEqual({
      types: './dist/domain/index.d.ts',
      import: './dist/domain/index.js',
    });

    expect(existsSync(join(root, SDK, 'dist/domain/index.js'))).toBe(true);
    expect(existsSync(join(root, SDK, 'dist/domain/index.d.ts'))).toBe(true);
    expect(existsSync(join(root, SDK, 'dist/domain/money.js'))).toBe(true);
    expect(existsSync(join(root, SDK, 'dist/domain/money.d.ts'))).toBe(true);
    expect(existsSync(join(root, SDK, 'domain/money.test.ts'))).toBe(false);
    expect(existsSync(join(root, SDK, 'dist/domain/money.test.js'))).toBe(false);
    expect([...bareImports(join(root, SDK))].sort()).toEqual(['@osdk/client']);
    expect(JSON.parse(loaded)).toBe(150);

    writeFileSync(
      join(consumer, 'use.mts'),
      [
        "import { addCents, cents, type Cents } from '@ontology/sdk/domain';",
        'const total: Cents = addCents(cents(10), cents(20));',
        '// @ts-expect-error plain number is not Cents',
        'const bad: Cents = 5;',
        'export { bad, total };',
      ].join('\n'),
    );

    const program = ts.createProgram([join(consumer, 'use.mts')], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });

    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: generate-osdk refuses a non-relative runtime import in domain/ with a CliError naming the file and specifier', async () => {
    const root = notesApp({
      'foundry.yml':
        'apiNamespace: com.example.notes\nosdkOutput: ontology/osdk-output\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'domain/index.ts':
        "import { chunk } from 'lodash';\nexport const groups = (items: string[]) => chunk(items, 2);\n",
    });

    const run = await generate(root);

    expect(run.code).toBe(1);
    expect((run.error as { message: string }).message).toContain('domain/index.ts');
    expect((run.error as { message: string }).message).toContain('"lodash"');
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: generate-osdk fails when domain/ has a TypeScript compile error', async () => {
    const root = notesApp({
      'foundry.yml':
        'apiNamespace: com.example.notes\nosdkOutput: ontology/osdk-output\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'domain/index.ts': "export const bad: number = 'not-a-number';\n",
    });

    const run = await generate(root);

    expect(run.code).toBe(1);
    expect((run.error as { message: string }).message).toContain('domain/index.ts');
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

function npm(args: readonly string[], cwd: string): Promise<NpmResult> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_config_')),
  );

  return new Promise((resolve) => {
    execFile('npm', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

function bareImports(folder: string): Set<string> {
  const names = new Set<string>();

  for (const path of readdirSync(folder, { recursive: true, encoding: 'utf8' })) {
    if (path.includes('node_modules') || !/\.(ts|js)$/.test(path)) continue;

    for (const [, , name = ''] of readFileSync(join(folder, path), 'utf8').matchAll(
      /(from|import\()\s*['"]([^./'"][^'"]*)['"]/g,
    ))
      names.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : (name.split('/')[0] ?? name));
  }

  return names;
}
