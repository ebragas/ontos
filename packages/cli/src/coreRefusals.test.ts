import {
  chmodSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTES_ONTOLOGY, notesApp, twinFunctionsApp } from './apps.test-utils.ts';
import { ACME } from './deployment.fixture.ts';
import {
  appFolder,
  cli,
  stubExchange,
  stubMetadata,
  replay,
  ROOT,
  STUB,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  stubRegistry,
  tempFolder,
  withRequest,
  type CliOptions,
  type Exchange,
  type Handler,
} from './cli.test-utils.ts';
import { configTokenStore, fileTokenStore } from './auth/store.ts';
import { CliError } from './cliError.ts';
import { orThrow, type AsyncFallible } from './fallible.ts';
import { run as runLibrary } from './index.ts';
import { npmRegistry } from './sdk/sdkPackage.ts';

const STAGING_API_KEY = 'sk_test_staging_key';

const ACCOUNT = 'com.example.twin.Account';
const ENGAGEMENT = 'com.example.twin.Engagement';
const TARGET = ['--app', 'twin', '--url', STUB];
const ENV = { ONTOLOGY_TOKEN: 't' };
const WORKOS = 'https://api.workos.com/user_management';
const PUBLISH = `${STUB}/api/ontology-service/v1/publish`;

interface Options extends Omit<CliOptions, 'sleeps'> {
  readonly sleeps?: true;
}

async function go(args: readonly string[], { sleeps, ...options }: Options = {}): Promise<unknown> {
  const cwd = options.cwd ?? tempFolder();
  const waits: number[] = [];

  const result = await cli(args, { ...options, cwd, sleeps: waits });

  const plain = (text: string): string =>
    text
      .replaceAll(cwd, '<cwd>')
      .replaceAll(ROOT.replace(/\/$/, ''), '<root>')
      .replace(/(?:\.\.\/)*\.\.<cwd>/g, '<cwd>');

  return {
    code: result.code,
    stdout: plain(result.stdout),
    stderr: plain(result.stderr),
    ...(sleeps ? { waits } : {}),
  };
}

const withService = (...handlers: Handler[]) => stubFetch(...handlers, stubConfig);

const object = (args: readonly string[], ...handlers: Handler[]) =>
  go([...args, ...TARGET], { fetch: withService(...handlers), env: ENV });

const fullMetadata =
  (metadata: unknown): Handler =>
  ({ method, url }) =>
    method === 'GET' && new URL(url).pathname === `/api/v2/ontologies/${STUB_CONFIG.productRid}/fullMetadata`
      ? Response.json(metadata)
      : undefined;

const fetchOneOfNoSuch = (status: number, responseBody: unknown) => {
  const exchange = stubExchange('client', 6) as Exchange & { requestBody: { objectSet: { where: object } } };
  const where = { ...exchange.requestBody.objectSet.where, value: 'no-such' };

  return replay({
    ...exchange,
    requestBody: { ...exchange.requestBody, objectSet: { ...exchange.requestBody.objectSet, where } },
    status,
    responseBody,
  });
};

const applyRoute =
  (reply: () => Response): Handler =>
  ({ method, url }) =>
    method === 'POST' && url.includes('/actions/') ? reply() : undefined;

const answers =
  (route: string, ...replies: (() => Response)[]): Handler =>
  ({ url }) =>
    url === route ? replies.shift()?.() : undefined;

