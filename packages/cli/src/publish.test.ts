import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  changedPaths,
  committedApp,
  FUNCTIONS_TSCONFIG,
  NO_MIGRATIONS,
  NOTES_GRANTS,
  NOTES_ONTOLOGY,
  notesApp,
  standInSdk,
  TWIN_FUNCTIONS,
  twinFunction,
  twinGrants,
  twinOntology,
} from './apps.test-utils.ts';
import {
  appFolder,
  cli,
  STUB,
  stubConfig,
  stubFetch,
  withoutDescriptionWarnings,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const flags = ['--app', 'notes', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };
const PUBLISH = `${STUB}/api/ontology-service/v1/publish`;
const ANSWER = { changes: [], metadata: { ontology: { rid: 'ri.ontology.main.ontology.stub' } }, version: 1 };

function publishRoute(...answers: { status: number; body: unknown }[]): Handler {
  return ({ method, url }) => {
    if (method !== 'POST' || url !== PUBLISH) return undefined;

    const next = answers.shift() ?? { status: 200, body: ANSWER };

    return Response.json(next.body, { status: next.status });
  };
}

const bodies = (calls: readonly Call[]) =>
  calls.filter(({ url }) => url === PUBLISH).map(({ body }) => JSON.parse(body ?? 'null') as Record<string, unknown>);

const objectTypes = (body: Record<string, unknown> | undefined): string[] =>
  Object.keys((body?.['ir'] as { ontology: { objectTypes: object } } | undefined)?.ontology.objectTypes ?? {});

describe('foundry.yml', () => {
  const hook = {
    '.env': 'NODE_OPTIONS=--require ./hook.cjs\n',
    'hook.cjs': "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'hook-ran'), '');\n",
  };

  let hookProbe: string;

  beforeAll(() => {
    hookProbe = notesApp(hook);

    execFileSync(process.execPath, ['-e', ''], {
      cwd: hookProbe,
      env: { ...process.env, NODE_OPTIONS: '--require ./hook.cjs' },
    });
  });

  it('service/cli#targets: the values of .env reach no child process, so a NODE_OPTIONS in .env runs no code in @osdk/maker', async () => {
    expect(existsSync(join(hookProbe, 'hook-ran'))).toBe(true);

    const app = notesApp(hook);

    const run = await cli(['validate', ...flags], { cwd: app, fetch: stubFetch(stubConfig, publishRoute()), env });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(existsSync(join(app, 'hook-ran'))).toBe(false);
  });

  it('service/cli#inputs: validate looks for foundry.yml in the current folder, then in each parent folder, and its folder is the root of the app', async () => {
    const root = notesApp();
    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd: join(root, 'ontology', 'src'), fetch, env });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(objectTypes(bodies(fetch.calls)[0])).toEqual(['com.example.notes.Note']);

    const none = appFolder({ 'ontology/src/ontology.mts': NOTES_ONTOLOGY });

    const missing = await cli(['validate', ...flags], {
      cwd: join(none, 'ontology'),
      fetch: stubFetch(stubConfig, publishRoute()),
      env,
    });

    expect(missing.code).toBe(1);

    expect(missing.error).toEqual({
      message: `No ontos.yml or foundry.yml in ${join(none, 'ontology')} or a parent folder. The app needs an ontos.yml (or foundry.yml) at its root.`,
    });
  });

  it('prefers ontos.yml over foundry.yml in the same folder and reports ontos.yml in validation errors', async () => {
    const root = appFolder({
      'ontos.yml': 'apiNamespace: com.example.ontos\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'foundry.yml': 'apiNamespace: com.example.foundry\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'ontology/src/ontology.mts': NOTES_ONTOLOGY,
      'ontology/src/grants.json': JSON.stringify({
        permissions: {},
        objectTypes: { 'com.example.ontos.Note': 'ontos:use' },
        actionTypes: { 'com.example.ontos.create-note': 'ontos:use' },
        defaultRoles: {},
      }),
      '.ontology/schema-migrations.json': NO_MIGRATIONS,
    });

    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd: root, fetch, env });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(objectTypes(bodies(fetch.calls)[0])).toEqual(['com.example.ontos.Note']);

    const badOntos = appFolder({ 'ontos.yml': 'components: []\n' });

    const refused = await cli(['validate', ...flags], { cwd: badOntos, fetch: stubFetch(stubConfig), env });

    expect(refused.code).toBe(1);
    expect(refused.error).toEqual({ message: 'ontos.yml has no apiNamespace.' });
  });

  it('service/cli#inputs: the CLI reads apiNamespace and the path of the ONTOLOGY and TYPESCRIPT_FUNCTIONS components', async () => {
    const root = appFolder({
      'foundry.yml': 'apiNamespace: com.example.other\ncomponents:\n  - type: ONTOLOGY\n    path: ./model\n',
      'model/src/ontology.mts': NOTES_ONTOLOGY,
      'model/src/grants.json': JSON.stringify({
        permissions: {},
        objectTypes: { 'com.example.other.Note': 'other:use' },
        actionTypes: { 'com.example.other.create-note': 'other:use' },
        defaultRoles: {},
      }),
      '.ontology/schema-migrations.json': NO_MIGRATIONS,
    });

    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd: root, fetch, env });

    expect(run.stderr).toBe('');
    expect(objectTypes(bodies(fetch.calls)[0])).toEqual(['com.example.other.Note']);

    const functions = Object.fromEntries(
      TWIN_FUNCTIONS.map((name) => [`code/fns/src/functions/${name}.ts`, twinFunction(name)]),
    );

    const twin = appFolder({
      'foundry.yml':
        'apiNamespace: com.example.twin\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n  - type: TYPESCRIPT_FUNCTIONS\n    path: ./code/fns\n',
      'ontology/src/ontology.mts': twinOntology('0.7.0'),
      'ontology/src/grants.json': twinGrants('0.7.0'),
      '.ontology/schema-migrations.json': NO_MIGRATIONS,
      'code/fns/src/tsconfig.json': FUNCTIONS_TSCONFIG,
      ...functions,
      ...standInSdk('code/fns'),
    });

    const twinFetch = stubFetch(stubConfig, publishRoute());

    const withFunctions = await cli(['validate', ...flags], { cwd: twin, fetch: twinFetch, env });

    expect(withoutDescriptionWarnings(withFunctions.stderr)).toBe('');

    const discovered = (
      bodies(twinFetch.calls)[0]?.['functions'] as
        { discovered: { locator: { typescript: { filePath: string } } }[] } | undefined
    )?.discovered;

    expect(discovered?.map(({ locator }) => locator.typescript.filePath)).toEqual([
      'functions/closeAccount.ts',
      'functions/probeVersionCheck.ts',
      'functions/setRelationship.ts',
    ]);
  });

  it('service/cli#inputs: the CLI ignores each other key of foundry.yml, and refuses a products: list and a PYTHON_FUNCTIONS component, with an error that names the key', async () => {
    const yml = 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n';

    const other = await cli(['validate', ...flags], {
      cwd: notesApp({
        'foundry.yml': `${yml}  - type: APP\n    path: ./app\nbundle:\n  name: notes\nminCliVersion: "0.324.0"\nunknownKey: true\n`,
      }),
      fetch: stubFetch(stubConfig, publishRoute()),
      env,
    });

    expect(other.stderr).toBe('');
    expect(other.code).toBe(0);

    const products = await cli(['validate', ...flags], {
      cwd: notesApp({ 'foundry.yml': `${yml}products:\n  - name: a\n` }),
      fetch: stubFetch(stubConfig, publishRoute()),
      env,
    });

    expect(products.code).toBe(1);

    expect(products.error).toEqual({
      message:
        'foundry.yml has a products: list. The Ontology service serves 1 Ontology for each app, so use components.',
    });

    const python = await cli(['validate', ...flags], {
      cwd: notesApp({ 'foundry.yml': `${yml}  - type: PYTHON_FUNCTIONS\n    path: ./functions/python-functions\n` }),
      fetch: stubFetch(stubConfig, publishRoute()),
      env,
    });

    expect(python.code).toBe(1);

    expect(python.error).toEqual({
      message: 'foundry.yml has a PYTHON_FUNCTIONS component. V1 Functions are TypeScript v2 Functions.',
    });
  });

  it('service/cli#inputs: the file name src/ontology.mts is fixed, and the app commits no IR', async () => {
    const root = appFolder({
      'foundry.yml': 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'ontology/src/ontology.ts': NOTES_ONTOLOGY,
      '.ontology/schema-migrations.json': NO_MIGRATIONS,
    });

    const run = await cli(['validate', ...flags], { cwd: root, fetch: stubFetch(stubConfig, publishRoute()), env });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message: `No Ontology-as-code: ${join(root, 'ontology', 'src', 'ontology.mts')} does not exist.`,
    });
  });

  it('service/cli#inputs: validate on an Ontology with a value type leaves no file in the app folder', async () => {
    const ontology = `import { defineCreateObjectAction, defineObject, defineValueType } from "@osdk/maker";

const noteStatus = defineValueType({
    apiName: "noteStatus",
    displayName: "Note status",
    version: "1.0.0",
    type: {
        type: "string",
        constraints: [{ constraint: { type: "oneOf", oneOf: { values: ["open", "done"], useIgnoreCase: false } } }],
    },
});

const note = defineObject({
    apiName: "Note",
    displayName: "Note",
    pluralDisplayName: "Notes",
    description: "A note.",
    titlePropertyApiName: "text",
    primaryKeyPropertyApiName: "noteId",
    properties: {
        noteId: { type: "string", displayName: "Note ID", description: "The ID of the note." },
        text: { type: "string", description: "The words of the note." },
        status: { type: "string", description: "The status of the note.", valueType: noteStatus },
    },
    editsEnabled: true,
    includeEmptyBackingDatasource: true,
});

defineCreateObjectAction({
    objectType: note,
    apiName: "create-note",
    description: "Writes a note.",
    parameterConfiguration: {
        noteId: { description: "The ID." },
        text: { description: "The words." },
        status: { description: "The status." },
    },
});
`;

    const root = committedApp(notesApp({ 'ontology/src/ontology.mts': ontology }));
    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd: root, fetch, env });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const valueTypes = (
      bodies(fetch.calls)[0]?.['ir'] as
        { valueTypes?: { valueTypes?: { metadata: { apiName: string } }[] } } | undefined
    )?.valueTypes?.valueTypes;

    expect(valueTypes?.map(({ metadata }) => metadata.apiName)).toEqual(['noteStatus']);
    expect(changedPaths(root)).toEqual([]);
  });
});

