import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError } from './cliError.ts';
import { caught, each, settle, type Fallible } from './fallible.ts';

const DEPLOYMENT_FILE = '.ontology/deployment.json';

export const DEFAULT_DEV_PRODUCT_RID = 'ri.ontology.main.ontology.00000000-0000-4000-8000-000000000001';

export type EnvironmentName = 'staging' | 'production';

export const ENVIRONMENTS: readonly EnvironmentName[] = ['staging', 'production'];

interface Environment {
  readonly baseUrl: string;
  readonly workosClientId: string;
}

export interface DeploymentFile {
  readonly productRid: string;
  readonly staging?: Environment;
  readonly production?: Environment;
}

const RID = /^ri\.ontology\.main\.ontology\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isProductRid = (value: string): boolean => RID.test(value);

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function* readDeploymentFile(
  folder: string,
  path?: string,
): Fallible<{ readonly path: string; readonly file: DeploymentFile }, CliError> {
  const full = resolve(folder, path ?? DEPLOYMENT_FILE);

  if (!existsSync(full)) return yield new CliError(`The deployment file ${full} does not exist.`);

  const text = caught(() => readFileSync(full, 'utf8'));

  if (!text.ok) return yield new CliError(`${full}: ${(text.error as Error).message}`);

  const parsed = settle(parseDeploymentFile(text.value));

  if (!parsed.ok) return yield new CliError(`${full}: ${parsed.error.message}`);

  return { path: full, file: parsed.value };
}

function* required(object: Json, key: string, path: string): Fallible<string, CliError> {
  const value = object[key];

  if (typeof value !== 'string' || value === '') return yield new CliError(`${path} must be a non-empty string.`);

  return value;
}

function* environment(file: Json, name: EnvironmentName): Fallible<Environment, CliError> {
  const object = file[name];

  if (!isObject(object)) return yield new CliError(`${name} must be an object.`);

  const baseUrl = yield* required(object, 'baseUrl', `${name}.baseUrl`);

  if (!URL.canParse(baseUrl) || new URL(baseUrl).protocol !== 'https:' || new URL(baseUrl).origin !== baseUrl) {
    return yield new CliError(`${name}.baseUrl must be an https origin.`);
  }

  const workosClientId = yield* required(object, 'workosClientId', `${name}.workosClientId`);

  if (!workosClientId.startsWith('client_'))
    return yield new CliError(`${name}.workosClientId must start with client_.`);

  return { baseUrl, workosClientId };
}

function* parseDeploymentFile(text: string): Fallible<DeploymentFile, CliError> {
  const json = caught(() => JSON.parse(text) as unknown);

  if (!json.ok)
    return yield new CliError(`The file is not valid JSON: ${(json.error as Error).message}`, undefined, {
      cause: json.error,
    });

  const file = json.value;

  if (!isObject(file)) return yield new CliError('The file must hold a JSON object.');

  const productRid = yield* required(file, 'productRid', 'productRid');

  if (!RID.test(productRid))
    return yield new CliError('productRid must have the form ri.ontology.main.ontology.<UUID>.');

  const environments = Object.fromEntries(
    yield* each(
      ENVIRONMENTS.filter((name) => file[name] !== undefined),
      function* (name): Fallible<readonly [EnvironmentName, Environment], CliError> {
        return [name, yield* environment(file, name)];
      },
    ),
  );

  if (Object.keys(environments).length === 0)
    return yield new CliError('The file has no environment. It needs staging, production, or both.');

  return { productRid, ...environments };
}