interface Case {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

const COMMANDS: readonly Case[] = [
  { name: 'login: an empty --org', run: () => go(['login', '--org=', ...TARGET], { env: ENV }) },
  { name: 'a flag that the command does not take', run: () => go(['logout', '--where', 'x', ...TARGET], { env: ENV }) },
  {
    name: 'install: --test-user',
    run: () => go(['install', 'p', '--api-name', 'a', '--display-name', 'b', '--test-user', ...TARGET], { env: ENV }),
  },
  { name: 'too many arguments', run: () => go(['logout', 'extra', ...TARGET], { env: ENV }) },
  { name: 'too few arguments', run: () => go(['objects', ...TARGET], { env: ENV }) },
  { name: '--test-user with a token variable', run: () => go(['logout', '--test-user', ...TARGET], { env: ENV }) },
  { name: 'objects: --where is not JSON', run: () => object(['objects', ACCOUNT, '--where', '{bad']) },
  { name: 'objects: --page-size 0', run: () => object(['objects', ACCOUNT, '--page-size', '0']) },
  { name: 'objects: --page-size is not a number', run: () => object(['objects', ACCOUNT, '--page-size', 'ten']) },
  { name: 'objects: --page-size above the largest', run: () => object(['objects', ACCOUNT, '--page-size', '10001']) },
  { name: 'objects: --link with no primary key', run: () => object(['objects', ACCOUNT, '--link', 'engagements']) },
  { name: 'objects: a primary key with --where', run: () => object(['objects', ACCOUNT, 'acc-1', '--where', '{}']) },
  {
    name: 'objects: a primary key with --page-token',
    run: () => object(['objects', ACCOUNT, 'acc-1', '--page-token', 'x']),
  },
  {
    name: 'objects: an Object that does not exist',
    run: () =>
      object(['objects', ACCOUNT, 'no-such'], replay(stubExchange('client', 1)), fetchOneOfNoSuch(200, { data: [] })),
  },
  {
    name: 'objects: another error of 1 Object',
    run: () =>
      object(
        ['objects', ACCOUNT, 'no-such'],
        replay(stubExchange('client', 1)),
        fetchOneOfNoSuch(404, {
          errorCode: 'NOT_FOUND',
          errorName: 'ObjectTypeNotFound',
          errorInstanceId: 'e-1',
          parameters: { objectType: ACCOUNT },
        }),
      ),
  },
  {
    name: 'objects: an error of the service',
    run: () =>
      object(
        ['objects', ENGAGEMENT, '--where', '{"nope":{"$eq":"x"}}'],
        replay(stubExchange('client', 4), withRequest(stubExchange('client', 22), { pageSize: 100 })),
      ),
  },
  { name: 'aggregate: no --select', run: () => object(['aggregate', ACCOUNT]) },
  { name: 'aggregate: --select is not JSON', run: () => object(['aggregate', ACCOUNT, '--select', '{bad']) },
  { name: 'aggregate: --select is an array', run: () => object(['aggregate', ACCOUNT, '--select', '[]']) },
  { name: 'aggregate: --select is null', run: () => object(['aggregate', ACCOUNT, '--select', 'null']) },
  {
    name: 'aggregate: a key with no metric',
    run: () => object(['aggregate', ACCOUNT, '--select', '{"amount":"unordered"}']),
  },
  {
    name: 'aggregate: a key with a colon and no metric',
    run: () => object(['aggregate', ACCOUNT, '--select', '{"amount:":"unordered"}']),
  },
  {
    name: 'aggregate: --group-by is not JSON',
    run: () => object(['aggregate', ACCOUNT, '--select', '{"$count":"unordered"}', '--group-by', '{bad']),
  },
  {
    name: 'apply: --parameters is not JSON',
    run: () => object(['apply', 'com.example.twin.create-engagement', '--parameters', '{bad']),
  },
  {
    name: 'apply: the service refuses the Action',
    run: () => {
      const asked = withRequest(stubExchange('client', 21), {
        options: { mode: 'VALIDATE_AND_EXECUTE', returnEdits: 'ALL_V2_WITH_DELETIONS' },
      });

      return object(
        ['apply', 'com.example.twin.create-engagement', '--parameters', '{"engagementId":"eng-1","title":"Duplicate"}'],
        replay(stubExchange('client', 14), asked),
      );
    },
  },
  {
    name: 'describe: a name that no type has',
    run: () => object(['describe', 'Nope'], fullMetadata(stubMetadata())),
  },
  {
    name: 'a token with no Organization',
    run: () =>
      object(['objects', ACCOUNT], ({ url }) =>
        url === `${STUB}/api/v2/ontologies`
          ? Response.json(
              {
                errorCode: 'PERMISSION_DENIED',
                errorName: 'OntologyService:NoOrganization',
                errorInstanceId: 'e-2',
                parameters: {},
              },
              { status: 403 },
            )
          : undefined,
      ),
  },
];

const TARGETS: readonly Case[] = [
  { name: 'no app', run: () => go(['logout'], { env: ENV }) },
  {
    name: 'an app name that is not 1 DNS label',
    run: () => go(['logout', '--app', 'Bad_App', '--url', STUB], { env: ENV }),
  },
  {
    name: 'an environment that is not staging or production',
    run: () => go(['logout', '--app', 'twin', '--env', 'prod'], { env: ENV }),
  },
  { name: 'an app name too long for staging', run: () => go(['logout', '--app', 'a'.repeat(60)], { env: ENV }) },
  {
    name: '--test-user in the production environment of an app',
    run: () => go(['logout', '--app', 'twin', '--env', 'production', '--test-user'], { env: {} }),
  },
  {
    name: 'client-config: an environment with no deployment',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        env: ENV,
        fetch: stubFetch(({ url }) =>
          url.endsWith('/client-config')
            ? Response.json({ error: { code: 'DEPLOYMENT_NOT_FOUND' } }, { status: 404 })
            : undefined,
        ),
      }),
  },
  {
    name: 'client-config: an answer that is not 200',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        env: ENV,
        fetch: stubFetch(({ url }) =>
          url.endsWith('/client-config') ? new Response('nope', { status: 500 }) : undefined,
        ),
      }),
  },
  {
    name: 'client-config: a network error, with the waits',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        env: ENV,
        sleeps: true,
        fetch: stubFetch(
          answers(
            `${STUB}/api/ontology-service/v1/client-config`,
            ...Array.from({ length: 7 }, () => () => new Response('', { status: 503 })),
          ),
        ),
      }),
  },
  {
    name: 'client-config: 429 is not tried again',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        env: ENV,
        sleeps: true,
        fetch: stubFetch(
          answers(`${STUB}/api/ontology-service/v1/client-config`, () =>
            Response.json({ message: 'slow down' }, { status: 429 }),
          ),
        ),
      }),
  },
  {
    name: 'a write that gets 503 is not tried again',
    run: () =>
      object(
        ['apply', 'com.example.twin.create-engagement', '--parameters', '{}'],
        replay(stubExchange('client', 14)),
        applyRoute(() => Response.json({ message: 'down' }, { status: 503 })),
      ),
  },
  {
    name: 'a write that gets 429 is not tried again',
    run: () =>
      object(
        ['apply', 'com.example.twin.create-engagement', '--parameters', '{}'],
        replay(stubExchange('client', 14)),
        applyRoute(() => Response.json({ message: 'slow' }, { status: 429 })),
      ),
  },
  {
    name: 'a stored token that does not exist',
    run: () => go(['objects', ACCOUNT, ...TARGET], { fetch: withService() }),
  },
];

const ontologies =
  (...apiNames: string[]): Handler =>
  ({ method, url }) =>
    method === 'GET' && url === `${STUB}/api/v2/ontologies`
      ? Response.json({
          data: apiNames.map((apiName) => ({
            rid: `ri.ontology.main.ontology.${apiName}`,
            apiName,
            displayName: apiName,
            description: '',
          })),
        })
      : undefined;

