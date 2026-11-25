import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from '../cliError.ts';
import { caught, type Fallible } from '../fallible.ts';
import type { Io } from '../io.ts';
import type { Flags } from '../main.ts';

export const INIT_OSDK_PACKAGES: Readonly<Record<string, string>> = {
  '@osdk/maker': '0.91.0',
  '@osdk/maker-experimental': '0.87.0',
  '@osdk/client': '2.92.0',
  '@osdk/cli': '0.120.0',
  '@osdk/functions': '1.30.0',
};

const ONTOS_YML = `apiNamespace: com.example.tasks
osdkOutput: ontology/osdk-output
components:
  - type: ONTOLOGY
    path: ./ontology
`;

const ONTOLOGY_MTS = `import { defineCreateObjectAction, defineObject } from '@osdk/maker';

const task = defineObject({
  apiName: 'Task',
  displayName: 'Task',
  pluralDisplayName: 'Tasks',
  description: 'A task tracked in this Ontology.',
  titlePropertyApiName: 'title',
  primaryKeyPropertyApiName: 'taskId',
  properties: {
    taskId: {
      type: 'string',
      displayName: 'Task ID',
      description: 'Unique identifier for the task.',
    },
    title: {
      type: 'string',
      displayName: 'Title',
      description: 'Short summary of the task.',
      nullability: { noNulls: true, noEmptyCollections: false },
    },
    completed: {
      type: 'boolean',
      displayName: 'Completed',
      description: 'Whether the task is complete.',
    },
  },
  editsEnabled: true,
  editsHistoryConfig: { enabled: true },
  includeEmptyBackingDatasource: true,
});

defineCreateObjectAction({
  objectType: task,
  apiName: 'create-task',
  displayName: 'Create Task',
  description: 'Create a new task.',
  parameterConfiguration: {
    taskId: { description: 'Unique identifier for the task.' },
    title: { description: 'Short summary of the task.' },
    completed: { description: 'Whether the task is complete.' },
  },
});
`;

const GRANTS_JSON = `${JSON.stringify(
  {
    permissions: {
      'tasks:read': { description: 'Read tasks' },
      'tasks:write': { description: 'Create and update tasks' },
    },
    objectTypes: {
      'com.example.tasks.Task': 'tasks:read',
    },
    actionTypes: {
      'com.example.tasks.create-task': 'tasks:write',
    },
    defaultRoles: {
      admin: ['ontology:install', 'tasks:read', 'tasks:write'],
      member: ['tasks:read', 'tasks:write'],
    },
  },
  null,
  2,
)}\n`;

const SCHEMA_MIGRATIONS_JSON = `${JSON.stringify({ migrations: [] }, null, 2)}\n`;

const GITIGNORE = `node_modules/
ontology/osdk-output/
.env
.env.local
`;

function packageName(directory: string): string {
  const cleaned = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');

  return cleaned === '' ? 'ontos-app' : cleaned;
}

function packageJson(directory: string, version: string): string {
  return `${JSON.stringify(
    {
      name: packageName(directory),
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'ontos dev',
        'generate-osdk': 'ontos generate-osdk',
        'publish:local': 'ontos publish --url http://127.0.0.1:8080 --skip-sdk-package',
      },
      dependencies: INIT_OSDK_PACKAGES,
      devDependencies: {
        '@ericbragas/ontos-cli': version,
        '@ericbragas/ontos-service': version,
      },
    },
    null,
    2,
  )}\n`;
}

export function* initProject(
  io: Pick<Io, 'cwd'>,
  dir: string | undefined,
  flags: Pick<Flags, 'force'>,
  version: string,
): Fallible<{ readonly directory: string; readonly files: readonly string[] }, CliError> {
  const directory = resolve(io.cwd, dir ?? '.');

  const entries: readonly (readonly [string, string])[] = [
    ['ontos.yml', ONTOS_YML],
    ['package.json', packageJson(directory, version)],
    ['ontology/src/ontology.mts', ONTOLOGY_MTS],
    ['ontology/src/grants.json', GRANTS_JSON],
    ['.ontology/schema-migrations.json', SCHEMA_MIGRATIONS_JSON],
    ['.gitignore', GITIGNORE],
  ];

  if (flags.force !== true) {
    const existing = entries.map(([path]) => path).filter((path) => existsSync(join(directory, path)));

    if (existing.length > 0) {
      return yield new CliError(
        `Refusing to overwrite existing file${existing.length === 1 ? '' : 's'} in ${directory}: ${existing.join(', ')}. Pass --force to overwrite.`,
      );
    }
  }

  const written = caught(() => {
    for (const [relativePath, content] of entries) {
      const fullPath = join(directory, relativePath);

      mkdirSync(dirname(fullPath), { recursive: true });

      writeFileSync(fullPath, content, 'utf8');
    }
  });

  if (!written.ok) {
    return yield new CliError(
      `Failed to initialize project in ${directory}: ${written.error instanceof Error ? written.error.message : String(written.error)}`,
    );
  }

  return { directory, files: entries.map(([path]) => path) };
}