describe('the grants file', () => {
  it.each(['validate', 'publish'])(
    'service/cli#inputs: with no grants file, %s stops with an error that names the path, and sends nothing',
    async (command) => {
      const cwd = notesApp();

      rmSync(join(cwd, 'ontology/src/grants.json'));

      const fetch = stubFetch(stubConfig, publishRoute());

      const run = await cli([command, ...flags], { cwd, fetch, env });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message: `No ontology/src/grants.json in ${cwd}. The app writes its permissions and its default roles in this file.`,
      });

      expect(bodies(fetch.calls)).toEqual([]);
    },
  );

  it.each(['validate', 'publish'])(
    'service/cli#inputs service/publish#what-the-app-publishes %s reads <ONTOLOGY path>/src/grants.json, and sends it as the field grants',
    async (command) => {
      const fetch = stubFetch(stubConfig, publishRoute());

      const run = await cli([command, ...flags], { cwd: notesApp(), fetch, env });

      expect(run.stderr).toBe('');

      expect(bodies(fetch.calls)[0]?.['grants']).toEqual({
        permissions: { 'notes:use': { description: 'Use the notes' } },
        objectTypes: { 'com.example.notes.Note': 'notes:use' },
        actionTypes: { 'com.example.notes.create-note': 'notes:use' },
        defaultRoles: { admin: ['ontology:install', 'notes:use'], member: ['notes:use'] },
      });
    },
  );

  it.each(['validate', 'publish'])(
    '%s sends the optional key personAttributes of the grants file as it is',
    async (command) => {
      const personAttributes = {
        noteIds: { start: { objectType: 'com.example.notes.Note', property: 'ownerId' }, links: [] },
      };

      const grants = { ...JSON.parse(NOTES_GRANTS), personAttributes } as Record<string, unknown>;
      const fetch = stubFetch(stubConfig, publishRoute());

      const run = await cli([command, ...flags], {
        cwd: notesApp({ 'ontology/src/grants.json': JSON.stringify(grants) }),
        fetch,
        env,
      });

      expect(run.stderr).toBe('');
      expect(bodies(fetch.calls)[0]?.['grants']).toEqual(grants);
    },
  );

  it('the grants file is next to src/ontology.mts in the folder of the ONTOLOGY component', async () => {
    const cwd = appFolder({
      'foundry.yml': 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./model\n',
      'model/src/ontology.mts': NOTES_ONTOLOGY,
      'model/src/grants.json': NOTES_GRANTS,
      'ontology/src/grants.json': '{"roles": []}',
      '.ontology/schema-migrations.json': NO_MIGRATIONS,
    });

    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd, fetch, env });

    expect(run.stderr).toBe('');
    expect(bodies(fetch.calls)[0]?.['grants']).toEqual(JSON.parse(NOTES_GRANTS));
  });

  it('service/cli#inputs: a grants file that is not JSON stops validate with an error that names the path', async () => {
    const cwd = notesApp({ 'ontology/src/grants.json': '' });

    const run = await cli(['validate', ...flags], { cwd, fetch: stubFetch(stubConfig, publishRoute()), env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual({ message: 'ontology/src/grants.json is not JSON: Unexpected end of JSON input' });
  });

  it('service/cli#inputs: a grants file of v2 stops validate with an error that names the path, and sends nothing', async () => {
    const cwd = notesApp({
      'ontology/src/grants.json': JSON.stringify({
        roles: ['admin'],
        objectTypes: { 'com.example.notes.Note': ['admin'] },
        actionTypes: {},
      }),
    });

    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd, fetch, env });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message:
        'ontology/src/grants.json is not a grants file of v3: The grants file has the key roles. Its keys are permissions, objectTypes, actionTypes, defaultRoles, queryTypes, and personAttributes.',
    });

    expect(bodies(fetch.calls)).toEqual([]);
  });
});

