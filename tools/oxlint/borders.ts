import type { DummyRuleMap, OxlintConfig } from 'oxlint';

type RestrictedImports = Extract<NonNullable<NonNullable<OxlintConfig['rules']>['no-restricted-imports']>, unknown[]>;

type ImportOptions = Extract<RestrictedImports[1], { paths?: unknown }>;

type Path = NonNullable<ImportOptions['paths']>[number];

type Pattern = NonNullable<ImportOptions['patterns']>[number];

const src = 'packages/service/src';
const api = 'packages/service/api';
const tests = ['**/*.test.ts', '**/*.test-utils.ts', '**/*.fixture.ts'];

export const runtimeImports: Readonly<Record<string, readonly string[]>> = {
  handler: ['auth', 'errors', 'ontology', 'objectSets', 'actions', 'publish', 'mcp', 'db', 'spans'],
  mcp: ['errors', 'valueTypes'],
  auth: ['errors', 'spans'],
  ontology: ['errors', 'db', 'spans', 'decimal', 'valueTypes'],
  publish: ['errors', 'db', 'ontology', 'spans', 'valueTypes'],
  objectSets: ['errors', 'db', 'ontology'],
  actions: ['errors', 'db', 'functions', 'spans', 'decimal', 'valueTypes'],
  functions: ['errors', 'db', 'spans'],
  db: ['errors', 'spans', 'decimal'],
  spans: ['errors'],
  errors: [],
  decimal: ['errors'],
  valueTypes: ['decimal', 'errors'],
  adapter: ['handler', 'db', 'errors'],
};

const trustedImport = {
  regex: 'handler/index\\.ts$',
  importNames: ['handleTrusted'],
  message: 'Only the handler serves handleTrusted. The functions module gets it from ctx, and an adapter calls handle.',
};

const testingImport = {
  regex: '(^|/)testing(/|$)',
  message: 'The service code never imports the test helpers of testing/. Only the test entry swaps the token issuers.',
};

export const bigImport = {
  regex: '^big\\.js(/|$)',
  message: 'Only src/decimal/index.ts imports big.js. Call parseDecimal or compareDecimal.',
};

const bigImportAllowed: Pattern[] = [];

const compileImport = {
  regex: 'ontology/index\\.ts$',
  importNames: ['compileOntology'],
  allowTypeImports: true,
  message:
    'The handler reads the Ontology only through openOntology, which gives the view of the permissions of the caller.',
};

const packageRules = {
  pg: { name: 'pg', message: 'Only the db module imports pg.' },
  pgQueryStream: { name: 'pg-query-stream', message: 'Only the db module imports pg-query-stream.' },
  vercel: { name: '@vercel/functions', message: 'Only the Vercel adapter in api/ imports @vercel/functions.' },
  sentry: { name: '@sentry/node', message: 'Only the Vercel adapter in api/ imports @sentry/node.' },
  posthog: { name: 'posthog-node', message: 'Only the Vercel adapter in api/ imports posthog-node.' },
  client: {
    name: '@osdk/client',
    allowTypeImports: true,
    message: 'The Ontology service has no @osdk/client dependency at run time. Import its types only.',
  },
  faux: {
    name: '@osdk/faux',
    message: 'The Ontology service reuses no faux code. The compiled Ontology replaces FauxOntology.',
  },
  unstable: {
    name: '@osdk/client.unstable',
    message:
      'Only the ontology and publish modules import @osdk/client.unstable. The routes read the compiled Ontology, never the IR.',
  },
  pure: {
    regex: '^(pg|pg-query-stream)(/.*)?$',
    message: 'A pure file takes data and returns data or SQL. It does no input or output.',
  },
  pureNode: {
    regex:
      '^(node:)?(fs|net|http|https|http2|child_process|tls|dgram|dns|module|worker_threads|sqlite|inspector|cluster|readline|process)(/.*)?$',
    message: 'A pure file takes data and returns data or SQL. It does no input or output.',
  },
  otelApi: { regex: '^@opentelemetry/api(/.*)?$', message: 'Only the spans module imports @opentelemetry/api.' },
  otelSdk: {
    regex: '^@opentelemetry/($|[^a]|a([^p]|$)|ap([^i]|$)|api[^/])',
    message: 'Only the Vercel adapter in api/_tracing.ts imports the OpenTelemetry SDK and the exporters.',
  },
  pureSpans: {
    regex: '(^|/)spans/index\\.ts$',
    allowTypeImports: true,
    message: 'A pure file imports no value of spans. Its caller adds the span.',
  },
  pureDb: {
    regex: '(^|/)db/index\\.ts$',
    importNames: ['createPool', 'createDb', 'applyEngineChanges', 'openReader'],
    message: 'A pure file takes data and returns data or SQL. It does no input or output.',
  },
};

