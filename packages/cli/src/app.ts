import type { OsdkSet, PublishRequest, SchemaMigrationsFile } from '@ericbragas/ontos-service/publish';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseGrantsFile } from '@ericbragas/ontos-service/convert';
import { parse } from 'yaml';
import { CliError } from './cliError.ts';
import { caught, type Fallible } from './fallible.ts';
import { findUp } from './targets.ts';

type ConfigFileName = 'ontos.yml' | 'foundry.yml';

const CONFIG_FILES: readonly ConfigFileName[] = ['ontos.yml', 'foundry.yml'];

export interface App {
  readonly root: string;
  readonly configFile: ConfigFileName;
  readonly apiNamespace: string;
  readonly osdkOutput: string | undefined;
  readonly ontology: string;
  readonly functions: string | undefined;
}

const OSDK_SET_PACKAGES = [
  '@osdk/maker',
  '@osdk/maker-experimental',
  '@osdk/client',
  '@osdk/cli',
  '@osdk/functions',
] as const;

function findConfigFile(folder: string): string | undefined {
  for (let at = folder; ; at = dirname(at)) {
    for (const name of CONFIG_FILES) {
      const file = join(at, name);

      if (existsSync(file)) return file;
    }

    if (dirname(at) === at) return undefined;
  }
}

export function* readApp(cwd: string): Fallible<App, CliError> {
  const file = findConfigFile(cwd);

  if (!file)
    return yield new CliError(
      `No ontos.yml or foundry.yml in ${cwd} or a parent folder. The app needs an ontos.yml (or foundry.yml) at its root.`,
    );

  const root = dirname(file);
  const configFile = basename(file) as ConfigFileName;
  const config = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;

  if ('products' in config)
    return yield new CliError(
      `${configFile} has a products: list. The Ontology service serves 1 Ontology for each app, so use components.`,
    );

  const components = Array.isArray(config['components'])
    ? (config['components'] as { type?: unknown; path?: unknown }[])
    : [];

  const path = (type: string): string | undefined => {
    const component = components.find((entry) => entry.type === type);

    return typeof component?.path === 'string' ? resolve(root, component.path) : undefined;
  };

  if (components.some((entry) => entry.type === 'PYTHON_FUNCTIONS')) {
    return yield new CliError(
      `${configFile} has a PYTHON_FUNCTIONS component. V1 Functions are TypeScript v2 Functions.`,
    );
  }

  const apiNamespace = config['apiNamespace'];

  if (typeof apiNamespace !== 'string' || apiNamespace === '')
    return yield new CliError(`${configFile} has no apiNamespace.`);

  const ontology = path('ONTOLOGY');

  if (!ontology) return yield new CliError(`${configFile} has no ONTOLOGY component with a path.`);

  const osdkOutput = config['osdkOutput'];

  return {
    root,
    configFile,
    apiNamespace,
    osdkOutput: typeof osdkOutput === 'string' ? osdkOutput : undefined,
    ontology,
    functions: path('TYPESCRIPT_FUNCTIONS'),
  };
}

function packageFolders(app: App): string[] {
  return [app.ontology, ...(app.functions ? [app.functions] : []), app.root];
}

export function installedPackage(app: App, name: string): string | undefined {
  for (const folder of packageFolders(app)) {
    const file = findUp(folder, join('node_modules', name, 'package.json'));

    if (file) return file;
  }

  return undefined;
}

export function readOsdkSet(app: App): OsdkSet {
  const set: Record<string, string> = {};

  for (const name of OSDK_SET_PACKAGES) {
    const file = installedPackage(app, name);

    if (file) set[name] = (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
  }

  return set;
}

export function* readSchemaMigrations(app: App): Fallible<SchemaMigrationsFile, CliError> {
  const file = join(app.root, '.ontology', 'schema-migrations.json');

  if (!existsSync(file))
    return yield new CliError(
      `No .ontology/schema-migrations.json in ${app.root}. An app with no migration holds {"migrations": []}.`,
    );

  const parsed = caught(() => JSON.parse(readFileSync(file, 'utf8')) as SchemaMigrationsFile);

  if (!parsed.ok)
    return yield new CliError(
      `.ontology/schema-migrations.json is not JSON: ${parsed.error instanceof Error ? parsed.error.message : String(parsed.error)}`,
    );

  return parsed.value;
}

export function* readGrants(app: App): Fallible<PublishRequest['grants'], CliError> {
  const file = join(app.ontology, 'src', 'grants.json');
  const path = relative(app.root, file);

  if (!existsSync(file))
    return yield new CliError(
      `No ${path} in ${app.root}. The app writes its permissions and its default roles in this file.`,
    );

  const read = caught((): unknown => JSON.parse(readFileSync(file, 'utf8')));

  if (!read.ok)
    return yield new CliError(
      `${path} is not JSON: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
    );

  const parsed = parseGrantsFile(read.value);

  if ('problem' in parsed) return yield new CliError(`${path} is not a grants file of v3: ${parsed.problem}`);

  return parsed.grants;
}