const ONTOLOGIES: readonly Case[] = [
  {
    name: 'an Organization with no Ontology',
    run: () =>
      go(['describe', ...TARGET], {
        env: ENV,
        fetch: stubFetch(
          ({ url }) => (url.endsWith('/client-config') ? Response.json(STUB_CONFIG) : undefined),
          ontologies(),
        ),
      }),
  },
  {
    name: 'an Ontology that the Organization does not have',
    run: () => go(['describe', '--ontology', 'nope', ...TARGET], { env: ENV, fetch: withService() }),
  },
  {
    name: 'more than 1 Ontology and no --ontology',
    run: () =>
      go(['describe', ...TARGET], {
        env: ENV,
        fetch: stubFetch(
          ({ url }) => (url.endsWith('/client-config') ? Response.json(STUB_CONFIG) : undefined),
          ontologies('alpha', 'beta'),
        ),
      }),
  },
  {
    name: 'install: no --api-name',
    run: () => go(['install', 'product', '--display-name', 'x', ...TARGET], { env: ENV, fetch: withService() }),
  },
  {
    name: 'install: the service refuses',
    run: () =>
      go(['install', 'product', '--api-name', 'a', '--display-name', 'b', ...TARGET], {
        env: ENV,
        fetch: withService(({ method, url }) =>
          method === 'POST' && url === `${STUB}/api/ontology-service/v1/ontologies`
            ? Response.json({ errorName: 'OntologyService:Forbidden', message: 'no' }, { status: 403 })
            : undefined,
        ),
      }),
  },
];

function notesFolder(files: Readonly<Record<string, string>> = {}, removed?: string): string {
  const root = notesApp(files);

  if (removed) rmSync(join(root, removed));

  return root;
}

const validate = (cwd: string, ...handlers: Handler[]) =>
  go(['validate', '--app', 'notes', '--url', STUB], { cwd, env: ENV, fetch: withService(...handlers) });

const APP: readonly Case[] = [
  { name: 'no foundry.yml', run: () => go(['validate', '--app', 'notes', '--url', STUB], { env: ENV }) },
  { name: 'a foundry.yml with products', run: () => validate(appFolder({ 'foundry.yml': 'products:\n  - x\n' })) },
  {
    name: 'a foundry.yml with PYTHON_FUNCTIONS',
    run: () =>
      validate(
        appFolder({ 'foundry.yml': 'apiNamespace: a.b\ncomponents:\n  - type: PYTHON_FUNCTIONS\n    path: ./p\n' }),
      ),
  },
  { name: 'a foundry.yml with no apiNamespace', run: () => validate(appFolder({ 'foundry.yml': 'components: []\n' })) },
  {
    name: 'a foundry.yml with no ONTOLOGY component',
    run: () => validate(appFolder({ 'foundry.yml': 'apiNamespace: a.b\n' })),
  },
  { name: 'an empty foundry.yml', run: () => validate(appFolder({ 'foundry.yml': '' })) },
  {
    name: 'no schema-migrations.json',
    run: () =>
      validate(
        appFolder({
          'foundry.yml': 'apiNamespace: a.b\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
          'ontology/src/ontology.mts': NOTES_ONTOLOGY,
        }),
      ),
  },
  {
    name: 'a schema-migrations.json that is not JSON',
    run: () => validate(notesFolder({ '.ontology/schema-migrations.json': '{bad' })),
  },
  { name: 'no grants file', run: () => validate(notesFolder({}, 'ontology/src/grants.json')) },
  { name: 'a grants file that is not JSON', run: () => validate(notesFolder({ 'ontology/src/grants.json': '{bad' })) },
  { name: 'a grants file of the wrong shape', run: () => validate(notesFolder({ 'ontology/src/grants.json': '[]' })) },
  {
    name: 'no Ontology-as-code',
    run: () =>
      validate(
        appFolder({
          'foundry.yml': 'apiNamespace: a.b\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
          '.ontology/schema-migrations.json': '{"migrations":[]}',
          'ontology/src/grants.json': '{"permissions":{},"objectTypes":{},"actionTypes":{},"defaultRoles":{}}',
        }),
      ),
  },
  { name: 'an app that installs no @osdk/maker', run: () => validate(tempFolderOf(notesFiles())) },
  { name: 'an @osdk/maker with no bin', run: () => validate(withBinless(notesFiles())) },
  {
    name: 'a publish request above the limit',
    run: () =>
      validate(
        notesFolder({ '.ontology/schema-migrations.json': `{"migrations":[],"pad":"${'x'.repeat(5_000_000)}"}` }),
      ),
  },
  {
    name: 'the publish route refuses',
    run: () =>
      validate(
        notesFolder(),
        answers(PUBLISH, () =>
          Response.json(
            { errorCode: 'INVALID_ARGUMENT', errorName: 'InvalidOntology', errorInstanceId: 'e-400', parameters: {} },
            { status: 400 },
          ),
        ),
      ),
  },
  {
    name: 'the publish route gives 409 PublishLockTimeout 3 times',
    run: () => {
      const lock = () => Response.json({ errorName: 'PublishLockTimeout' }, { status: 409 });

      return go(['publish', '--app', 'notes', '--url', STUB], {
        cwd: notesApp({ '.ontology/deployment.json': JSON.stringify(ACME) }),
        env: ENV,
        sleeps: true,
        fetch: withService(answers(PUBLISH, lock, lock, lock)),
      });
    },
  },
];

function notesFiles(): Record<string, string> {
  return {
    'foundry.yml': 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    'ontology/src/ontology.mts': NOTES_ONTOLOGY,
    'ontology/src/grants.json': '{"permissions":{},"objectTypes":{},"actionTypes":{},"defaultRoles":{}}',
    '.ontology/schema-migrations.json': '{"migrations":[]}',
  };
}

const tempFolderOf = (files: Readonly<Record<string, string>>): string => tempFolder(files);

function withBinless(files: Readonly<Record<string, string>>): string {
  return tempFolder({
    ...files,
    'node_modules/@osdk/maker/package.json': JSON.stringify({ name: '@osdk/maker', version: '1.0.0' }),
  });
}

