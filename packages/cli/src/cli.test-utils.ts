import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileTokenStore } from './auth/store.ts';
import { resetAccessTokens } from './auth/provider.ts';
import type { CliError } from './cliError.ts';
import { answerOf, orThrow } from './fallible.ts';
import type { Io, Registry } from './io.ts';
import { run } from './main.ts';
import { resetMetadata } from './metadataCache.ts';
import { STUB_ONTOLOGY_RID, STUB_PAGE_TOKEN, stubExchange, stubMetadata } from './stubExchanges.test-utils.ts';

export const ROOT = new URL('../../../', import.meta.url).pathname;

export const CLI_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as { version: string }
).version;

export const SERVICE_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'packages/service/package.json'), 'utf8')) as { version: string }
).version;

export const STUB_RID = STUB_ONTOLOGY_RID;
export const CLIENT_2_PAGE_TOKEN = STUB_PAGE_TOKEN;
export const STUB = 'https://stub.test';
export const STUB_CONFIG = { productRid: STUB_RID, workosClientId: 'client_01STUB', environment: 'staging' };

export interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly requestBody: unknown;
  readonly status: number;
  readonly responseBody: unknown;
}

export { stubExchange, stubMetadata };

export function withRequest(exchange: Exchange, fields: Readonly<Record<string, unknown>>): Exchange {
  return { ...exchange, requestBody: { ...(exchange.requestBody as object), ...fields } };
}

export interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

export type Handler = (call: Call) => Response | Promise<Response | undefined> | undefined;

export function stubFetch(...handlers: Handler[]): typeof fetch & { readonly calls: Call[] } {
  const calls: Call[] = [];

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);

    const body = request.body ? await request.text() : undefined;

    const call: Call = { method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body };

    calls.push(call);

    for (const handler of handlers) {
      const response = await handler(call);

      if (response) return response;
    }

    return Response.json(
      { stub: 'no handler answers this call', method: call.method, url: call.url, body },
      { status: 599 },
    );
  };

  return Object.assign(stub as typeof fetch, { calls });
}

export const STUB_ONTOLOGY = { rid: STUB_RID, apiName: 'twin', displayName: 'Twin', description: '' };

export function stubOntologies(...data: readonly { readonly rid: string; readonly apiName: string }[]): Handler {
  return ({ method, url }) =>
    method === 'GET' && url === `${STUB}/api/v2/ontologies` ? Response.json({ data }) : undefined;
}

export const stubConfig: Handler = (call) => {
  if (call.method === 'GET' && call.url === `${STUB}/api/ontology-service/v1/client-config`)
    return Response.json(STUB_CONFIG);

  if (call.method === 'GET' && call.url === `${STUB}/api/ontology-service/v1/organizations`)
    return new Response(null, { status: 404 });

  return stubOntologies(STUB_ONTOLOGY)(call);
};

export function replay(...exchanges: Exchange[]): Handler {
  return ({ method, url, body }) => {
    const { pathname, search } = new URL(url);

    const hit = exchanges.find(
      (exchange) =>
        url.startsWith(STUB) &&
        exchange.method === method &&
        exchange.path === pathname &&
        (exchange.query ?? '') === search &&
        isDeepStrictEqual(exchange.requestBody, body === undefined || body === '' ? null : JSON.parse(body)),
    );

    return hit ? Response.json(hit.responseBody, { status: hit.status }) : undefined;
  };
}

export const withoutDescriptionWarnings = (stderr: string): string =>
  stderr
    .split('\n')
    .filter((line) => !/^\{"warning":"[^"]* has no description\."\}$/.test(line))
    .join('\n');

export function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;

  return () => (made ??= make());
}

export async function warm(...runs: readonly (() => Promise<unknown>)[]): Promise<void> {
  for (const start of runs) await start().catch(() => undefined);
}

export function tempFolder(files: Readonly<Record<string, string>> = {}): string {
  const folder = mkdtempSync(join(tmpdir(), 'ontology-cli-'));

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });

    writeFileSync(join(folder, path), text);
  }

  return folder;
}

export function appFolder(files: Readonly<Record<string, string>> = {}): string {
  const folder = tempFolder(files);

  symlinkSync(join(ROOT, 'node_modules'), join(folder, 'node_modules'), 'dir');

  return folder;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: unknown;
  readonly error: unknown;
  readonly sleeps: readonly number[];
}

export interface CliOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly tokens?: string;
  readonly sleeps?: number[];
  readonly sleep?: Io['sleep'];
  readonly registry?: Registry;
  readonly signals?: FakeSignals;
  readonly isTty?: boolean;
  readonly onStdout?: (text: string) => void;
}

export class FakeSignals {
  private readonly stops = new Set<() => Promise<void>>();

  readonly onStop = (stop: () => Promise<void>): (() => void) => {
    this.stops.add(stop);

    return () => this.stops.delete(stop);
  };

  async send(): Promise<void> {
    const stops = [...this.stops];

    this.stops.clear();

    await Promise.all(stops.map((stop) => stop()));
  }
}

