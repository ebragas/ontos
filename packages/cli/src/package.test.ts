import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_OPTIONS } from '../build.ts';
import {
  cli,
  once,
  stubExchange,
  stubMetadata,
  replay,
  ROOT,
  SERVICE_VERSION,
  STUB,
  STUB_CONFIG,
  stubConfig,
  stubFetch,
  tempFolder,
  type Handler,
} from './cli.test-utils.ts';

const cliBundle = once(() =>
  build({ ...BUILD_OPTIONS, write: false, metafile: true, outfile: join(tempFolder(), 'ontos.js') }),
);

const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const fullMetadata: Handler = ({ method, url }) =>
  method === 'GET' && new URL(url).pathname === `/api/v2/ontologies/${STUB_CONFIG.productRid}/fullMetadata`
    ? Response.json(stubMetadata())
    : undefined;

describe('the CLI package', () => {
  it('service/cli#package: the CLI is the npm package @ericbragas/ontos-cli, and its command is ontos', () => {
    expect(manifest.name).toBe('@ericbragas/ontos-cli');
    expect(manifest.bin).toEqual({ ontos: 'dist/ontos.js' });
  });

  it('service/code-layout#typescript: the CLI pins exact versions of typescript and esbuild as its own dependencies, lazy-loads them, and does not bundle them', async () => {
    expect(manifest.dependencies).toEqual({ esbuild: '0.28.2', typescript: '6.0.3' });
    expect(manifest.optionalDependencies).toEqual({ '@ericbragas/ontos-service': SERVICE_VERSION });

    const result = await cliBundle();

    const output = Object.values(result.metafile?.outputs ?? {})[0];
    const externalImports = output?.imports.filter(({ external }) => external) ?? [];
    const imported = new Set(externalImports.map(({ path }) => path));

    expect(imported.has('typescript') && imported.has('esbuild')).toBe(true);
    expect(imported.has('@ericbragas/ontos-service')).toBe(true);

    expect(
      externalImports.filter(
        ({ path, kind }) =>
          (path === 'typescript' || path === 'esbuild' || path === '@ericbragas/ontos-service') &&
          kind !== 'dynamic-import',
      ),
    ).toEqual([]);

    const bundled = Object.keys(output?.inputs ?? {});

    expect(bundled.filter((path) => /node_modules\/(typescript|esbuild)\//.test(path))).toEqual([]);
    expect(bundled.some((path) => path.includes('node_modules/@osdk/client/'))).toBe(true);
  });

  it('service/code-layout#packages: the CLI bundle holds the compile step and the converter of packages/service, and no database driver', async () => {
    const result = await cliBundle();

    const output = Object.values(result.metafile?.outputs ?? {})[0];
    const bundled = Object.keys(output?.inputs ?? {});

    expect(bundled).toContain('packages/service/dist/convert.js');
    expect(bundled.filter((path) => /node_modules\/(pg|pg-[\w-]+|@vercel\/functions)\//.test(path))).toEqual([]);
    expect(bundled.filter((path) => path.startsWith('packages/service/src/db/'))).toEqual([]);
    expect(result.outputFiles?.[0]?.text).not.toMatch(/function loadOntology\b/);
    expect(output?.imports.map(({ path }) => path).filter((path) => /^pg(\/|$)|^pg-/.test(path))).toEqual([]);
  });

  it('service/code-layout#modules: the CLI bundle holds big.js through the compile step, and holds no pg', async () => {
    const result = await cliBundle();

    const output = Object.values(result.metafile?.outputs ?? {})[0];
    const bundled = Object.keys(output?.inputs ?? {});

    expect(bundled).toContain('packages/service/dist/convert.js');
    expect(bundled.some((path) => path.includes('node_modules/big.js/'))).toBe(true);
    expect(bundled.filter((path) => /node_modules\/(pg|pg-[\w-]+)\//.test(path))).toEqual([]);
    expect(output?.imports.map(({ path }) => path).filter((path) => /^pg(\/|$)|^pg-/.test(path))).toEqual([]);
  });

  it('service/code-layout#modules: the CLI bundle holds the value types compile step and the valueTypes module, and holds no pg', async () => {
    const result = await cliBundle();

    const output = Object.values(result.metafile?.outputs ?? {})[0];
    const bundled = Object.keys(output?.inputs ?? {});

    expect(bundled).toContain('packages/service/dist/convert.js');
    expect(result.outputFiles?.[0]?.text).toContain('compileValueTypes');
    expect(bundled.filter((path) => /node_modules\/(pg|pg-[\w-]+)\//.test(path))).toEqual([]);
    expect(output?.imports.map(({ path }) => path).filter((path) => /^pg(\/|$)|^pg-/.test(path))).toEqual([]);
  });

  it('ontology/object-link-types/properties#uniqueness-constraints: the CLI bundle holds the Uniqueness constraint compile step, and holds no pg', async () => {
    const result = await cliBundle();

    const output = Object.values(result.metafile?.outputs ?? {})[0];
    const bundled = Object.keys(output?.inputs ?? {});

    expect(bundled).toContain('packages/service/dist/convert.js');
    expect(result.outputFiles?.[0]?.text).toContain('compileUniqueness');
    expect(bundled.filter((path) => /node_modules\/(pg|pg-[\w-]+)\//.test(path))).toEqual([]);
    expect(output?.imports.map(({ path }) => path).filter((path) => /^pg(\/|$)|^pg-/.test(path))).toEqual([]);
  });

  it('service/code-layout#packages: the helper of yielded failures brings only its own files of packages/service into the CLI bundle', async () => {
    const result = await build({
      ...BUILD_OPTIONS,
      entryPoints: [join(ROOT, 'packages/cli/src/fallible.ts')],
      write: false,
      metafile: true,
      outfile: join(tempFolder(), 'fallible.js'),
    });

    expect(Object.keys(result.metafile?.inputs ?? {}).sort()).toEqual([
      'packages/cli/src/fallible.ts',
      'packages/service/src/errors/fallible.ts',
      'packages/service/src/errors/fallible/bridges.ts',
      'packages/service/src/errors/fallible/combinators.ts',
      'packages/service/src/errors/fallible/settle.ts',
      'packages/service/src/errors/fallible/types.ts',
    ]);
  });

  it('service/code-layout#modules: the CLI bundle holds no @opentelemetry text and no file of spans', async () => {
    const result = await cliBundle();

    const output = Object.values(result.metafile?.outputs ?? {})[0];

    expect(result.outputFiles?.[0]?.text.match(/@opentelemetry/g) ?? []).toEqual([]);

    expect(Object.keys(output?.inputs ?? {}).filter((path) => path.startsWith('packages/service/src/spans/'))).toEqual(
      [],
    );
  });

  it("service/cli#package: describe, objects, aggregate, apply, and history read their metadata through OSDK's packages, with no Ontology SDK, in any folder", async () => {
    const rid = STUB_CONFIG.productRid;

    const editsHistory: Handler = ({ method, url }) =>
      method === 'POST' &&
      new URL(url).pathname === `/api/v2/ontologies/${rid}/objectTypes/com.example.twin.Account/editsHistory`
        ? Response.json({ data: [], totalCount: 0 })
        : undefined;

    const cases: [string[], Handler, string[]][] = [
      [['describe'], fullMetadata, ['fullMetadata']],
      [
        ['objects', 'com.example.twin.Account', '--page-size', '2', '--order-by', '{"name":"asc"}'],
        replay(stubExchange('client', 1), stubExchange('client', 2)),
        ['objectTypes/com.example.twin.Account/fullMetadata', 'objectSets/loadObjects'],
      ],
      [
        [
          'aggregate',
          'com.example.twin.Engagement',
          '--select',
          '{"$count":"unordered","amount:sum":"unordered","amount:max":"unordered"}',
          '--group-by',
          '{"status":"exact"}',
        ],
        replay(stubExchange('client', 11)),
        ['objectSets/aggregate'],
      ],
      [
        [
          'apply',
          'com.example.twin.create-engagement',
          '--parameters',
          '{"engagementId":"eng-7","accountId":"acc-2","title":"Expansion","amount":22000}',
        ],
        replay(stubExchange('client', 14), stubExchange('client', 15)),
        ['actionTypes/com.example.twin.create-engagement', 'actions/com.example.twin.create-engagement/apply'],
      ],
      [['history', 'com.example.twin.Account'], editsHistory, ['objectTypes/com.example.twin.Account/editsHistory']],
    ];

    for (const [args, handler, routes] of cases) {
      const fetch = stubFetch(stubConfig, handler);

      const run = await cli([...args, '--app', 'twin', '--url', STUB], {
        cwd: tempFolder(),
        fetch,
        env: { ONTOLOGY_TOKEN: 't' },
      });

      expect(run.error).toBeUndefined();
      expect(run.code).toBe(0);

      expect(fetch.calls.map(({ url }) => new URL(url).pathname).sort()).toEqual(
        [
          '/api/ontology-service/v1/client-config',
          '/api/v2/ontologies',
          ...routes.map((route) => `/api/v2/ontologies/${rid}/${route}`),
        ].sort(),
      );
    }
  });
});

describe('the token of a call', () => {
  it('service/cli#sign-in: with ONTOLOGY_TOKEN, the CLI sends that token, and skips the stored token and the GitHub request', async () => {
    const tokens = tempFolder({ 'twin/staging': 'stored-refresh' });
    const fetch = stubFetch(stubConfig, replay(stubExchange('client', 1), stubExchange('client', 2)));

    const env = {
      ONTOLOGY_TOKEN: 'fixed-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.stub/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
    };

    const run = await cli(
      [
        'objects',
        'com.example.twin.Account',
        '--page-size',
        '2',
        '--order-by',
        '{"name":"asc"}',
        '--app',
        'twin',
        '--url',
        STUB,
      ],
      {
        fetch,
        env,
        tokens,
      },
    );

    expect(run.code).toBe(0);
    expect(fetch.calls.map(({ url }) => new URL(url).origin)).toEqual([STUB, STUB, STUB, STUB]);

    expect(fetch.calls.slice(1).map(({ headers }) => headers['authorization'])).toEqual([
      'Bearer fixed-token',
      'Bearer fixed-token',
      'Bearer fixed-token',
    ]);

    expect(readFileSync(join(tokens, 'twin/staging'), 'utf8')).toBe('stored-refresh');
  });
});