const GENERATE: readonly Case[] = [
  { name: 'generate-osdk: no foundry.yml', run: () => go(['generate-osdk']) },
  { name: 'generate-osdk: no osdkOutput', run: () => go(['generate-osdk'], { cwd: notesApp() }) },
  {
    name: 'generate-osdk: an app that installs no @osdk/cli',
    run: () => {
      const cwd = tempFolder({
        ...notesFiles(),
        'foundry.yml':
          'apiNamespace: com.example.notes\nosdkOutput: out\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
        'ontology/src/grants.json': '{}',
        '.ontology/deployment.json': JSON.stringify(ACME),
      });

      mkdirSync(join(cwd, 'node_modules/@osdk'), { recursive: true });

      symlinkSync(join(ROOT, 'node_modules/@osdk/maker'), join(cwd, 'node_modules/@osdk/maker'), 'dir');

      return go(['generate-osdk'], { cwd });
    },
  },
];

const functionSource = (name: string, body = 'return label;', params = 'label: string', imports = ''): string =>
  `import type { Client } from "@osdk/client";\n${imports}export default function ${name}(client: Client, ${params}): string {\n  ${body}\n}\n`;

const FUNCTIONS = 'functions/typescript-functions/src/functions';
const functionApp = (files: Readonly<Record<string, string>>) => twinFunctionsApp(files);

const DISCOVER: readonly Case[] = [
  {
    name: 'functions: no tsconfig.json',
    run: () => {
      const root = functionApp({});

      rmSync(join(root, 'functions/typescript-functions/src/tsconfig.json'));

      return validate(root);
    },
  },
  {
    name: 'functions: an empty tsconfig.json',
    run: () => validate(functionApp({ 'functions/typescript-functions/src/tsconfig.json': '' })),
  },
  {
    name: 'functions: a tsconfig.json that is not valid',
    run: () => validate(functionApp({ 'functions/typescript-functions/src/tsconfig.json': '{ "compilerOptions": ' })),
  },
  {
    name: 'functions: a type that no Function can take',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/inlineRows.ts`]: functionSource(
            'inlineRows',
            'return String(rows.length);',
            'rows: { rowId: string }[]',
          ),
        }),
      ),
  },
  {
    name: 'functions: a string enum input',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/enumInput.ts`]: `import type { Client } from "@osdk/client";\nexport enum Stage { Lead = "lead", Won = "won" }\nexport default function enumInput(client: Client, stage: Stage): string {\n  return stage;\n}\n`,
        }),
      ),
  },
  {
    name: 'functions: an interface that refers to itself',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/recursive.ts`]:
            'import type { Client } from "@osdk/client";\nexport interface Item {\n  name: string;\n  parent?: Item;\n}\nexport default function recursive(client: Client, item: Item): string {\n  return item.name;\n}\n',
        }),
      ),
  },
  {
    name: 'functions: an Object Type with no literal apiName',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/noLiteral.ts`]: functionSource(
            'noLiteral',
            'return "";',
            'set: ObjectSet<{ name: string }>',
            'import type { ObjectSet } from "@osdk/functions";\n',
          ),
        }),
      ),
  },
  {
    name: 'functions: a named default export that is not the file name',
    run: () => validate(functionApp({ [`${FUNCTIONS}/fileName.ts`]: functionSource('otherName') })),
  },
  {
    name: 'functions: a config apiName that is not the file name',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/withConfig.ts`]: `${functionSource('withConfig')}export const config = { apiName: "other" };\n`,
        }),
      ),
  },
  {
    name: 'functions: an Edits type that names a Link that the Ontology does not define',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/probeEditFkLink.ts`]: [
            'import type { Client, Osdk } from "@osdk/client";',
            'import type { Edits } from "@osdk/functions";',
            'import { Account } from "@ontology/sdk";',
            '',
            'export default function probeEditFkLink(client: Client, account: Osdk.Instance<Account>): Edits.Link<Account, "nope">[] {',
            '  return [];',
            '}',
            '',
          ].join('\n'),
        }),
      ),
  },
  {
    name: 'functions: a bundle that imports a module of Node.js',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/readsFile.ts`]: functionSource(
            'readsFile',
            'return readFileSync(path, "utf8");',
            'path: string',
            'import { readFileSync } from "fs";\n',
          ),
        }),
      ),
  },
  {
    name: 'functions: a bundle that cannot resolve a module',
    run: () =>
      validate(
        functionApp({
          [`${FUNCTIONS}/missing.ts`]: functionSource(
            'missing',
            'return other(label);',
            'label: string',
            'import { other } from "no-such-package";\n',
          ),
        }),
      ),
  },
];

const STAGING_RELEASE =
  (answer: unknown): Handler =>
  ({ method, url }) =>
    method === 'POST' && url === PUBLISH ? Response.json(answer) : undefined;

const STORED = { changes: [], metadata: stubMetadata(), version: 2 };

const releaseApp = () => notesApp({ '.ontology/deployment.json': JSON.stringify(ACME) });

const productionConfig: Handler = ({ method, url }) =>
  method === 'GET' && url === `${STUB}/api/ontology-service/v1/client-config`
    ? Response.json({ productRid: ACME.productRid, workosClientId: 'client_01STUB', environment: 'production' })
    : undefined;

async function withNpm(
  answers: { readonly view: string; readonly pack?: string },
  run: () => Promise<unknown>,
): Promise<unknown> {
  const bin = join(tempFolder(), 'bin');

  mkdirSync(bin, { recursive: true });

  const file = join(bin, 'npm');

  writeFileSync(
    file,
    `#!/bin/bash\ncase "$1" in\n  view) ${answers.view} ;;\n  pack) ${answers.pack ?? 'exit 2'} ;;\nesac\n`,
  );

  chmodSync(file, 0o755);

  const path = process.env['PATH'];

  process.env['PATH'] = `${bin}:${path}`;

  try {
    return await run();
  } finally {
    process.env['PATH'] = path;
  }
}

const publishWithNpm = () =>
  go(['publish', '--app', 'notes', '--url', STUB, '--env', 'production'], {
    cwd: releaseApp(),
    env: ENV,
    registry: npmRegistry,
    fetch: stubFetch(productionConfig, STAGING_RELEASE(STORED), stubConfig),
  });