const apiPackages = [packageRules.pg, packageRules.pgQueryStream, packageRules.client, packageRules.unstable];

const servicePackages = [
  packageRules.pg,
  packageRules.pgQueryStream,
  packageRules.vercel,
  packageRules.sentry,
  packageRules.posthog,
  packageRules.client,
  packageRules.faux,
  packageRules.unstable,
];

const imports = (paths: Path[], patterns: Pattern[] = [], bigImports: Pattern[] = [bigImport]): RestrictedImports => [
  'error',
  { paths, patterns: [trustedImport, testingImport, ...bigImports, ...patterns] },
];

const srcImports = (paths: Path[], patterns: Pattern[] = []) =>
  imports(paths, [...patterns, packageRules.otelApi, packageRules.otelSdk]);

const handleTrusted = {
  property: 'handleTrusted',
  message: 'Only the functions module uses ctx.handleTrusted, for the Functions bridge.',
};

const getBuiltinModule = {
  property: 'getBuiltinModule',
  message: 'A pure file takes data and returns data or SQL. It does no input or output.',
};

const pureRules = (paths: Path[], bigImports?: Pattern[]): DummyRuleMap => ({
  'no-restricted-imports': imports(
    paths,
    [
      packageRules.pure,
      packageRules.pureNode,
      packageRules.pureDb,
      packageRules.pureSpans,
      packageRules.otelApi,
      packageRules.otelSdk,
    ],
    bigImports,
  ),
  'no-restricted-properties': ['error', handleTrusted, getBuiltinModule],
});

const fallibleRules: DummyRuleMap = Object.fromEntries(
  ['no-throw', 'no-catch', 'return-yield', 'no-dropped-call', 'no-yield-in-finally', 'no-bridge-import'].map((rule) => [
    `fallible/${rule}`,
    'error',
  ]),
);

const pureCommon = [
  packageRules.vercel,
  packageRules.sentry,
  packageRules.posthog,
  packageRules.client,
  packageRules.faux,
];

const pureWithoutUnstable = [...pureCommon, packageRules.unstable];