describe('the publish request', () => {
  it('ontology/object-edits/schema-migrations#the-schema-migrations-file: with no .ontology/schema-migrations.json, validate stops and sends nothing', async () => {
    const cwd = appFolder({
      'foundry.yml': 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
      'ontology/src/ontology.mts': NOTES_ONTOLOGY,
    });

    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['validate', ...flags], { cwd, fetch, env });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      message: `No .ontology/schema-migrations.json in ${cwd}. An app with no migration holds {"migrations": []}.`,
    });

    expect(bodies(fetch.calls)).toEqual([]);
  });

  it('service/publish#route: above 4.5 MB, the CLI stops before it sends, and prints the size of each part', async () => {
    const migrations = JSON.stringify({
      migrations: Array.from({ length: 90_000 }, (_, at) => ({
        type: 'dropAllPatches',
        objectType: `com.example.notes.Type${String(at).padStart(5, '0')}`,
      })),
    });

    const fetch = stubFetch(stubConfig, publishRoute());

    const run = await cli(['publish', ...flags], {
      cwd: notesApp({ '.ontology/schema-migrations.json': migrations }),
      fetch,
      env,
    });

    expect(run.code).toBe(1);
    expect(bodies(fetch.calls)).toEqual([]);

    const error = run.error as {
      message: string;
      bytes: { ir: number; schemaMigrations: number; functionBundle: number; total: number };
    };

    expect(error.bytes).toEqual({
      ir: 4438,
      schemaMigrations: 6_210_016,
      functionBundle: 0,
      discoveredFunctions: 0,
      total: 6_214_929,
    });

    expect(error.message).toBe('The publish request is 6214929 bytes, above the limit of 4500000 bytes.');
  });

  it('service/cli#commands: after 409 PublishLockTimeout, publish tries again, up to 3 tries in total, 30 seconds apart, and prints the error body of each try', async () => {
    const timeout = {
      errorCode: 'CONFLICT',
      errorName: 'PublishLockTimeout',
      errorInstanceId: 'e-1',
      parameters: { phase: 'lock', table: 'objects_note', changed: false },
    };

    const second = { ...timeout, errorInstanceId: 'e-2' };
    const fetch = stubFetch(stubConfig, publishRoute({ status: 409, body: timeout }, { status: 409, body: second }));

    const run = await cli(['publish', ...flags], { cwd: notesApp(), fetch, env });

    expect(run.code).toBe(0);
    expect(run.output).toEqual(ANSWER);
    expect(run.stderr).toBe(`${JSON.stringify(timeout)}\n${JSON.stringify(second)}\n`);
    expect(run.sleeps).toEqual([30_000, 30_000]);
    expect(bodies(fetch.calls)).toHaveLength(3);

    const third = { ...timeout, errorInstanceId: 'e-3' };

    const failed = await cli(['publish', ...flags], {
      cwd: notesApp(),
      fetch: stubFetch(
        stubConfig,
        publishRoute({ status: 409, body: timeout }, { status: 409, body: second }, { status: 409, body: third }),
      ),
      env,
    });

    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe(`${JSON.stringify(timeout)}\n${JSON.stringify(second)}\n${JSON.stringify(third)}\n`);
    expect(failed.sleeps).toEqual([30_000, 30_000]);
  });

  it('service/cli#output: publish sends a publish that gets a 503 or a network error 1 time', async () => {
    const unavailable = {
      errorCode: 'INTERNAL',
      errorName: 'ServiceUnavailable',
      errorInstanceId: 'e-503',
      parameters: {},
    };

    const fetch = stubFetch(stubConfig, publishRoute({ status: 503, body: unavailable }));

    const run = await cli(['publish', ...flags], { cwd: notesApp(), fetch, env });

    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`${JSON.stringify(unavailable)}\n`);
    expect(run.sleeps).toEqual([]);
    expect(bodies(fetch.calls)).toHaveLength(1);

    const lost = stubFetch(
      stubConfig,
      ({ url }) => {
        if (url === PUBLISH) throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });

        return undefined;
      },
      publishRoute(),
    );

    const dropped = await cli(['publish', ...flags], { cwd: notesApp(), fetch: lost, env });

    expect(dropped.code).toBe(1);
    expect(dropped.sleeps).toEqual([]);
    expect(bodies(lost.calls)).toHaveLength(1);
  });

  it('service/cli#commands: validate does not try again after 409, and prints the error body', async () => {
    const timeout = {
      errorCode: 'CONFLICT',
      errorName: 'PublishLockTimeout',
      errorInstanceId: 'e-1',
      parameters: { phase: 'lock', table: 'objects_note', changed: false },
    };

    const fetch = stubFetch(stubConfig, publishRoute({ status: 409, body: timeout }));

    const run = await cli(['validate', ...flags], { cwd: notesApp(), fetch, env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual(timeout);
    expect(bodies(fetch.calls).map((body) => body['validateOnly'])).toEqual([true]);
  });

  it.each(['validate', 'publish'])(
    'service/releases#osdk-sets service/cli#output: %s of a deprecated OSDK set succeeds, and prints each warning of the answer as 1 line on stderr, not in the output',
    async (command) => {
      const warning =
        'The OSDK set client-2.80.0 is deprecated. Move to an OSDK set that is not deprecated: client-2.90.0. Only a new major version can remove it.';

      const fetch = stubFetch(stubConfig, publishRoute({ status: 200, body: { ...ANSWER, warnings: [warning] } }));

      const run = await cli([command, ...flags], { cwd: notesApp(), fetch, env });

      expect(run.code).toBe(0);
      expect(run.stderr).toBe(`${JSON.stringify({ warning })}\n`);
      expect(run.output).toEqual(ANSWER);
    },
  );

  it.each(['validate', 'publish'])(
    'service/releases#osdk-sets: %s of a set that is not deprecated prints no warning',
    async (command) => {
      const run = await cli([command, ...flags], {
        cwd: notesApp(),
        fetch: stubFetch(stubConfig, publishRoute()),
        env,
      });

      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.output).toEqual(ANSWER);
    },
  );
});