interface PublishedPackage {
  readonly manifest: Record<string, unknown>;
  readonly files: readonly string[];
  readonly cwd: string;
}

export interface PackageVersion {
  readonly version: string;
  readonly ontologyHash: string | undefined;
}

export interface StubRegistry extends Registry {
  readonly packages: Map<string, PackageVersion[]>;
  readonly published: PublishedPackage[];
  readonly findCalls: { name: string; ontologyHash: string; cwd: string; registry: string }[];
  readonly tags: { name: string; version: string; tag: string }[];
  readonly tagCalls: { name: string; version: string; tag: string; cwd: string; registry: string }[];
}

export function stubRegistry(packages: Readonly<Record<string, readonly PackageVersion[]>> = {}): StubRegistry {
  const stored = new Map(Object.entries(packages).map(([name, versions]) => [name, [...versions]]));
  const published: PublishedPackage[] = [];
  const findCalls: StubRegistry['findCalls'] = [];
  const tags: StubRegistry['tags'] = [];
  const tagCalls: StubRegistry['tagCalls'] = [];

  return {
    packages: stored,
    published,
    findCalls,
    tags,
    tagCalls,
    find: (name, ontologyHash, cwd, registry) => {
      findCalls.push({ name, ontologyHash, cwd, registry });

      return answerOf<string | undefined, CliError>(
        Promise.resolve((stored.get(name) ?? []).findLast((version) => version.ontologyHash === ontologyHash)?.version),
      );
    },
    publish: (folder, cwd) => {
      const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as Record<string, unknown>;
      const files = readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort();

      published.push({ manifest, files, cwd });

      const name = String(manifest['name']);

      stored.set(name, [
        ...(stored.get(name) ?? []),
        { version: String(manifest['version']), ontologyHash: manifest['ontologyHash'] as string | undefined },
      ]);

      return answerOf<undefined, CliError>(Promise.resolve(undefined));
    },
    tag: (name, version, tag, cwd, registry) => {
      tags.push({ name, version, tag });

      tagCalls.push({ name, version, tag, cwd, registry });

      return answerOf<undefined, CliError>(Promise.resolve(undefined));
    },
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function cli(args: readonly string[], options: CliOptions = {}): Promise<CliRun> {
  resetMetadata();

  resetAccessTokens();

  let stdout = '';
  let stderr = '';
  const sleeps = options.sleeps ?? [];
  const rawFetch = options.fetch ?? stubFetch();
  const pending = new Set<Promise<unknown>>();

  const track = (promise: Promise<unknown>): void => {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );

    pending.add(settled);

    void settled.finally(() => {
      pending.delete(settled);
    });
  };

  const trackedFetch: typeof fetch = (input, init) => {
    const request = Promise.resolve(rawFetch(input, init)).then((response) => {
      if (response.body !== null) track(response.clone().arrayBuffer());

      return response;
    });

    track(request);

    return request;
  };

  const io: Io = {
    cwd: options.cwd ?? tempFolder(),
    env: options.env ?? {},
    stdout: (text) => {
      stdout += text;

      options.onStdout?.(text);
    },
    stderr: (text) => {
      stderr += text;
    },
    fetch: trackedFetch,
    tokenStore: orThrow(fileTokenStore(options.tokens ?? tempFolder())),
    registry: options.registry ?? stubRegistry(),
    sleep: (ms) => {
      sleeps.push(ms);

      return options.sleep?.(ms) ?? Promise.resolve();
    },
    onStop: (options.signals ?? new FakeSignals()).onStop,
    isTty: options.isTty ?? false,
  };

  try {
    const code = await run(args, io);

    return { code, stdout, stderr, output: parse(stdout), error: parse(stderr), sleeps };
  } finally {
    while (pending.size > 0) await Promise.all([...pending]);
  }
}

const LIBRARY_ENTRY = new URL('./index.ts', import.meta.url).href;

const RUN_LIBRARY_IN_FOLDER = [
  "import { rmdirSync } from 'node:fs';",
  'const [entry, folder, argsJson, remove] = process.argv.slice(1);',
  'const { run } = await import(entry);',
  'process.chdir(folder);',
  "if (remove === 'remove') rmdirSync(folder);",
  "let stdout = '';",
  "let stderr = '';",
  'const code = await run(JSON.parse(argsJson), {',
  '  stdout: (text) => { stdout += text; },',
  '  stderr: (text) => { stderr += text; },',
  '});',
  'process.stdout.write(JSON.stringify({ code, stdout, stderr }));',
].join('\n');

export function runLibraryInFolder(
  folder: string,
  args: readonly string[],
  options: { readonly remove?: boolean } = {},
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      RUN_LIBRARY_IN_FOLDER,
      LIBRARY_ENTRY,
      folder,
      JSON.stringify(args),
      options.remove ? 'remove' : '',
    ],
    { encoding: 'utf8' },
  );

  return JSON.parse(out) as { readonly code: number; readonly stdout: string; readonly stderr: string };
}