export const borderOverrides: NonNullable<OxlintConfig['overrides']> = [
  {
    files: [`${src}/**/*.ts`, `${api}/**/*.ts`],
    excludeFiles: tests,
    rules: { 'local/module-border': ['error', runtimeImports], 'no-restricted-imports': imports([]) },
  },
  {
    files: [`${src}/**/*.ts`],
    excludeFiles: [`${src}/db/**`, ...tests],
    rules: { 'no-restricted-imports': srcImports(servicePackages) },
  },
  {
    files: [`${src}/spans/**/*.ts`],
    excludeFiles: tests,
    rules: { 'no-restricted-imports': imports(servicePackages, [packageRules.otelSdk]) },
  },
  {
    files: [`${src}/handler/**/*.ts`],
    excludeFiles: tests,
    rules: { 'no-restricted-imports': srcImports(servicePackages, [compileImport]) },
  },
  {
    files: [`${src}/ontology/**/*.ts`, `${src}/publish/**/*.ts`],
    excludeFiles: [`${src}/ontology/routes.ts`, ...tests],
    rules: {
      'no-restricted-imports': srcImports([packageRules.pg, packageRules.pgQueryStream, ...pureCommon]),
    },
  },
  {
    files: [`${src}/**/*.ts`],
    excludeFiles: [`${src}/functions/**`, `${src}/handler/**`, ...tests],
    rules: { 'no-restricted-properties': ['error', handleTrusted] },
  },
  {
    files: [`${src}/errors/**/*.ts`],
    excludeFiles: tests,
    rules: pureRules(pureWithoutUnstable),
  },
  {
    files: [`${src}/publish/**/*.ts`],
    excludeFiles: [
      ...['columnLimit', 'index', 'publishOntology', 'remapEntry', 'schemaMigrations', 'upgrade', 'versions'].map(
        (f) => `${src}/publish/${f}.ts`,
      ),
      ...tests,
    ],
    rules: pureRules(pureCommon),
  },
  {
    files: [`${src}/objectSets/compile/**/*.ts`],
    excludeFiles: tests,
    rules: pureRules(pureWithoutUnstable),
  },
  {
    files: [`${src}/actions/pure/**/*.ts`],
    excludeFiles: tests,
    rules: pureRules(pureWithoutUnstable),
  },
  {
    files: [`${src}/ontology/**/*.ts`],
    excludeFiles: [`${src}/ontology/index.ts`, `${src}/ontology/routes.ts`, ...tests],
    rules: pureRules(pureCommon),
  },
  {
    files: [`${src}/db/**/*.ts`],
    excludeFiles: tests,
    rules: { 'no-restricted-imports': srcImports(pureWithoutUnstable) },
  },
  {
    files: [`${src}/decimal/index.ts`],
    rules: pureRules(pureWithoutUnstable, bigImportAllowed),
  },
  { files: [`${api}/**/*.ts`], rules: { 'no-restricted-imports': imports(apiPackages) } },
  {
    files: [`${api}/**/*.ts`],
    excludeFiles: [`${api}/_tracing.ts`],
    rules: { 'no-restricted-imports': imports(apiPackages, [packageRules.otelApi, packageRules.otelSdk]) },
  },
  {
    files: ['packages/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^@ericbragas/ontos-service($|/($|[^c]|c([^o]|$)|co([^n]|$)|con([^v]|$)|conv([^e]|$)|conve([^r]|$)|conver([^t]|$)|convert.))',
              allowTypeImports: true,
              message: 'The CLI imports the types of the Ontology service with import type only.',
            },
            { regex: '^(\\.\\./)+service/', message: 'The CLI imports no file of packages/service.' },
            bigImport,
          ],
        },
      ],
    },
  },
  {
    files: [`${src}/**/*.ts`, `${api}/**/*.ts`, 'packages/cli/src/**/*.ts'],
    excludeFiles: tests,
    rules: { 'local/static-import': 'error' },
  },
  { files: [`${src}/functions/worker.ts`], rules: { 'local/static-import': ['error', { base64Module: true }] } },
  {
    files: [`${src}/handler/routes.ts`],
    rules: { 'local/static-import': ['error', { allow: ['../mcp/index.ts', '../publish/index.ts'] }] },
  },
  {
    files: [
      'packages/cli/src/functions/discover.ts',
      'packages/cli/src/sdk/generate.ts',
      'packages/cli/src/sdk/domain.ts',
    ],
    rules: { 'local/static-import': ['error', { allow: ['typescript'] }] },
  },
  {
    files: ['packages/cli/src/functions/bundle.ts'],
    rules: { 'local/static-import': ['error', { allow: ['esbuild'] }] },
  },
  {
    files: ['packages/cli/src/commands/dev.ts'],
    rules: {
      'local/static-import': ['error', { allow: ['@ericbragas/ontos-service'], fileUrl: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(\\.\\./)+service/', message: 'The CLI imports no file of packages/service.' },
            bigImport,
          ],
        },
      ],
    },
  },
  {
    files: [`${src}/**/*.ts`, `${api}/**/*.ts`],
    excludeFiles: [`${src}/db/**`, ...tests],
    rules: { 'local/no-snapshot-cast': 'error' },
  },
  {
    files: [...tests.map((test) => `packages/*/src/${test}`), 'packages/service/twin/**/*.ts'],
    excludeFiles: ['packages/service/src/service.test-utils.ts'],
    rules: { 'local/no-snapshot-cast': 'error' },
  },
  {
    files: [
      `${src}/**/*.ts`,
      `${api}/**/*.ts`,
      'packages/service/testing/**/*.ts',
      'packages/cli/src/**/*.ts',
      'tools/fallible/**/*.ts',
      'tools/packaging/**/*.ts',
      'tools/ops/**/*.ts',
      'tools/docs/**/*.ts',
    ],
    excludeFiles: [...tests, `${src}/functions/worker.ts`],
    rules: fallibleRules,
  },
  {
    files: [`${src}/errors/fallible.ts`],
    rules: {
      'fallible/no-throw': 'off',
      'fallible/no-catch': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^(\\.\\./|[^.]|\\./($|[^f]|f([^a]|$)|fa([^l]|$)|fal([^l]|$)|fall([^i]|$)|falli([^b]|$)|fallib([^l]|$)|fallibl([^e]|$)|fallible[^/]))',
              message: 'The helper of yielded failures imports only its own fallible/ files.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [`${src}/errors/fallible/**/*.ts`],
    rules: {
      'fallible/no-throw': 'off',
      'fallible/no-catch': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\./|[^.])',
              message: 'The helper of yielded failures imports only sibling files inside errors/fallible/.',
            },
          ],
        },
      ],
    },
  },
];
