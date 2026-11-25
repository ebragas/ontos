import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appFolder, ROOT } from './cli.test-utils.ts';

export const TWIN_FUNCTIONS = ['closeAccount', 'probeVersionCheck', 'setRelationship'] as const;

const GATE_TSCONFIG = {
  compilerOptions: {
    target: 'es2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['*.ts', '**/*.ts'],
};

const ADDED_HEADER = /^\/\* oxlint-disable /;
const HEADER_LINES = 1;

export function twinFunction(name: string): string {
  return readFileSync(join(ROOT, `packages/service/twin/functions/src/${name}.ts`), 'utf8')
    .split('\n')
    .filter((line, index) => index >= HEADER_LINES || !ADDED_HEADER.test(line))
    .join('\n')
    .replace(/from ['"]\.\/sdk\.ts['"];/, 'from "@ontology/sdk";');
}

const TWIN_FOUNDRY_YML = `minCliVersion: "0.324.0"
functionsTypescriptRuntimeVersion: "0.123.0"
components:
  - type: ONTOLOGY
    path: ./ontology
  - type: TYPESCRIPT_FUNCTIONS
    path: ./functions/typescript-functions
  - type: APP
    path: ./app
imports:
  - ontology: ontology/external-imports/ontology-full-metadata.json
bundle:
  name: "ontology-twin"
  description: ""
  associatedRid: "ri.stemma.main.repository.00000000-0000-4000-8000-000000000001"
  installMode: SINGLETON
osdkOutput: ontology/osdk-output
apiNamespace: com.example.twin
platformApiProxy:
  passthrough:
    - path: /api/v2/admin/users/getCurrent
      methods: [GET]
unknownKey: true
`;

export const NO_MIGRATIONS = '{"migrations":[]}\n';

export const GATE_DEPLOYMENT_FILE = `${JSON.stringify(
  {
    productRid: 'ri.ontology.main.ontology.11111111-1111-4111-8111-111111111111',
    production: {
      baseUrl: 'https://app.ontos.example',
      workosClientId: 'client_01TESTAPP0000000000000000',
      trustedGithubRepository: 'ebragas/ontos',
      trustedGithubEnvironment: 'production',
      authkitDomain: 'test-tenant.authkit.app',
      mcp: true,
    },
  },
  null,
  2,
)}\n`;

export function twinOntology(version: string): string {
  return readFileSync(join(ROOT, `packages/service/twin/ontology/${version}/ontology.ts`), 'utf8');
}

export function twinGrants(version: string): string {
  return readFileSync(join(ROOT, `packages/service/twin/ontology/${version}/grants.json`), 'utf8');
}

export function twinIr(version: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, `packages/service/twin/ir/${version}.json`), 'utf8'));
}

export const OSDK_SET = (() => {
  const set = (
    JSON.parse(readFileSync(join(ROOT, 'packages/service/osdk-sets.json'), 'utf8')) as {
      name: string;
      packages: Record<string, string>;
    }[]
  ).find(({ name }) => name === 'client-2.92.0');

  if (!set) throw new Error('packages/service/osdk-sets.json has no OSDK set client-2.92.0.');

  return set.packages;
})();

export const PINNED_PACKAGE_JSON = `${JSON.stringify({ private: true, type: 'module', dependencies: OSDK_SET }, null, 2)}\n`;

export function committedApp(root: string): string {
  writeFileSync(join(root, 'package.json'), PINNED_PACKAGE_JSON);

  writeFileSync(join(root, '.gitignore'), 'node_modules\n');

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root },
    );

  git('init', '-q');

  git('add', '-A');

  git('commit', '-qm', 'app');

  return root;
}

export function changedPaths(root: string): string[] {
  return execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

export function twinApp(files: Readonly<Record<string, string>> = {}): string {
  return appFolder({
    'foundry.yml': TWIN_FOUNDRY_YML,
    'ontology/src/ontology.mts': twinOntology('0.7.0'),
    'ontology/src/grants.json': twinGrants('0.7.0'),
    '.ontology/schema-migrations.json': NO_MIGRATIONS,
    '.ontology/deployment.json': GATE_DEPLOYMENT_FILE,
    ...files,
  });
}

export const FUNCTIONS_TSCONFIG = JSON.stringify(GATE_TSCONFIG);

export function standInSdk(component = 'functions/typescript-functions'): Record<string, string> {
  return {
    [`${component}/node_modules/@ontology/sdk/package.json`]: JSON.stringify({
      name: '@ontology/sdk',
      type: 'module',
      exports: { '.': { types: './index.ts', default: './index.ts' } },
    }),
    [`${component}/node_modules/@ontology/sdk/index.ts`]: readFileSync(
      join(ROOT, 'packages/service/twin/functions/src/sdk.ts'),
      'utf8',
    ),
  };
}

export function twinFunctionsApp(files: Readonly<Record<string, string>> = {}): string {
  const functions = Object.fromEntries(
    TWIN_FUNCTIONS.map((name) => [`functions/typescript-functions/src/functions/${name}.ts`, twinFunction(name)]),
  );

  return twinApp({
    'functions/typescript-functions/src/tsconfig.json': FUNCTIONS_TSCONFIG,
    ...functions,
    ...standInSdk(),
    ...files,
  });
}

export const NOTES_ONTOLOGY = `import { defineCreateObjectAction, defineObject } from "@osdk/maker";

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
    },
    editsEnabled: true,
    includeEmptyBackingDatasource: true,
});

defineCreateObjectAction({
    objectType: note,
    apiName: "create-note",
    description: "Writes a note.",
    parameterConfiguration: { noteId: { description: "The ID." }, text: { description: "The words." } },
});
`;

export const NOTES_GRANTS = `${JSON.stringify({
  permissions: { 'notes:use': { description: 'Use the notes' } },
  objectTypes: { 'com.example.notes.Note': 'notes:use' },
  actionTypes: { 'com.example.notes.create-note': 'notes:use' },
  defaultRoles: { admin: ['ontology:install', 'notes:use'], member: ['notes:use'] },
})}\n`;

export function notesApp(files: Readonly<Record<string, string>> = {}): string {
  return appFolder({
    'foundry.yml': 'apiNamespace: com.example.notes\ncomponents:\n  - type: ONTOLOGY\n    path: ./ontology\n',
    'ontology/src/ontology.mts': NOTES_ONTOLOGY,
    'ontology/src/grants.json': NOTES_GRANTS,
    '.ontology/schema-migrations.json': NO_MIGRATIONS,
    '.ontology/deployment.json': GATE_DEPLOYMENT_FILE,
    ...files,
  });
}

export function linkedApp(
  functions: readonly string[] = TWIN_FUNCTIONS,
  files: Readonly<Record<string, string>> = {},
): string {
  const root = twinApp({
    'functions/typescript-functions/src/tsconfig.json': FUNCTIONS_TSCONFIG,
    ...Object.fromEntries(
      functions.map((name) => [`functions/typescript-functions/src/functions/${name}.ts`, twinFunction(name)]),
    ),
    ...files,
  });

  mkdirSync(join(root, 'functions/typescript-functions/node_modules/@ontology'), { recursive: true });

  symlinkSync(
    join(root, 'ontology/osdk-output/ontology'),
    join(root, 'functions/typescript-functions/node_modules/@ontology/sdk'),
    'dir',
  );

  return root;
}
