import type { OsdkSet, PublishResponse } from '@ericbragas/ontos-service/publish';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { CliError } from '../cliError.ts';
import type { Context } from '../commands/types.ts';
import type { DeploymentFile } from '../deploymentFile.ts';
import type { AsyncFallible, Fallible } from '../fallible.ts';
import { caught } from '../fallible.ts';
import type { Io, Variables } from '../io.ts';
import type { DomainFile } from './domain.ts';
import { sdkFields, writeSdk, type SdkFields } from './generate.ts';
import { serviceModuleText } from './serviceModule.ts';

export interface SdkPackageResult {
  readonly name: string;
  readonly version: string;
  readonly ontologyHash: string;
  readonly action: 'published' | 'unchanged' | 'tagged';
}

const DEFAULT_REGISTRY = 'https://npm.pkg.github.com';
const DEFAULT_SCOPE = '@ontos';
const VALID_SCOPE = /^@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const STAGING_TAG = 'staging';
const PRODUCTION_TAGS = ['production', 'latest'] as const;

export function* sdkPackageConfig(
  app: string,
  env: Variables,
): Fallible<{ readonly name: string; readonly registry: string }, CliError> {
  const rawRegistry = env['ONTOS_SDK_REGISTRY']?.trim();
  const registry = rawRegistry || DEFAULT_REGISTRY;

  if (rawRegistry) {
    const parsed = caught(() => new URL(rawRegistry));

    if (!parsed.ok || (parsed.value.protocol !== 'https:' && parsed.value.protocol !== 'http:'))
      return yield new CliError('ONTOS_SDK_REGISTRY must be an http:// or https:// URL.');

    if (parsed.value.username || parsed.value.password)
      return yield new CliError('ONTOS_SDK_REGISTRY must not contain embedded credentials.');
  }

  const rawScope = env['ONTOS_SDK_PACKAGE_SCOPE']?.trim();
  const scope = !rawScope ? DEFAULT_SCOPE : rawScope.startsWith('@') ? rawScope : `@${rawScope}`;

  if (!VALID_SCOPE.test(scope) || scope.includes('..'))
    return yield new CliError('ONTOS_SDK_PACKAGE_SCOPE must be a valid npm scope, such as @my-org.');

  return { name: `${scope}/${app}-ontology-sdk`, registry };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);

    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export function* manifestFields(
  osdkSet: OsdkSet,
  hasDomain = false,
  registry = DEFAULT_REGISTRY,
): Fallible<SdkFields & { readonly publishConfig: { readonly registry: string; readonly tag: string } }, CliError> {
  return { ...(yield* sdkFields(osdkSet, hasDomain)), publishConfig: { registry, tag: STAGING_TAG } };
}

export function ontologyHash(
  metadata: PublishResponse['metadata'],
  osdkSet: OsdkSet,
  manifest: object,
  serviceModule: string,
  domain?: readonly DomainFile[],
): string {
  const input =
    domain && domain.length > 0
      ? {
          metadata,
          osdkSet,
          manifest,
          serviceModule,
          domain: [...domain]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .map(({ path, bytes }) => [path, bytes.toString('base64')]),
        }
      : { metadata, osdkSet, manifest, serviceModule };

  return createHash('sha256').update(canonical(input)).digest('hex');
}

export async function* releaseSdkPackage(
  context: {
    readonly target: Pick<Context['target'], 'app' | 'environment'>;
    readonly io: Pick<Io, 'env' | 'registry'>;
  },
  app: App,
  deployment: DeploymentFile,
  response: PublishResponse,
  osdkSet: OsdkSet,
  domain?: readonly DomainFile[],
): AsyncFallible<SdkPackageResult | undefined, CliError> {
  if (!deployment.staging) return undefined;

  const { io, target } = context;
  const { name, registry } = yield* sdkPackageConfig(target.app, io.env);
  const fields = yield* manifestFields(osdkSet, domain !== undefined, registry);

  const hash = ontologyHash(
    response.metadata,
    osdkSet,
    fields,
    yield* serviceModuleText(response.metadata, deployment),
    domain,
  );

  const matching = yield* io.registry.find(name, hash, app.root, registry);

  if (target.environment === 'production') {
    if (!matching)
      return yield new CliError(
        `No version of ${name} has the ontologyHash ${hash} of the current Ontology version of production. Publish the Ontology to staging first.`,
      );

    for (const tag of PRODUCTION_TAGS) yield* io.registry.tag(name, matching, tag, app.root, registry);

    return { name, version: matching, ontologyHash: hash, action: 'tagged' };
  }

  if (matching) return { name, version: matching, ontologyHash: hash, action: 'unchanged' };

  const run = io.env['GITHUB_RUN_NUMBER'];

  if (!run || !/^[1-9]\d*$/.test(run))
    return yield new CliError(
      `The Ontology SDK package needs a new version, 0.0.<GITHUB_RUN_NUMBER>, and GITHUB_RUN_NUMBER is ${run === undefined ? 'not set' : `"${run}"`}. Run ontos publish in the publish workflow.`,
    );

  const version = `0.0.${run}`;
  const folder = mkdtempSync(join(tmpdir(), 'ontology-sdk-package-'));

  try {
    yield* writeSdk(
      app,
      response.metadata,
      deployment,
      folder,
      { name, version, ...fields, ontologyHash: hash },
      domain,
    );

    yield* io.registry.publish(folder, app.root);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  return { name, version, ontologyHash: hash, action: 'published' };
}

export { npmRegistry } from './npmRegistry.ts';
