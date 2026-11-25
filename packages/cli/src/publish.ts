import type { PublishedFunctions, PublishRequest, PublishResponse } from '@ericbragas/ontos-service/publish';
import { readApp, readGrants, readOsdkSet, readSchemaMigrations, type App } from './app.ts';
import { makeIr } from './appRunner.ts';
import { checkBranchHead } from './branchHead.ts';
import { CliError, errorBody } from './cliError.ts';
import type { Context } from './commands/types.ts';
import { readDeploymentFile, type DeploymentFile } from './deploymentFile.ts';
import { descriptionWarnings } from './descriptionWarnings.ts';
import { failureOf, inStep } from './errors.ts';
import { attempt, type AsyncFallible, type Fallible } from './fallible.ts';
import { appFunctions } from './functions/index.ts';
import { warn } from './io.ts';
import { dropMetadata } from './metadataCache.ts';
import { readDomain, type DomainFile } from './sdk/domain.ts';
import { releaseSdkPackage, type SdkPackageResult } from './sdk/sdkPackage.ts';

const PUBLISH_PATH = '/api/ontology-service/v1/publish';
const MAX_REQUEST_BYTES = 4_500_000;
const PUBLISH_TRIES = 3;
const RETRY_WAIT_MS = 30_000;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

function* bodyOf(
  product: string,
  app: App,
  ir: PublishRequest['ir'],
  validateOnly: boolean,
  functions: PublishedFunctions | undefined,
): Fallible<PublishRequest, CliError> {
  return {
    product,
    ir,
    schemaMigrations: yield* readSchemaMigrations(app),
    osdkSet: readOsdkSet(app),
    grants: yield* readGrants(app),
    ...(functions ? { functions } : {}),
    validateOnly,
  };
}

function* checkSize(body: PublishRequest): Fallible<void, CliError> {
  const total = bytes(body);

  if (total <= MAX_REQUEST_BYTES) return;

  const sizes = {
    ir: bytes(body.ir),
    schemaMigrations: bytes(body.schemaMigrations),
    functionBundle: body.functions ? Buffer.byteLength(body.functions.bundle, 'utf8') : 0,
    discoveredFunctions: body.functions ? bytes(body.functions.discovered) : 0,
    total,
  };

  return yield new CliError(`The publish request is ${total} bytes, above the limit of ${MAX_REQUEST_BYTES} bytes.`, {
    message: `The publish request is ${total} bytes, above the limit of ${MAX_REQUEST_BYTES} bytes.`,
    bytes: sizes,
  });
}

async function* sendPublish(context: Context, body: PublishRequest): AsyncFallible<PublishResponse, CliError> {
  const { target, io } = context;
  const { token } = yield* context.connection();
  const text = JSON.stringify(body);

  for (let tries = 1; ; tries += 1) {
    const bearer = yield* attempt(() => token(), failureOf);

    const response = yield* attempt(
      () =>
        io.fetch(new URL(PUBLISH_PATH, target.url), {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: text,
        }),
      failureOf,
    );

    if (response.status === 200) return yield* attempt(() => response.json() as Promise<PublishResponse>, failureOf);

    const error = yield* errorBody(response);

    const retry =
      !body.validateOnly &&
      response.status === 409 &&
      (error as { errorName?: unknown }).errorName === 'PublishLockTimeout' &&
      tries < PUBLISH_TRIES;

    if (!retry) return yield new CliError(`The publish gave ${response.status}.`, error);

    io.stderr(`${JSON.stringify(error)}\n`);

    yield* attempt(() => io.sleep(RETRY_WAIT_MS), failureOf);
  }
}

export type PublishOutput = Omit<PublishResponse, 'warnings'> & { readonly ontologySdk?: SdkPackageResult };

export async function* publishApp(context: Context, validateOnly: boolean): AsyncFallible<PublishOutput, CliError> {
  try {
    return yield* sendApp(context, validateOnly);
  } finally {
    dropMetadata(context.target.url);
  }
}

interface PreparedPublish {
  readonly app: App;
  readonly deployment: DeploymentFile | undefined;
  readonly domain: readonly DomainFile[] | undefined;
  readonly ir: PublishRequest['ir'];
  readonly body: PublishRequest;
}

async function* preparePublish(context: Context, validateOnly: boolean): AsyncFallible<PreparedPublish, CliError> {
  const app = yield* readApp(context.io.cwd);
  const skipSdk = context.flags['skip-sdk-package'] === true;
  const deployment = validateOnly || skipSdk ? undefined : (yield* readDeploymentFile(app.root)).file;
  const domain = yield* readDomain(app.root);
  const ir = yield* makeIr(app);
  const body = yield* bodyOf(context.target.app, app, ir, validateOnly, yield* appFunctions(app, ir));

  yield* checkSize(body);

  return { app, deployment, domain, ir, body };
}

async function* sendApp(context: Context, validateOnly: boolean): AsyncFallible<PublishOutput, CliError> {
  const { app, deployment, domain, ir, body } = yield* inStep('build Ontology', () =>
    preparePublish(context, validateOnly),
  );

  if (!validateOnly) yield* inStep('branch head check', () => checkBranchHead(context.io, 'publish'));

  const { warnings, ...response } = yield* inStep('publish call', () => sendPublish(context, body));

  for (const text of [...descriptionWarnings(ir, body.functions), ...(warnings ?? [])]) warn(context.io, text);

  if (!deployment || context.flags['skip-sdk-package']) return response;

  const ontologySdk = yield* inStep('Ontology SDK package', () =>
    releaseSdkPackage(context, app, deployment, response, body.osdkSet, domain),
  );

  return ontologySdk ? { ...response, ontologySdk } : response;
}