const RELEASE: readonly Case[] = [
  {
    name: 'publish: production with no version of the hash in the registry',
    run: () =>
      go(['publish', '--app', 'notes', '--url', STUB, '--env', 'production'], {
        cwd: releaseApp(),
        env: ENV,
        registry: stubRegistry(),
        fetch: stubFetch(productionConfig, STAGING_RELEASE(STORED), stubConfig),
      }),
  },
  {
    name: 'publish: staging with no GITHUB_RUN_NUMBER',
    run: () =>
      go(['publish', '--app', 'notes', '--url', STUB], {
        cwd: releaseApp(),
        env: ENV,
        registry: stubRegistry(),
        fetch: stubFetch(STAGING_RELEASE(STORED), stubConfig),
      }),
  },
  {
    name: 'publish: staging with a GITHUB_RUN_NUMBER that is not a number',
    run: () =>
      go(['publish', '--app', 'notes', '--url', STUB], {
        cwd: releaseApp(),
        env: { ...ENV, GITHUB_RUN_NUMBER: '0' },
        registry: stubRegistry(),
        fetch: stubFetch(STAGING_RELEASE(STORED), stubConfig),
      }),
  },
  {
    name: 'publish: an Action Type with no display name',
    run: () => {
      const metadata = stubMetadata() as { actionTypes: Record<string, { displayName?: string }> };
      const first = Object.keys(metadata.actionTypes)[0] as string;

      const actionTypes = {
        ...metadata.actionTypes,
        [first]: { ...metadata.actionTypes[first], displayName: undefined },
      };

      return go(['publish', '--app', 'notes', '--url', STUB, '--env', 'production'], {
        cwd: releaseApp(),
        env: ENV,
        registry: stubRegistry(),
        fetch: stubFetch(
          productionConfig,
          STAGING_RELEASE({ ...STORED, metadata: { ...metadata, actionTypes } }),
          stubConfig,
        ),
      });
    },
  },
  {
    name: 'publish: a registry that rejects',
    run: () => {
      const registry = {
        ...stubRegistry(),
        async *find(): AsyncFallible<string | undefined, CliError> {
          return yield new CliError('registry is down');
        },
      };

      return go(['publish', '--app', 'notes', '--url', STUB, '--env', 'production'], {
        cwd: releaseApp(),
        env: ENV,
        registry,
        fetch: stubFetch(productionConfig, STAGING_RELEASE(STORED), stubConfig),
      });
    },
  },
  { name: 'publish: npm view fails', run: () => withNpm({ view: 'echo boom >&2; exit 1' }, publishWithNpm) },
  {
    name: 'publish: npm view answers E404',
    run: () => withNpm({ view: "echo 'npm error code E404' >&2; exit 1" }, publishWithNpm),
  },
  {
    name: 'publish: npm pack writes no file',
    run: () => withNpm({ view: `echo '["0.0.1"]'`, pack: 'echo "[]"' }, publishWithNpm),
  },
  { name: 'publish: npm view gives text that is not JSON', run: () => withNpm({ view: 'echo nope' }, publishWithNpm) },
  {
    name: 'publish: an app that installs no @osdk/client',
    run: () => {
      const cwd = tempFolder({
        ...notesFiles(),
        'ontology/src/grants.json': JSON.stringify({
          permissions: { 'notes:use': { description: 'Use notes.' } },
          objectTypes: { 'com.example.notes.Note': 'notes:use' },
          actionTypes: { 'com.example.notes.create-note': 'notes:use' },
          defaultRoles: { admin: ['ontology:install', 'notes:use'] },
        }),
        '.ontology/schema-migrations.json': '{"migrations":[]}\n',
        '.ontology/deployment.json': JSON.stringify(ACME),
      });

      mkdirSync(join(cwd, 'node_modules/@osdk'), { recursive: true });

      symlinkSync(join(ROOT, 'node_modules/@osdk/maker'), join(cwd, 'node_modules/@osdk/maker'), 'dir');

      return go(['publish', '--app', 'notes', '--url', STUB], {
        cwd,
        env: ENV,
        registry: stubRegistry(),
        fetch: stubFetch(STAGING_RELEASE(STORED), stubConfig),
      });
    },
  },
  {
    name: 'publish: a branch head check in GitHub Actions with no variable',
    run: () =>
      go(['publish', '--app', 'notes', '--url', STUB], {
        cwd: releaseApp(),
        env: { ...ENV, GITHUB_ACTIONS: 'true' },
        registry: stubRegistry(),
        fetch: stubFetch(STAGING_RELEASE(STORED), stubConfig),
      }),
  },
];

const DEVICE = {
  device_code: 'd',
  user_code: 'RRGQ-BJVS',
  verification_uri: 'https://auth.example/device',
  verification_uri_complete: 'https://auth.example/device?user_code=RRGQ-BJVS',
  expires_in: 300,
  interval: 5,
};

const TOKENS = { user: { id: 'user_1' }, access_token: 'a', refresh_token: 'r' };
const claims = (value: object): string => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`;

const workos =
  (device: object, ...polls: (() => Response)[]): Handler =>
  ({ url }) => {
    if (url === `${WORKOS}/authorize/device`) return Response.json(device);

    if (url === `${WORKOS}/authenticate`) return (polls.shift() ?? (() => Response.json(TOKENS)))();

    return undefined;
  };

const denied =
  (error: string, status = 400) =>
  () =>
    Response.json({ error }, { status });

const login = (handler: Handler, ...extra: string[]) =>
  go(['login', ...extra, ...TARGET], { fetch: withService(handler) });

const TEST_USER_ENV = {
  ONTOLOGY_TEST_USER_EMAIL: 'ci@example.test',
  ONTOLOGY_TEST_USER_PASSWORD: 'pw',
  WORKOS_API_KEY: STAGING_API_KEY,
};

const omit = (field: string): object => Object.fromEntries(Object.entries(DEVICE).filter(([key]) => key !== field));

const SIGN_IN: readonly Case[] = [
  {
    name: 'login: the device authorization answers 500',
    run: () =>
      go(['login', ...TARGET], {
        fetch: withService(({ url }) =>
          url === `${WORKOS}/authorize/device` ? Response.json({ message: 'down' }, { status: 500 }) : undefined,
        ),
      }),
  },
  { name: 'login: a device authorization with no device_code', run: () => login(workos(omit('device_code'))) },
  { name: 'login: a device authorization with no interval', run: () => login(workos(omit('interval'))) },
  { name: 'login: a device authorization with an interval of 0', run: () => login(workos({ ...DEVICE, interval: 0 })) },
  { name: 'login: access_denied', run: () => login(workos(DEVICE, denied('access_denied'))) },
  { name: 'login: an answer with no error', run: () => login(workos(DEVICE, denied('', 500))) },
  {
    name: 'login: the sign-in times out',
    run: () =>
      go(['login', ...TARGET], {
        sleeps: true,
        fetch: withService(workos({ ...DEVICE, expires_in: 1 }, denied('authorization_pending'))),
      }),
  },
  {
    name: 'login: slow_down, then success',
    run: () => go(['login', ...TARGET], { sleeps: true, fetch: withService(workos(DEVICE, denied('slow_down'))) }),
  },
  {
    name: 'login: tokens with no refresh_token',
    run: () => login(workos(DEVICE, () => Response.json({ user: { id: 'u' }, access_token: 'a' }))),
  },
  { name: 'login --org: WorkOS answers for no Organization', run: () => login(workos(DEVICE), '--org', 'org_1') },
  {
    name: 'login --org: WorkOS answers for another Organization',
    run: () =>
      login(
        workos(
          DEVICE,
          () => Response.json({ ...TOKENS, access_token: claims({ org_id: 'org_x' }) }),
          () => Response.json({ ...TOKENS, access_token: claims({ org_id: 'org_x' }) }),
        ),
        '--org',
        'org_1',
      ),
  },
  {
    name: 'login --org: a stored token that WorkOS refuses',
    run: () =>
      go(['login', '--org', 'org_1', ...TARGET], {
        tokens: tempFolder({ 'twin/staging': 'refresh-0' }),
        fetch: withService(workos(DEVICE, denied('invalid_grant'))),
      }),
  },
  {
    name: 'login: the list of Organizations is refused',
    run: () =>
      login(
        (call) =>
          workos(DEVICE)(call) ??
          (call.url === `${STUB}/api/ontology-service/v1/organizations`
            ? Response.json({ errorName: 'OntologyService:Forbidden' }, { status: 403 })
            : undefined),
      ),
  },
  {
    name: 'login: the list of Organizations has 2 Organizations',
    run: () =>
      login(
        (call) =>
          workos(DEVICE)(call) ??
          (call.url === `${STUB}/api/ontology-service/v1/organizations`
            ? Response.json({
                data: [
                  { id: 'o1', name: 'One' },
                  { id: 'o2', name: 'Two' },
                ],
              })
            : undefined),
      ),
  },
  {
    name: 'login: the list of Organizations is not readable',
    run: () =>
      login(
        (call) =>
          workos(DEVICE)(call) ??
          (call.url === `${STUB}/api/ontology-service/v1/organizations`
            ? new Response('nope', { status: 200 })
            : undefined),
      ),
  },
  {
    name: 'login: the list of Organizations answers 503',
    run: () =>
      login(
        (call) =>
          workos(DEVICE)(call) ??
          (call.url === `${STUB}/api/ontology-service/v1/organizations`
            ? new Response('', { status: 503 })
            : undefined),
      ),
  },
  {
    name: 'login: the list of Organizations is empty',
    run: () =>
      login(
        (call) =>
          workos(DEVICE)(call) ??
          (call.url === `${STUB}/api/ontology-service/v1/organizations` ? Response.json({ data: [] }) : undefined),
      ),
  },
  {
    name: 'login --test-user: no variable',
    run: () => go(['login', '--test-user', ...TARGET], { fetch: withService() }),
  },
  {
    name: 'login --test-user: WorkOS refuses',
    run: () =>
      go(['login', '--test-user', ...TARGET], {
        env: TEST_USER_ENV,
        fetch: withService(({ url }) =>
          url === `${WORKOS}/authenticate`
            ? Response.json({ error: 'invalid_credentials' }, { status: 401 })
            : undefined,
        ),
      }),
  },
  {
    name: 'login --test-user: success',
    run: () =>
      go(['login', '--test-user', ...TARGET], {
        env: TEST_USER_ENV,
        fetch: withService(({ url }) => (url === `${WORKOS}/authenticate` ? Response.json(TOKENS) : undefined)),
      }),
  },
  {
    name: 'a stored token that WorkOS no longer accepts',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        tokens: tempFolder({ 'twin/staging': 'refresh-0' }),
        fetch: withService(({ url }) =>
          url === `${WORKOS}/authenticate` ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : undefined,
        ),
      }),
  },
  {
    name: 'a refresh that WorkOS answers with 500 for each try',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        sleeps: true,
        tokens: tempFolder({ 'twin/staging': 'refresh-0' }),
        fetch: withService(({ url }) =>
          url === `${WORKOS}/authenticate` ? Response.json({ error: 'server_error' }, { status: 500 }) : undefined,
        ),
      }),
  },
  {
    name: 'a refresh with an answer that has no access_token',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        tokens: tempFolder({ 'twin/staging': 'refresh-0' }),
        fetch: withService(({ url }) =>
          url === `${WORKOS}/authenticate` ? Response.json({ refresh_token: 'r' }) : undefined,
        ),
      }),
  },
  {
    name: 'a GitHub OIDC token that the job cannot get',
    run: () =>
      go(['objects', ACCOUNT, ...TARGET], {
        sleeps: true,
        env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r' },
        fetch: withService(({ url }) =>
          url.startsWith('https://oidc.example/') ? Response.json({ message: 'no' }, { status: 403 }) : undefined,
        ),
      }),
  },
  { name: 'logout', run: () => go(['logout', ...TARGET], { fetch: withService() }) },
];

const KEY = 'acme/staging';

function described(error: unknown, folder: string): unknown {
  if (!(error instanceof Error)) return { value: String(error) };

  const { code, syscall } = error as NodeJS.ErrnoException;

  return {
    class: error.constructor.name,
    message: error.message
      .replaceAll(realpathSync(folder), '<store>')
      .replaceAll(folder, '<store>')
      .replaceAll(`.${process.pid}.`, '.<pid>.'),
    code,
    syscall,
  };
}

const listing = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll(`.${process.pid}.`, '.<pid>.'))
    .sort();

async function ended(folder: string, call: () => Promise<unknown>): Promise<unknown> {
  let promise: Promise<unknown>;

  try {
    promise = call();
  } catch (error) {
    return { ending: 'throws at the call', error: described(error, folder), files: listing(folder) };
  }

  const atReturn = listing(folder);

  try {
    const value = await promise;

    return { ending: 'resolves', value, atReturn, files: listing(folder) };
  } catch (error) {
    return { ending: 'rejects', error: described(error, folder), atReturn, files: listing(folder) };
  }
}

const storeIn = (files: Readonly<Record<string, string>> = {}) => {
  const folder = tempFolder(files);

  return { folder, store: orThrow(fileTokenStore(folder)) };
};

const aged = (path: string, seconds: number): void =>
  utimesSync(path, new Date(Date.now() + seconds * 1000), new Date(Date.now() + seconds * 1000));

async function signedIn(args: readonly string[], tokens: string, options: Options = {}): Promise<unknown> {
  const result = (await go(args, { ...options, tokens })) as { code: number; stdout: string; stderr: string };

  const plain = (text: string): string =>
    text
      .replaceAll(realpathSync(tokens), '<tokens>')
      .replaceAll(tokens, '<tokens>')
      .replaceAll(`.${process.pid}.`, '.<pid>.');

  return { code: result.code, stdout: plain(result.stdout), stderr: plain(result.stderr) };
}

async function library(
  args: readonly string[],
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch = withService(),
  config = '',
): Promise<unknown> {
  let stdout = '';
  let stderr = '';

  const code = await runLibrary(args, {
    cwd: tempFolder(),
    env,
    fetch,
    sleep: () => Promise.resolve(),
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });

  const plain = (text: string): string =>
    config === '' ? text : text.replaceAll(realpathSync(config), '<config>').replaceAll(config, '<config>');

  return { code, stdout: plain(stdout), stderr: plain(stderr) };
}

const configFolder = (): string => realpathSync(tempFolder());

const STORE: readonly Case[] = [
  {
    name: 'read: the key is a folder',
    run: () => ((s) => ended(s.folder, () => s.store.read(KEY)))(storeIn({ 'acme/staging/x': 'a' })),
  },
  {
    name: 'read: a key that is not a string',
    run: () => ((s) => ended(s.folder, () => s.store.read(5 as never)))(storeIn()),
  },
  {
    name: 'read: a key that holds a token with line ends',
    run: () => ((s) => ended(s.folder, () => s.store.read(KEY)))(storeIn({ 'acme/staging': '\n r1 \n' })),
  },
  { name: 'write: a free key', run: () => ((s) => ended(s.folder, () => s.store.write(KEY, 'r1')))(storeIn()) },
  {
    name: 'write: the folder of the key is a file',
    run: () => ((s) => ended(s.folder, () => s.store.write(KEY, 'r1')))(storeIn({ acme: 'a file' })),
  },
  {
    name: 'write: the store folder is a file',
    run: () =>
      ((folder) => ended(folder, () => orThrow(fileTokenStore(join(folder, 'file'))).write(KEY, 'r1')))(
        tempFolder({ file: 'a file' }),
      ),
  },
  {
    name: 'write: a key that is not a string',
    run: () => ((s) => ended(s.folder, () => s.store.write(5 as never, 'r1')))(storeIn()),
  },
  {
    name: 'write: a key whose lock name is too long',
    run: () => ((s) => ended(s.folder, () => s.store.write(`acme/${'x'.repeat(252)}`, 'r1')))(storeIn()),
  },
  {
    name: 'write: the key is a folder',
    run: () => ((s) => ended(s.folder, () => s.store.write(KEY, 'r1')))(storeIn({ 'acme/staging/x': 'a' })),
  },
  {
    name: 'write with a token that it expects: the key is a folder',
    run: () => ((s) => ended(s.folder, () => s.store.write(KEY, 'r2', 'r1')))(storeIn({ 'acme/staging/x': 'a' })),
  },
  {
    name: 'write with a token that it expects: the key holds another token',
    run: () => ((s) => ended(s.folder, () => s.store.write(KEY, 'r2', 'r1')))(storeIn({ [KEY]: 'r9' })),
  },
  {
    name: 'write with a token that it expects: a missing key stays missing',
    run: () => ((s) => ended(s.folder, () => s.store.write(KEY, 'r2', 'r1')))(storeIn({ 'acme/other': 'x' })),
  },
  {
    name: 'write: a lock older than 10 seconds',
    run: () => {
      const s = storeIn({ [`${KEY}.lock`]: 'stopped' });

      aged(join(s.folder, `${KEY}.lock`), -11);

      return ended(s.folder, () => s.store.write(KEY, 'r1'));
    },
  },
  {
    name: 'write: a lock with a time more than 10 seconds ahead',
    run: () => {
      const s = storeIn({ [`${KEY}.lock`]: 'ahead' });

      aged(join(s.folder, `${KEY}.lock`), 60);

      return ended(s.folder, () => s.store.write(KEY, 'r1'));
    },
  },
  {
    name: 'write: a lock that is a folder and older than 10 seconds',
    run: () => {
      const s = storeIn({ [`${KEY}.lock/x`]: 'a' });

      aged(join(s.folder, `${KEY}.lock`), -11);

      return ended(s.folder, () => s.store.write(KEY, 'r1'));
    },
  },
  {
    name: 'write: a lock that another writer releases after 60 ms',
    run: () => {
      const s = storeIn({ [`${KEY}.lock`]: 'other' });

      setTimeout(() => rmSync(join(s.folder, `${KEY}.lock`)), 60);

      return ended(s.folder, () => s.store.write(KEY, 'r1'));
    },
  },
  { name: 'remove: a key with no folder', run: () => ((s) => ended(s.folder, () => s.store.remove(KEY)))(storeIn()) },
  {
    name: 'remove: a key',
    run: () => ((s) => ended(s.folder, () => s.store.remove(KEY)))(storeIn({ [KEY]: 'r1', 'acme/production': 'r2' })),
  },
  {
    name: 'remove: the folder of the key is a file',
    run: () => ((s) => ended(s.folder, () => s.store.remove(KEY)))(storeIn({ acme: 'a file' })),
  },
  {
    name: 'remove: the key is a folder',
    run: () => ((s) => ended(s.folder, () => s.store.remove(KEY)))(storeIn({ 'acme/staging/x': 'a' })),
  },
  {
    name: 'remove: a key that is not a string',
    run: () => ((s) => ended(s.folder, () => s.store.remove(5 as never)))(storeIn()),
  },
  {
    name: 'remove: a key whose lock name is too long',
    run: () => ((s) => ended(s.folder, () => s.store.remove(`acme/${'x'.repeat(252)}`)))(storeIn({ 'acme/x': 'a' })),
  },
  {
    name: 'a store folder that is not a string',
    run: () => ended(tempFolder(), () => (orThrow(fileTokenStore(5 as never)), Promise.resolve('a store'))),
  },
  {
    name: 'a config folder variable that is not a string',
    run: () =>
      ended(
        tempFolder(),
        () => (orThrow(configTokenStore({ XDG_CONFIG_HOME: 5 as never })), Promise.resolve('a store')),
      ),
  },
  {
    name: 'a link to a folder names the same store',
    run: async () => {
      const folder = tempFolder();
      const link = `${folder}-link`;

      symlinkSync(folder, link, 'dir');

      const store = orThrow(fileTokenStore(folder));

      return {
        same: store === orThrow(fileTokenStore(link)),
        sameWithDot: store === orThrow(fileTokenStore(join(folder, 'a', '..'))),
        other: store === orThrow(fileTokenStore(tempFolder())),
      };
    },
  },
  {
    name: 'login: the folder of the token is a file',
    run: () => signedIn(['login', ...TARGET], tempFolder({ twin: 'a file' }), { fetch: withService(workos(DEVICE)) }),
  },
  {
    name: 'login: the token is a folder',
    run: () =>
      signedIn(['login', ...TARGET], tempFolder({ 'twin/staging/x': 'a' }), { fetch: withService(workos(DEVICE)) }),
  },
  {
    name: 'logout: the folder of the token is a file',
    run: () => signedIn(['logout', ...TARGET], tempFolder({ twin: 'a file' }), { fetch: withService() }),
  },
  {
    name: 'logout: the token is a folder',
    run: () => signedIn(['logout', ...TARGET], tempFolder({ 'twin/staging/x': 'a' }), { fetch: withService() }),
  },
  {
    name: 'logout: a token',
    run: () => signedIn(['logout', ...TARGET], tempFolder({ 'twin/staging': 'r1' }), { fetch: withService() }),
  },
  {
    name: 'objects: the stored token is a folder',
    run: () =>
      signedIn(['objects', ACCOUNT, ...TARGET], tempFolder({ 'twin/staging/x': 'a' }), { fetch: withService() }),
  },
  {
    name: 'the library entry: a config folder variable that is not a string',
    run: () => library(['--version'], { XDG_CONFIG_HOME: 5 as never }),
  },
  {
    name: 'the library entry: a getter of tokenStore that throws',
    run: async () => {
      let stderr = '';

      const io = {
        cwd: tempFolder(),
        env: {},
        fetch: withService(),
        sleep: () => Promise.resolve(),
        stdout: () => undefined,
        stderr: (text: string) => void (stderr += text),
      };

      Object.defineProperty(io, 'tokenStore', {
        get: () => {
          throw new Error('getter boom');
        },
      });

      return { code: await runLibrary(['--version'], io), stderr };
    },
  },
  {
    name: 'the library entry: login with a config folder under a file',
    run: () => {
      const config = tempFolder({ file: 'a file' });

      return library(
        ['login', ...TARGET],
        { XDG_CONFIG_HOME: join(config, 'file') },
        withService(workos(DEVICE)),
        config,
      );
    },
  },
  {
    name: 'the library entry: login and logout with the default token store',
    run: async () => {
      const config = configFolder();

      const login = await library(['login', ...TARGET], { XDG_CONFIG_HOME: config }, withService(workos(DEVICE)));

      const kept = listing(config);

      const logout = await library(['logout', ...TARGET], { XDG_CONFIG_HOME: config });

      return { login, kept, logout, left: listing(config) };
    },
  },
];

const GROUPS: readonly [string, readonly Case[]][] = [
  ['the commands', COMMANDS],
  ['the targets and the calls to the service', TARGETS],
  ['the Ontologies', ONTOLOGIES],
  ['the app folder', APP],
  ['generate-osdk', GENERATE],
  ['the Function discovery', DISCOVER],
  ['the release of the Ontology SDK package', RELEASE],
  ['the sign-in', SIGN_IN],
  ['the token store', STORE],
];

describe('service/cli#output', () => {
  for (const [group, cases] of GROUPS) {
    describe(group, () => {
      for (const { name, run } of cases) {
        it(name, async () => {
          expect(await run()).toMatchSnapshot();
        });
      }
    });
  }
});
