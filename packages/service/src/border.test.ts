import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PermittedCaller, PersonCaller } from './auth/index.ts';
import type { Ctx } from './handler/index.ts';
import * as ontologyIndex from './ontology/index.ts';
import type { PersonFact } from './ontology/index.ts';
import * as publishConvert from './publish/convert.ts';
import { runtimeImports } from '../../../oxlint.config.ts';
import { lintProbe } from './lintProbe.test-utils.ts';

const lintText = lintProbe();

const borderRules = new Set([
  'local/module-border',
  'no-restricted-imports',
  'local/static-import',
  'local/no-snapshot-cast',
  'no-restricted-properties',
]);

async function errors(file: string, code: string): Promise<string[]> {
  return (await lintText(file, code)).filter((f) => borderRules.has(f.rule)).map((f) => f.message);
}

const svc = 'packages/service';

const allFiles = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts'))
    .map((path) => join(folder, path));

const files = (folder: string): string[] =>
  allFiles(folder).filter((path) => !/\.(test|test-utils|fixture)\.ts$/.test(path));

describe('module paths', () => {
  it('allows the index.ts of another module', async () => {
    expect(
      await errors(
        `${svc}/src/actions/x.ts`,
        "import { createDb } from '../db/index.ts';\nexport const a = createDb;\n",
      ),
    ).toEqual([]);
  });

  it('refuses a file inside another module', async () => {
    expect(
      await errors(
        `${svc}/src/actions/x.ts`,
        "import type { Ctx } from '../handler/context.ts';\nexport type A = Ctx;\n",
      ),
    ).toHaveLength(1);

    expect(
      await errors(
        `${svc}/src/ontology/x.ts`,
        "import { UserId } from '../auth/caller.ts';\nexport const a = UserId.parse('x');\n",
      ),
    ).toHaveLength(1);
  });

  it('resolves each path, so ./../, .././, and // reach the same file', async () => {
    for (const path of ['./../db/engineChanges.ts', '.././db/engineChanges.ts', '../db//engineChanges.ts']) {
      const code = `import { engineChanges } from '${path}';\nexport const a = engineChanges;\n`;

      expect(await errors(`${svc}/src/actions/x.ts`, code)).toHaveLength(1);
    }
  });

  it('refuses an import of an adapter from a module', async () => {
    expect(
      await errors(`${svc}/src/handler/x.ts`, "import { listen } from '../node.ts';\nexport const a = listen;\n"),
    ).toHaveLength(1);
  });

  it('allows the index.ts of another module from a nested folder, and a file of the same module', async () => {
    const code =
      "import { quoteName } from '../../db/index.ts';\nimport { b } from '../b.ts';\nexport const a = [quoteName, b];\n";

    expect(await errors(`${svc}/src/objectSets/compile/x.ts`, code)).toEqual([]);
  });

  it('refuses a file inside another module from a nested folder', async () => {
    const code = "import { engineChanges } from '../../db/engineChanges.ts';\nexport const a = engineChanges;\n";

    expect(await errors(`${svc}/src/objectSets/compile/x.ts`, code)).toHaveLength(1);
  });

  it('refuses a dynamic import', async () => {
    expect(await errors(`${svc}/src/actions/x.ts`, "export const a = () => import('../db/index.ts');\n")).toHaveLength(
      1,
    );
  });

  it('allows a dynamic import only in the worker script of the functions module, which imports the text of a Function bundle', async () => {
    const code = 'export const a = (text: string) => import(`data:text/javascript;base64,${text}`);\n';

    expect(await errors(`${svc}/src/functions/worker.ts`, code)).toEqual([]);

    expect(await errors(`${svc}/src/functions/pool.ts`, code)).toHaveLength(1);

    expect(
      await errors(`${svc}/src/functions/worker.ts`, "export const a = () => import('../db/index.ts');\n"),
    ).toHaveLength(1);

    expect(
      await errors(`${svc}/src/functions/worker.ts`, 'export const a = (text: string) => import(`${text}`);\n'),
    ).toHaveLength(1);

    expect(
      await errors(`${svc}/src/functions/worker.ts`, 'export const a = (db: unknown) => db as SnapshotDb;\n'),
    ).toHaveLength(1);
  });

  it('allows dynamic import in handler/routes.ts only for the mcp and publish module entries', async () => {
    expect(
      await errors(
        `${svc}/src/handler/routes.ts`,
        "export const a = () => import('../mcp/index.ts');\nexport const b = () => import('../publish/index.ts');\n",
      ),
    ).toEqual([]);

    expect(
      await errors(`${svc}/src/handler/routes.ts`, "export const a = () => import('../db/index.ts');\n"),
    ).toHaveLength(1);

    expect(
      await errors(`${svc}/src/handler/routes.ts`, "export const a = () => import('../mcp/server.ts');\n"),
    ).toHaveLength(2);

    expect(await errors(`${svc}/src/handler/routes.ts`, 'export const a = (p: string) => import(p);\n')).toHaveLength(
      1,
    );

    expect(
      await errors(`${svc}/src/handler/index.ts`, "export const a = () => import('../mcp/index.ts');\n"),
    ).toHaveLength(1);
  });
});

describe('the test entry', () => {
  it('service/authentication#tokens: no file of src/ or api/, the 2 adapters included, imports the test helpers of testing/', async () => {
    const probes: [string, string][] = [
      [`${svc}/src/node.ts`, './../testing/index.ts'],
      [`${svc}/api/index.ts`, '../testing/tokens.ts'],
      [`${svc}/src/auth/x.ts`, '../../testing/workos.ts'],
      [`${svc}/src/handler/x.ts`, '@ericbragas/ontos-service/testing'],
    ];

    for (const [file, path] of probes) {
      const refused = [expect.stringContaining('The service code never imports the test helpers of testing/.')];

      expect([file, await errors(file, `import { x } from '${path}';\nexport const a = x;\n`)]).toEqual([
        file,
        refused,
      ]);

      expect([file, await errors(file, `import type { X } from '${path}';\nexport type A = X;\n`)]).toEqual([
        file,
        refused,
      ]);
    }
  });
});

describe('module direction', () => {
  it('refuses a value import from a module that Code layout does not list', async () => {
    const intoActions = "import { applyAction } from '../actions/index.ts';\nexport const a = applyAction;\n";
    const intoHandler = "import { handle } from '../handler/index.ts';\nexport const a = handle;\n";

    expect(await errors(`${svc}/src/objectSets/x.ts`, intoActions)).toHaveLength(1);

    expect(await errors(`${svc}/src/db/x.ts`, intoHandler)).toHaveLength(1);

    expect(
      await errors(
        `${svc}/src/errors/x.ts`,
        "import { quoteName } from '../db/index.ts';\nexport const a = quoteName;\n",
      ),
    ).toHaveLength(1);

    expect(
      await errors(
        `${svc}/src/node.ts`,
        "import { applyAction } from './actions/index.ts';\nexport const a = applyAction;\n",
      ),
    ).toHaveLength(1);
  });

  it('refuses a value re-export from a module that Code layout does not list', async () => {
    expect(
      await errors(`${svc}/src/objectSets/x.ts`, "export { applyAction } from '../actions/index.ts';\n"),
    ).toHaveLength(1);
  });

  it('allows a type import and a type re-export from any module', async () => {
    const code =
      "import type { Ctx } from '../handler/index.ts';\nimport { type Edit } from '../actions/index.ts';\nexport type * from '../publish/index.ts';\nexport type A = [Ctx, Edit];\n";

    expect(await errors(`${svc}/src/objectSets/x.ts`, code)).toEqual([]);
  });

  it('allows each listed value import', async () => {
    const code = "import { runFunction } from '../functions/index.ts';\nexport const a = runFunction;\n";

    expect(await errors(`${svc}/src/actions/x.ts`, code)).toEqual([]);
  });
});

describe('the ontology and publish modules', () => {
  it('service/code-layout#modules: ontology, which opens the view of 1 Ontology, imports values only from errors, db, decimal, and spans', async () => {
    for (const module of ['errors', 'db', 'decimal']) {
      expect(
        await errors(`${svc}/src/ontology/x.ts`, `import { x } from '../${module}/index.ts';\nexport const a = x;\n`),
      ).toEqual([]);
    }

    expect(
      await errors(`${svc}/src/ontology/index.ts`, "import { x } from '../spans/index.ts';\nexport const a = x;\n"),
    ).toEqual([]);

    for (const module of ['auth', 'handler', 'publish', 'objectSets', 'actions', 'functions', 'mcp']) {
      expect(
        await errors(`${svc}/src/ontology/x.ts`, `import { x } from '../${module}/index.ts';\nexport const a = x;\n`),
      ).toHaveLength(1);
    }

    expect(
      await errors(
        `${svc}/src/ontology/x.ts`,
        "import type { Caller } from '../auth/index.ts';\nimport type { OrganizationCtx } from '../handler/index.ts';\nexport type A = [Caller, OrganizationCtx];\n",
      ),
    ).toEqual([]);
  });

  it('service/code-layout#modules: publish, which holds the publish route and the install route, imports values only from errors, db, ontology, and spans', async () => {
    for (const module of ['errors', 'db', 'ontology']) {
      expect(
        await errors(`${svc}/src/publish/x.ts`, `import { x } from '../${module}/index.ts';\nexport const a = x;\n`),
      ).toEqual([]);
    }

    expect(
      await errors(`${svc}/src/publish/versions.ts`, "import { x } from '../spans/index.ts';\nexport const a = x;\n"),
    ).toEqual([]);

    for (const module of ['auth', 'handler', 'objectSets', 'actions', 'functions', 'mcp']) {
      expect(
        await errors(`${svc}/src/publish/x.ts`, `import { x } from '../${module}/index.ts';\nexport const a = x;\n`),
      ).toHaveLength(1);
    }
  });

  it('service/code-layout#modules: the files of publish, the plan of the WorkOS steps included, import values from outside publish only from errors, db, ontology, spans, and valueTypes, never from decimal', () => {
    const publishRoot = resolve(`${svc}/src/publish`);

    const imports = files(`${svc}/src/publish`).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^;]*? from '([^']+)';/gm)]
        .map((match) => match[1] ?? '')
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => resolve(dirname(file), specifier))
        .filter((target) => relative(publishRoot, target).startsWith('..'))
        .map((target) => relative(publishRoot, target).replaceAll('\\', '/')),
    );

    expect([...new Set(imports)].sort()).toEqual([
      '../db/index.ts',
      '../errors/index.ts',
      '../ontology/index.ts',
      '../spans/index.ts',
      '../valueTypes/index.ts',
    ]);
  });
});

describe('the port of the WorkOS writes of publish', () => {
  it('service/code-layout#seams: the publish module owns the port type, and the auth module implements it with a type import, so no border changes', async () => {
    expect(
      await errors(
        `${svc}/src/auth/workosPublish.ts`,
        "import type { WorkosPort } from '../publish/index.ts';\nexport type A = WorkosPort;\n",
      ),
    ).toEqual([]);

    expect(
      await errors(
        `${svc}/src/auth/workosPublish.ts`,
        "import { publish } from '../publish/index.ts';\nexport const a = publish;\n",
      ),
    ).toHaveLength(1);

    const implementation = readFileSync(`${svc}/src/auth/workosPublish.ts`, 'utf8');

    expect(implementation.match(/^import type \{ [^}]+ \} from '\.\.\/publish\/index\.ts';$/m)?.[0]).toBe(
      "import type { RoleSlug, WorkosPort, WorkosRoles, WorkosStep } from '../publish/index.ts';",
    );

    expect(implementation).toContain(
      'export function workosPublish(apiKey: string, options: { readonly fetch?: typeof globalThis.fetch } = {}): WorkosPort {',
    );

    expect(readFileSync(`${svc}/src/publish/index.ts`, 'utf8')).toContain(
      "export type { RoleSlug, WorkosPort, WorkosRoles, WorkosStep } from './workosSteps.ts';",
    );

    expect(readFileSync(`${svc}/src/auth/index.ts`, 'utf8')).toContain(
      "export { workosPublish } from './workosPublish.ts';",
    );
  });
});

describe('the auth module', () => {
  it('service/code-layout#modules: auth, which holds the 1 WorkOS client with its kept answers, imports values only from errors and spans', async () => {
    for (const module of ['errors', 'spans']) {
      expect(
        await errors(`${svc}/src/auth/kept.ts`, `import { x } from '../${module}/index.ts';\nexport const a = x;\n`),
      ).toEqual([]);
    }

    for (const module of ['handler', 'ontology', 'publish', 'objectSets', 'actions', 'functions', 'mcp', 'db']) {
      expect(
        await errors(`${svc}/src/auth/kept.ts`, `import { x } from '../${module}/index.ts';\nexport const a = x;\n`),
      ).toHaveLength(1);
    }
  });

  it('service/code-layout#modules: the files of auth that a deployment runs import values from outside auth only from errors, spans, jose, node:crypto, and zod', () => {
    const authRoot = resolve(`${svc}/src/auth`);

    const imports = files(`${svc}/src/auth`).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^;]*? from '([^']+)';/gm)]
        .map((match) => match[1] ?? '')
        .flatMap((specifier) => {
          if (!specifier.startsWith('.')) return [specifier];

          const target = relative(authRoot, resolve(dirname(file), specifier)).replaceAll('\\', '/');

          return target.startsWith('..') ? [target] : [];
        }),
    );

    expect([...new Set(imports)].sort()).toEqual([
      '../errors/index.ts',
      '../spans/index.ts',
      'jose',
      'node:crypto',
      'zod',
    ]);
  });
});

describe('the mcp module', () => {
  it('service/code-layout#modules: the handler may import a value from mcp', async () => {
    expect(
      await errors(`${svc}/src/handler/x.ts`, "import { mcp } from '../mcp/index.ts';\nexport const a = mcp;\n"),
    ).toEqual([]);
  });

  it('service/code-layout#modules/282f5190 service/code-layout#modules/26236b9d: mcp imports values only from errors and valueTypes, so it reads the compiled Ontology only through the type of ctx', async () => {
    expect(
      await errors(
        `${svc}/src/mcp/x.ts`,
        "import { ApiError } from '../errors/index.ts';\nexport const a = ApiError;\n",
      ),
    ).toEqual([]);

    expect(
      await errors(
        `${svc}/src/mcp/x.ts`,
        "import { constraintText } from '../valueTypes/index.ts';\nexport const a = constraintText;\n",
      ),
    ).toEqual([]);

    for (const module of ['ontology', 'objectSets', 'actions', 'db', 'auth', 'publish', 'functions', 'handler']) {
      const code = `import { x } from '../${module}/index.ts';\nexport const a = x;\n`;

      expect(await errors(`${svc}/src/mcp/x.ts`, code)).toEqual([
        `The mcp module may not import a value from ${module}. Use import type, or change runtimeImports in oxlint.config.ts.`,
      ]);
    }

    const types =
      "import type { Ctx } from '../handler/index.ts';\nimport type { Db } from '../db/index.ts';\nexport type A = [Ctx, Db];\n";

    expect(await errors(`${svc}/src/mcp/x.ts`, types)).toEqual([]);
  });

  it('service/code-layout#modules: no other module but the handler imports a value from mcp', async () => {
    for (const module of ['auth', 'ontology', 'publish', 'objectSets', 'actions', 'functions', 'db', 'errors']) {
      expect(
        await errors(`${svc}/src/${module}/x.ts`, "import { mcp } from '../mcp/index.ts';\nexport const a = mcp;\n"),
      ).toHaveLength(1);
    }

    expect(
      await errors(`${svc}/src/node.ts`, "import { mcp } from './mcp/index.ts';\nexport const a = mcp;\n"),
    ).toHaveLength(1);
  });

  it('service/code-layout#libraries: only the mcp module imports @modelcontextprotocol/server, and the service depends on it', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const sdk = /from '@modelcontextprotocol\/server'/;

    const importers = [...files(join(root, 'src')), ...files(join(root, 'api'))]
      .filter((file) => sdk.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length));

    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !file.startsWith('src/mcp/'))).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('2.4.0');
  });
});

describe('the decimal module', () => {
  const bigJs = "import big from 'big.js';\nexport const a = big;\n";
  const message = 'Only src/decimal/index.ts imports big.js. Call parseDecimal or compareDecimal.';

  it('service/code-layout#modules: an import of big.js in any file other than src/decimal/index.ts fails lint with a message that names parseDecimal and compareDecimal', async () => {
    const others = [
      `${svc}/src/actions/pure/x.ts`,
      `${svc}/src/actions/x.ts`,
      `${svc}/src/db/x.ts`,
      `${svc}/src/ontology/x.ts`,
      `${svc}/src/objectSets/compile/x.ts`,
      `${svc}/src/errors/x.ts`,
      `${svc}/src/spans/x.ts`,
      `${svc}/src/handler/x.ts`,
      `${svc}/src/node.ts`,
      `${svc}/src/decimal/x.ts`,
      `${svc}/src/decimal/index.test.ts`,
      `${svc}/api/index.ts`,
      `${svc}/api/_tracing.ts`,
      `${svc}/twin/x.ts`,
      'packages/cli/src/x.ts',
      'tools/x.ts',
    ];

    for (const file of others)
      expect({ file, errors: await errors(file, bigJs) }).toEqual({ file, errors: [expect.stringContaining(message)] });

    expect(await errors(`${svc}/src/actions/x.ts`, "import { Big } from 'big.js';\nexport const a = Big;\n")).toEqual([
      expect.stringContaining(message),
    ]);

    for (const entry of ['big.js/big.mjs', 'big.js/big']) {
      expect(await errors(`${svc}/src/actions/x.ts`, `import big from '${entry}';\nexport const a = big;\n`)).toEqual([
        expect.stringContaining(message),
      ]);
    }

    expect(await errors(`${svc}/src/decimal/index.ts`, bigJs)).toEqual([]);
  });

  it('service/code-layout#modules: decimal is pure, and imports a value only from errors', async () => {
    const io = "import * as fs from 'node:fs';\nimport pg from 'pg';\nexport const a = [fs, pg];\n";

    expect(await errors(`${svc}/src/decimal/index.ts`, io)).toHaveLength(2);

    expect(
      await errors(
        `${svc}/src/decimal/index.ts`,
        "import { invariant } from '../errors/index.ts';\nexport const a = invariant;\n",
      ),
    ).toEqual([]);

    for (const module of ['db', 'spans']) {
      expect(
        await errors(
          `${svc}/src/decimal/index.ts`,
          `import { x } from '../${module}/index.ts';\nexport const a = x;\n`,
        ),
      ).toContain(
        `The decimal module may not import a value from ${module}. Use import type, or change runtimeImports in oxlint.config.ts.`,
      );
    }
  });

  it('service/code-layout#modules: only db, actions, ontology, and valueTypes import values from decimal', async () => {
    const code = "import { parseDecimal } from '../decimal/index.ts';\nexport const a = parseDecimal;\n";

    for (const module of ['db', 'actions', 'ontology', 'valueTypes'])
      expect(await errors(`${svc}/src/${module}/x.ts`, code)).toEqual([]);

    for (const module of ['handler', 'mcp', 'auth', 'publish', 'objectSets', 'functions', 'spans', 'errors']) {
      expect(await errors(`${svc}/src/${module}/x.ts`, code)).toHaveLength(1);
    }
  });
});

describe('the valueTypes module', () => {
  it('service/code-layout#modules: valueTypes imports values only from decimal and errors, and a forbidden import fails lint', async () => {
    expect(
      await errors(
        `${svc}/src/valueTypes/index.ts`,
        "import { parseDecimal } from '../decimal/index.ts';\nexport const a = parseDecimal;\n",
      ),
    ).toEqual([]);

    expect(
      await errors(
        `${svc}/src/valueTypes/index.ts`,
        "import { caught } from '../errors/index.ts';\nexport const a = caught;\n",
      ),
    ).toEqual([]);

    for (const module of [
      'db',
      'spans',
      'ontology',
      'actions',
      'publish',
      'mcp',
      'auth',
      'handler',
      'objectSets',
      'functions',
    ]) {
      expect(
        await errors(
          `${svc}/src/valueTypes/index.ts`,
          `import { x } from '../${module}/index.ts';\nexport const a = x;\n`,
        ),
      ).toEqual([
        `The valueTypes module may not import a value from ${module}. Use import type, or change runtimeImports in oxlint.config.ts.`,
      ]);
    }

    expect(
      await errors(
        `${svc}/src/valueTypes/index.ts`,
        "import type { CompiledValueType } from '../ontology/index.ts';\nexport type A = CompiledValueType;\n",
      ),
    ).toEqual([]);
  });

  it('service/code-layout#modules: actions, publish, ontology, and mcp may import a value from valueTypes', async () => {
    const code = "import { valueTypeCheck } from '../valueTypes/index.ts';\nexport const a = valueTypeCheck;\n";

    for (const module of ['actions', 'publish', 'ontology', 'mcp'])
      expect(await errors(`${svc}/src/${module}/x.ts`, code)).toEqual([]);

    for (const module of ['handler', 'auth', 'objectSets', 'functions', 'db', 'spans', 'errors', 'decimal']) {
      expect(await errors(`${svc}/src/${module}/x.ts`, code)).toHaveLength(1);
    }

    expect(
      await errors(
        `${svc}/src/node.ts`,
        "import { valueTypeCheck } from './valueTypes/index.ts';\nexport const a = valueTypeCheck;\n",
      ),
    ).toHaveLength(1);
  });

  it('service/code-layout#modules: a file inside valueTypes is private to the module', async () => {
    expect(
      await errors(`${svc}/src/actions/x.ts`, "import { x } from '../valueTypes/words.ts';\nexport const a = x;\n"),
    ).toHaveLength(1);
  });
});

describe('the @sentry/node border', () => {
  const code = "import * as Sentry from '@sentry/node';\nexport const a = Sentry;\n";

  const refused =
    "'@sentry/node' import is restricted from being used. Only the Vercel adapter in api/ imports @sentry/node.";

  it('service/code-layout#http-entry: lets only the Vercel adapter import @sentry/node', async () => {
    const modules = readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(modules.length).toBeGreaterThan(0);

    for (const name of modules) expect(await errors(`${svc}/src/${name}/x.ts`, code)).toEqual([refused]);

    expect(await errors(`${svc}/src/node.ts`, code)).toEqual([refused]);

    expect(await errors(`${svc}/api/index.ts`, code)).toEqual([]);
  });
});

describe('the posthog-node border', () => {
  const code = "import { PostHog } from 'posthog-node';\nexport const a = PostHog;\n";

  const refused =
    "'posthog-node' import is restricted from being used. Only the Vercel adapter in api/ imports posthog-node.";

  it('service/code-layout#http-entry: lets only the Vercel adapter import posthog-node', async () => {
    const modules = readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(modules.length).toBeGreaterThan(0);

    for (const name of modules) expect(await errors(`${svc}/src/${name}/x.ts`, code)).toEqual([refused]);

    expect(await errors(`${svc}/src/node.ts`, code)).toEqual([refused]);

    expect(await errors(`${svc}/api/index.ts`, code)).toEqual([]);
  });
});

describe('handleTrusted', () => {
  it('refuses the import of handleTrusted in a module and in each adapter', async () => {
    const module = "import { handleTrusted } from '../handler/index.ts';\nexport const a = handleTrusted;\n";
    const node = "import { handleTrusted } from './handler/index.ts';\nexport const a = handleTrusted;\n";
    const vercel = "import { handleTrusted } from '../src/handler/index.ts';\nexport const a = handleTrusted;\n";

    expect(await errors(`${svc}/src/functions/x.ts`, module)).toEqual(
      expect.arrayContaining([expect.stringContaining('handleTrusted')]),
    );

    expect(await errors(`${svc}/src/node.ts`, node)).toHaveLength(1);

    expect(await errors(`${svc}/api/index.ts`, vercel)).toHaveLength(1);
  });

  it('refuses ctx.handleTrusted outside the functions module, also by destructuring', async () => {
    const member = 'export const a = (ctx: { handleTrusted: unknown }) => ctx.handleTrusted;\n';
    const destructure = 'export const a = ({ handleTrusted }: { handleTrusted: unknown }) => handleTrusted;\n';

    expect(await errors(`${svc}/src/actions/x.ts`, member)).toHaveLength(1);

    expect(await errors(`${svc}/src/objectSets/x.ts`, destructure)).toHaveLength(1);

    expect(await errors(`${svc}/src/functions/x.ts`, member)).toEqual([]);
  });
});

describe('the view of a set of permissions', () => {
  it('service/code-layout#seams: refuses a value import of compileOntology in the handler, allows the type import, and allows the value import in publish', async () => {
    const value = "import { compileOntology } from '../ontology/index.ts';\nexport const a = compileOntology;\n";
    const type = "import type { CompiledOntology } from '../ontology/index.ts';\nexport type A = CompiledOntology;\n";

    expect(await errors(`${svc}/src/handler/index.ts`, value)).toHaveLength(1);

    expect(
      await errors(
        `${svc}/src/handler/x.ts`,
        "import { openOntology } from '../ontology/index.ts';\nexport const a = openOntology;\n",
      ),
    ).toEqual([]);

    expect(await errors(`${svc}/src/handler/x.ts`, type)).toEqual([]);

    expect(await errors(`${svc}/src/publish/x.ts`, value)).toEqual([]);
  });

  it('service/code-layout#seams: no file of src except ontology/view.ts imports forPermissions.ts', () => {
    const importers = files(`${svc}/src`).filter((file) =>
      /from\s+['"][^'"]*forPermissions\.ts['"]/.test(readFileSync(file, 'utf8')),
    );

    expect(importers).toEqual([`${svc}/src/ontology/view.ts`]);
  });
});

describe('no code outside the auth module reads a role', () => {
  const readsRole = (text: string): boolean =>
    /\b(?:caller|person|PersonCaller|DataCaller|PermittedCaller)\b[\]'")]*\??\.role\b|\[['"]role['"]\]/.test(text) ||
    /import[^;]*\bRoleSlug\b[^;]*from\s+['"][^'"]*\/auth\//.test(text);

  it('service/code-layout#seams: the probe finds a read of the role of a caller and an import of the role slug of auth, and passes other text', () => {
    expect(
      [
        'const role = ctx.caller.role;',
        "if (person?.role === 'admin') return;",
        "import type { RoleSlug } from '../auth/index.ts';",
        'const role = caller["role"];',
      ].map(readsRole),
    ).toEqual([true, true, true, true]);

    expect(
      [
        'for (const step of steps) step.role;',
        "const caller = { user, kind: 'person' };",
        "import type { RoleSlug } from './workosSteps.ts';",
      ].map(readsRole),
    ).toEqual([false, false, false]);
  });

  it('service/code-layout#seams: no file of src outside auth/ reads the role of a caller or imports the role slug of auth', () => {
    const readers = files(`${svc}/src`).filter(
      (file) => !file.startsWith(`${svc}/src/auth/`) && readsRole(readFileSync(file, 'utf8')),
    );

    expect(readers).toEqual([]);
  });

  it('service/code-layout#seams: the caller of a route and the person value of a rule have no role', () => {
    expectTypeOf<PermittedCaller>().not.toHaveProperty('role');

    expectTypeOf<PersonCaller>().not.toHaveProperty('role');

    expectTypeOf<Ctx['caller']>().not.toHaveProperty('role');

    expectTypeOf<PersonFact['kind']>().toEqualTypeOf<'userId' | 'permissions' | 'attribute'>();
  });
});

describe('SnapshotDb', () => {
  const cast =
    "import type { Db, SnapshotDb } from '../db/index.ts';\nexport const a = (db: Db) => db as SnapshotDb;\n";

  it('refuses a cast to SnapshotDb outside the db module', async () => {
    expect(await errors(`${svc}/src/actions/x.ts`, cast)).toHaveLength(1);

    expect(await errors(`${svc}/src/db/x.ts`, cast.replace('../db/index.ts', './index.ts'))).toEqual([]);
  });

  it('refuses a cast in a test, except in the test helper', async () => {
    const testCast =
      "import type { Db, SnapshotDb } from './db/index.ts';\nexport const a = (db: Db) => db as SnapshotDb;\n";

    expect(await errors(`${svc}/src/border.test.ts`, testCast)).toHaveLength(1);

    expect(await errors(`${svc}/src/service.test-utils.ts`, testCast)).toEqual([]);
  });
});

describe('packages', () => {
  it('lets only the db module import pg and pg-query-stream', async () => {
    const code =
      "import pg from 'pg';\nimport QueryStream from 'pg-query-stream';\nexport const a = [pg, QueryStream];\n";

    expect(await errors(`${svc}/src/actions/x.ts`, code)).toHaveLength(2);

    expect(await errors(`${svc}/api/x.ts`, code)).toHaveLength(2);

    expect(await errors(`${svc}/src/db/x.ts`, code)).toEqual([]);
  });

  it('lets only the Vercel adapter import @vercel/functions', async () => {
    const code = "import { attachDatabasePool } from '@vercel/functions';\nexport const a = attachDatabasePool;\n";

    expect(await errors(`${svc}/src/handler/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/src/db/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/api/index.ts`, code)).toEqual([]);
  });

  it('allows only type imports of @osdk/client in the service', async () => {
    expect(
      await errors(
        `${svc}/src/functions/x.ts`,
        "import { createClient } from '@osdk/client';\nexport const a = createClient;\n",
      ),
    ).toHaveLength(1);

    expect(
      await errors(
        `${svc}/src/functions/x.ts`,
        "import type { Client } from '@osdk/client';\nexport type A = Client;\n",
      ),
    ).toEqual([]);
  });

  it.each(['handler', 'auth', 'ontology', 'publish', 'objectSets', 'actions', 'functions', 'db', 'errors'])(
    'service/code-layout#osdk-code: refuses an import of @osdk/faux in the %s module',
    async (module) => {
      const code = "import { createFauxFoundry } from '@osdk/faux';\nexport const a = createFauxFoundry;\n";

      expect(await errors(`${svc}/src/${module}/x.ts`, code)).toHaveLength(1);
    },
  );

  it('service/code-layout#modules: refuses an input or output import in a pure file', async () => {
    const io = [
      ...[
        'fs',
        'net',
        'http',
        'https',
        'child_process',
        'tls',
        'dgram',
        'http2',
        'dns',
        'module',
        'worker_threads',
        'sqlite',
        'inspector',
        'cluster',
        'readline',
        'process',
      ].flatMap((name) => [name, `node:${name}`]),
      'node:fs/promises',
      'readline/promises',
      'fs/promises',
      'node:child_process/x',
      'pg',
      'pg-query-stream',
      'pg/lib/client.js',
      'pg-query-stream/dist/index.js',
    ];

    const code =
      io.map((name, index) => `import * as m${index} from '${name}';`).join('\n') + '\nexport const a = 1;\n';

    expect(await errors(`${svc}/src/errors/x.ts`, code)).toHaveLength(io.length);

    expect(await errors(`${svc}/src/handler/x.ts`, code)).toHaveLength(2);

    const pure = "import { join } from 'node:path';\nimport { fsx } from 'fsx';\nexport const a = [join, fsx];\n";

    expect(await errors(`${svc}/src/errors/x.ts`, pure)).toEqual([]);

    const ir = "import type { OntologyIr } from '@osdk/client.unstable';\nexport type A = OntologyIr;\n";

    expect(await errors(`${svc}/src/errors/x.ts`, ir)).toHaveLength(1);

    expect(await errors(`${svc}/src/publish/metadata.ts`, ir)).toEqual([]);
  });

  it('service/code-layout#seams: lets only the ontology and publish modules import @osdk/client.unstable, so no route reads the IR', async () => {
    const code = "import type { OntologyIr } from '@osdk/client.unstable';\nexport type A = OntologyIr;\n";

    expect(await errors(`${svc}/src/objectSets/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/src/actions/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/src/handler/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/src/db/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/api/x.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/src/ontology/routes.ts`, code)).toHaveLength(1);

    expect(await errors(`${svc}/src/ontology/x.ts`, code)).toEqual([]);

    expect(await errors(`${svc}/src/publish/x.ts`, code)).toEqual([]);
  });

  it('service/code-layout#modules: refuses an input or output import in the pure files of publish', async () => {
    const code = "import * as fs from 'node:fs';\nimport pg from 'pg';\nexport const a = [fs, pg];\n";

    for (const file of [
      'request.ts',
      'plan.ts',
      'tableChanges.ts',
      'metadata.ts',
      'convert.ts',
      'standInFunctions.ts',
      'storedNames.ts',
      'osdkSets.ts',
      'remap.ts',
      'newFile.ts',
    ]) {
      expect(await errors(`${svc}/src/publish/${file}`, code)).toHaveLength(2);
    }

    const io = "import * as fs from 'node:fs';\nexport const a = fs;\n";

    for (const file of [
      'columnLimit.ts',
      'index.ts',
      'publishOntology.ts',
      'remapEntry.ts',
      'schemaMigrations.ts',
      'upgrade.ts',
      'versions.ts',
    ]) {
      expect(await errors(`${svc}/src/publish/${file}`, io)).toEqual([]);
    }
  });

  it('service/code-layout#modules: refuses an input or output import in the pure files of the ontology compile step', async () => {
    const code = "import * as fs from 'node:fs';\nimport pg from 'pg';\nexport const a = [fs, pg];\n";

    for (const file of [
      'objectTypes.ts',
      'actionTypes.ts',
      'linkTypes.ts',
      'parameters.ts',
      'properties.ts',
      'functions.ts',
      'display.ts',
      'rids.ts',
      'names.ts',
      'shape.ts',
      'compile.ts',
      'compiled.ts',
      'tableNames.ts',
      'newFile.ts',
    ]) {
      expect(await errors(`${svc}/src/ontology/${file}`, code)).toHaveLength(2);
    }

    expect(
      await errors(`${svc}/src/ontology/index.ts`, "import * as fs from 'node:fs';\nexport const a = fs;\n"),
    ).toEqual([]);

    expect(
      await errors(`${svc}/src/ontology/routes.ts`, "import * as fs from 'node:fs';\nexport const a = fs;\n"),
    ).toEqual([]);
  });

  it('service/code-layout#modules: refuses an input or output import in the pure compiler files of objectSets', async () => {
    const io = (db: string) =>
      `import * as fs from 'node:fs';\nimport pg from 'pg';\nimport { createDb } from '${db}';\nexport const a = [fs, pg, createDb];\n`;

    expect(await errors(`${svc}/src/objectSets/compile/x.ts`, io('../../db/index.ts'))).toHaveLength(3);

    expect(
      await errors(
        `${svc}/src/objectSets/compile/x.ts`,
        'export const a = ({ handleTrusted }: { handleTrusted: unknown }) => handleTrusted;\n',
      ),
    ).toHaveLength(1);

    const pure =
      "import { createHash } from 'node:crypto';\nimport { quoteName } from '../../db/index.ts';\nimport { ApiError } from '../../errors/index.ts';\nexport const a = [createHash, quoteName, ApiError];\n";

    expect(await errors(`${svc}/src/objectSets/compile/x.ts`, pure)).toEqual([]);

    expect(
      await errors(`${svc}/src/objectSets/x.ts`, "import * as fs from 'node:fs';\nexport const a = fs;\n"),
    ).toEqual([]);
  });

  it('service/code-layout#modules: refuses an input or output import in the pure files of actions', async () => {
    const io = (db: string) =>
      `import * as fs from 'node:fs';\nimport pg from 'pg';\nimport { createDb } from '${db}';\nexport const a = [fs, pg, createDb];\n`;

    expect(await errors(`${svc}/src/actions/pure/x.ts`, io('../../db/index.ts'))).toHaveLength(3);

    expect(
      await errors(
        `${svc}/src/actions/pure/x.ts`,
        'export const a = ({ handleTrusted }: { handleTrusted: unknown }) => handleTrusted;\n',
      ),
    ).toHaveLength(1);

    const pure =
      "import { randomUUID } from 'node:crypto';\nimport { quoteName } from '../../db/index.ts';\nimport { ApiError } from '../../errors/index.ts';\nexport const a = [randomUUID, quoteName, ApiError];\n";

    expect(await errors(`${svc}/src/actions/pure/x.ts`, pure)).toEqual([]);

    expect(await errors(`${svc}/src/actions/x.ts`, "import * as fs from 'node:fs';\nexport const a = fs;\n")).toEqual(
      [],
    );
  });

  it('service/code-layout#modules: refuses the db exports that do input or output in a pure file', async () => {
    const code = [
      "import { createPool, createDb, applyEngineChanges } from '../db/index.ts';",
      "import * as db from '../db/index.ts';",
      'export const a = [createPool, createDb, applyEngineChanges, db];',
      '',
    ].join('\n');

    expect(await errors(`${svc}/src/publish/plan.ts`, code)).toHaveLength(4);

    expect(await errors(`${svc}/src/publish/x.ts`, code)).toHaveLength(4);

    const pure =
      "import { quoteName, type Schemas, type Sql } from '../db/index.ts';\nexport const a = [quoteName];\nexport type S = Sql | Schemas;\n";

    expect(await errors(`${svc}/src/publish/plan.ts`, pure)).toEqual([]);

    for (const source of ['../db/./index.ts', '../db//index.ts', '../publish/../db/index.ts', './../db/./index.ts']) {
      const other = `import { createPool } from '${source}';\nexport const a = createPool;\n`;

      expect(await errors(`${svc}/src/publish/plan.ts`, other)).toContain(
        'Write the import path in normal form, with no "//", "/./", or "/../" inside it.',
      );
    }

    const dotSlash = "import { createPool } from './../db/index.ts';\nexport const a = createPool;\n";

    expect(await errors(`${svc}/src/publish/plan.ts`, dotSlash)).toHaveLength(1);
  });

  it('service/code-layout#modules: refuses process.getBuiltinModule in a pure file', async () => {
    const code = [
      "export const a = process.getBuiltinModule('node:fs');",
      "export const b = globalThis.process.getBuiltinModule('fs');",
      'export const { getBuiltinModule } = process;',
      '',
    ].join('\n');

    expect(await errors(`${svc}/src/errors/x.ts`, code)).toHaveLength(3);

    expect(await errors(`${svc}/src/publish/plan.ts`, code)).toHaveLength(3);

    expect(await errors(`${svc}/src/handler/x.ts`, code)).toEqual([]);

    const trusted = 'declare const ctx: { handleTrusted: unknown };\nexport const a = ctx.handleTrusted;\n';

    expect(await errors(`${svc}/src/publish/plan.ts`, trusted)).toHaveLength(1);
  });

  it.each(['ontology', 'publish'])(
    'keeps the other package borders in src/%s, where @osdk/client.unstable is allowed',
    async (dir) => {
      const code = [
        "import pg from 'pg';",
        "import QueryStream from 'pg-query-stream';",
        "import { attachDatabasePool } from '@vercel/functions';",
        "import { createClient } from '@osdk/client';",
        'export const a = [pg, QueryStream, attachDatabasePool, createClient];',
        '',
      ].join('\n');

      expect(await errors(`${svc}/src/${dir}/x.ts`, code)).toHaveLength(4);
    },
  );

  it('service/code-layout#packages: lets the CLI import the service types with import type only, values only from the compile step and the converter, and no service file', async () => {
    const convert =
      "import { ontologyMetadata } from '@ericbragas/ontos-service/convert';\nexport const a = ontologyMetadata;\n";

    const value = "import { publish } from '@ericbragas/ontos-service/publish';\nexport const a = publish;\n";

    const type =
      "import type { PublishRequest } from '@ericbragas/ontos-service/publish';\nexport type A = PublishRequest;\n";

    const file = "import { createDb } from '../../service/src/db/index.ts';\nexport const a = createDb;\n";

    expect(await errors('packages/cli/src/x.ts', value)).toHaveLength(1);

    expect(await errors('packages/cli/src/x.ts', type)).toEqual([]);

    expect(await errors('packages/cli/src/x.ts', convert)).toEqual([]);

    expect(await errors('packages/cli/src/x.ts', file)).toHaveLength(1);

    const helper = "export * from '../../service/src/errors/fallible.ts';\n";

    expect(await errors('packages/cli/src/x.ts', helper)).toHaveLength(1);

    const shim = readFileSync(new URL('../../cli/src/fallible.ts', import.meta.url), 'utf8');

    expect(await errors('packages/cli/src/fallible.ts', shim)).toEqual([]);

    expect(await errors('packages/cli/src/fallible.ts', `${shim}${file}`)).toHaveLength(1);
  });
});

describe('the trusted pair', () => {
  const REPOSITORY = /(?<!@)\bebragas\/ontos[\w.-]*/g;

  it('service/authentication#ci-workflows: no file of packages/service/src/ or api/ holds a repository name', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));

    const found = [...files(join(root, 'src')), ...files(join(root, 'api'))].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(REPOSITORY)].map((match) => `${file}: ${match[0]}`),
    );

    expect(found).toEqual([]);

    expect("const trusted = 'ebragas/ontos'; // @ericbragas/ontos-service".match(REPOSITORY)).toEqual([
      'ebragas/ontos',
    ]);
  });
});

function importPaths(text: string): string[] {
  const quoted = '[\'"`]([^\'"`]+)[\'"`]';
  const pattern = new RegExp(`\\bfrom\\s*${quoted}|\\bimport\\s*\\(\\s*${quoted}|^\\s*import\\s*${quoted}`, 'gm');

  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

describe('the remap entry', () => {
  const modules = readdirSync(`${svc}/src`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'publish')
    .map((entry) => entry.name);

  it('service/code-layout#packages: the entry in publish/ imports the remap, the lock of install, and the connection of db', async () => {
    const code = [
      "import { createDb, createPool } from '../db/index.ts';",
      "import { lockProductVersions } from './install.ts';",
      "import { readOwners, remap } from './remap.ts';",
      'export const a = [createDb, createPool, lockProductVersions, readOwners, remap, process.env, fetch];',
      '',
    ].join('\n');

    expect(await errors(`${svc}/src/publish/remapEntry.ts`, code)).toEqual([]);
  });

  it('service/code-layout#packages: the remap stays a pure file, so it opens no connection', async () => {
    const code = "import { createPool } from '../db/index.ts';\nexport const a = createPool;\n";

    expect(await errors(`${svc}/src/publish/remap.ts`, code)).toEqual([
      "'createPool' import from '../db/index.ts' is restricted from being used by a pattern. A pure file takes data and returns data or SQL. It does no input or output.",
    ]);
  });

  it('service/code-layout#packages: a file of each other module, and each adapter, that imports the remap or its entry gets the inner-import error', async () => {
    expect(modules).toEqual(
      expect.arrayContaining([
        'actions',
        'auth',
        'db',
        'errors',
        'functions',
        'handler',
        'mcp',
        'objectSets',
        'ontology',
      ]),
    );

    for (const target of ['remap.ts', 'remapEntry.ts']) {
      for (const module of modules) {
        const code = `import { main } from '../publish/${target}';\nexport const a = main;\n`;

        expect(await errors(`${svc}/src/${module}/x.ts`, code)).toEqual([
          'Import another module only through its index.ts.',
        ]);
      }

      expect(
        await errors(`${svc}/src/x.ts`, `import { main } from './publish/${target}';\nexport const a = main;\n`),
      ).toEqual(['Import another module only through its index.ts.']);

      expect(
        await errors(`${svc}/api/x.ts`, `import { main } from '../src/publish/${target}';\nexport const a = main;\n`),
      ).toEqual(['Import another module only through its index.ts.']);
    }
  });

  it('service/code-layout#packages: in src/ and api/, only publish/remapEntry.ts imports publish/remap.ts, and no file imports publish/remapEntry.ts', () => {
    const importers = (target: string): string[] =>
      [...files(`${svc}/src`), ...files(`${svc}/api`)]
        .filter((file) =>
          importPaths(readFileSync(file, 'utf8')).some(
            (path) => path.startsWith('.') && join(file, '..', path) === join(`${svc}/src/publish`, target),
          ),
        )
        .sort();

    expect(importers('remap.ts')).toEqual([`${svc}/src/publish/remapEntry.ts`]);
    expect(importers('remapEntry.ts')).toEqual([]);
    expect(importers('install.ts')).toContain(`${svc}/src/publish/remap.ts`);
  });

  it('service/code-layout#packages: the importer check reads each quote form of each import', () => {
    const probes = ["'", '"', '`'].flatMap((q) => [
      `import { remap } from ${q}./remap.ts${q};`,
      `export { remap } from ${q}./remap.ts${q};`,
      `import ${q}./remap.ts${q};`,
      `const m = await import(${q}./remap.ts${q});`,
    ]);

    expect(probes.map((line) => importPaths(line))).toEqual(probes.map(() => ['./remap.ts']));
  });

  it('service/code-layout#packages: publish/index.ts exports no part of the remap', () => {
    const index = readFileSync(`${svc}/src/publish/index.ts`, 'utf8');

    expect(index).not.toMatch(/remap/i);
  });

  it('service/code-layout#packages: the entry imports values only from publish, db, and errors', () => {
    const source = readFileSync(`${svc}/src/publish/remapEntry.ts`, 'utf8');
    const imports = [...source.matchAll(/^import (?!type )[^;]* from '([^']+)';$/gm)].map((match) => match[1]);

    expect(imports).toEqual(['../db/index.ts', '../errors/index.ts', './remap.ts']);
  });
});

describe('the spans module and the OpenTelemetry packages', () => {
  async function lint(file: string, code: string): Promise<string[]> {
    return (await lintText(file, code)).filter((f) => borderRules.has(f.rule)).map((f) => `${f.rule}: ${f.message}`);
  }

  const modules = readdirSync(`${svc}/src`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const otelApi = "import { trace } from '@opentelemetry/api';\nexport const a = trace;\n";

  const apiRefused =
    "no-restricted-imports: '@opentelemetry/api' import is restricted from being used by a pattern. Only the spans module imports @opentelemetry/api.";

  const sdkPackages = [
    '@opentelemetry/sdk-trace',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/resources',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/core',
  ];

  const sdkRefused = (name: string) =>
    `no-restricted-imports: '${name}' import is restricted from being used by a pattern. Only the Vercel adapter in api/_tracing.ts imports the OpenTelemetry SDK and the exporters.`;

  const valueOf = (from: string, to: string) =>
    `import { x } from '${from === 'node.ts' ? './' : '../'}${to}/index.ts';\nexport const a = x;\n`;

  it('service/code-layout#libraries: in src/, only the spans module imports @opentelemetry/api, also with import type', async () => {
    expect(modules).toEqual(expect.arrayContaining(['spans', 'handler', 'db', 'errors', 'mcp']));

    for (const module of modules.filter((name) => name !== 'spans'))
      expect(await lint(`${svc}/src/${module}/x.ts`, otelApi)).toEqual([apiRefused]);

    expect(await lint(`${svc}/src/node.ts`, otelApi)).toEqual([apiRefused]);

    expect(
      await lint(`${svc}/src/handler/x.ts`, "import type { Span } from '@opentelemetry/api';\nexport type A = Span;\n"),
    ).toEqual([apiRefused]);

    expect(await lint(`${svc}/src/spans/x.ts`, otelApi)).toEqual([]);

    expect(await lint(`${svc}/api/_tracing.ts`, otelApi)).toEqual([]);

    expect(await lint(`${svc}/api/index.ts`, otelApi)).toEqual([apiRefused]);
  });

  it('service/code-layout#http-entry service/code-layout#libraries: only api/ imports the OpenTelemetry SDK and the exporters', async () => {
    for (const name of sdkPackages) {
      const code = `import * as m from '${name}';\nexport const a = m;\n`;

      for (const module of modules) expect(await lint(`${svc}/src/${module}/x.ts`, code)).toEqual([sdkRefused(name)]);

      expect(await lint(`${svc}/src/node.ts`, code)).toEqual([sdkRefused(name)]);

      expect(await lint(`${svc}/api/_tracing.ts`, code)).toEqual([]);

      expect(await lint(`${svc}/api/index.ts`, code)).toEqual([sdkRefused(name)]);
    }
  });

  it('service/code-layout#modules: handler, auth, ontology, publish, actions, functions, and db may import a value from spans; mcp, objectSets, errors, and the adapters may not', async () => {
    for (const module of ['handler', 'auth', 'ontology', 'publish', 'actions', 'functions', 'db']) {
      expect(await lint(`${svc}/src/${module}/index.ts`, valueOf(module, 'spans'))).toEqual([]);
    }

    const refused = (module: string) =>
      `local/module-border: The ${module} module may not import a value from spans. Use import type, or change runtimeImports in oxlint.config.ts.`;

    for (const module of ['mcp', 'objectSets'])
      expect(await lint(`${svc}/src/${module}/index.ts`, valueOf(module, 'spans'))).toEqual([refused(module)]);

    expect(await lint(`${svc}/src/errors/index.ts`, valueOf('errors', 'spans'))).toEqual([
      "no-restricted-imports: '../spans/index.ts' import is restricted from being used by a pattern. A pure file imports no value of spans. Its caller adds the span.",
      refused('errors'),
    ]);

    expect(await lint(`${svc}/src/node.ts`, valueOf('node.ts', 'spans'))).toEqual([
      'local/module-border: The adapter module may not import a value from spans. Use import type, or change runtimeImports in oxlint.config.ts.',
    ]);

    expect(
      await lint(
        `${svc}/src/mcp/x.ts`,
        "import type { SpanName } from '../spans/index.ts';\nexport type A = SpanName;\n",
      ),
    ).toEqual([]);
  });

  it('service/code-layout#modules: the Vercel adapter in api/ imports no value of spans', async () => {
    const code = "import { rootSpan } from '../src/spans/index.ts';\nexport const a = rootSpan;\n";

    const refused =
      'local/module-border: The adapter module may not import a value from spans. Use import type, or change runtimeImports in oxlint.config.ts.';

    for (const file of ['index.ts', '_tracing.ts']) expect(await lint(`${svc}/api/${file}`, code)).toEqual([refused]);
  });

  it('service/code-layout#modules: spans imports values only from errors', async () => {
    expect(await lint(`${svc}/src/spans/x.ts`, valueOf('spans', 'errors'))).toEqual([]);

    for (const module of modules.filter((name) => name !== 'spans' && name !== 'errors')) {
      expect(await lint(`${svc}/src/spans/x.ts`, valueOf('spans', module))).toEqual([
        `local/module-border: The spans module may not import a value from ${module}. Use import type, or change runtimeImports in oxlint.config.ts.`,
      ]);
    }

    const types =
      "import type { Caller } from '../auth/index.ts';\nimport type { Sql } from '../db/index.ts';\nexport type A = [Caller, Sql];\n";

    expect(await lint(`${svc}/src/spans/x.ts`, types)).toEqual([]);
  });

  it('service/code-layout#modules: a pure file imports no value of spans, and may import its types', async () => {
    const refused = (path: string) =>
      `no-restricted-imports: '${path}' import is restricted from being used by a pattern. A pure file imports no value of spans. Its caller adds the span.`;

    expect(await lint(`${svc}/src/publish/plan.ts`, valueOf('publish', 'spans'))).toEqual([
      refused('../spans/index.ts'),
    ]);

    expect(await lint(`${svc}/src/ontology/compile.ts`, valueOf('ontology', 'spans'))).toEqual([
      refused('../spans/index.ts'),
    ]);

    expect(
      await lint(
        `${svc}/src/actions/pure/x.ts`,
        "import { span } from '../../spans/index.ts';\nexport const a = span;\n",
      ),
    ).toEqual([refused('../../spans/index.ts')]);

    expect(
      await lint(
        `${svc}/src/publish/plan.ts`,
        "import type { SpanName } from '../spans/index.ts';\nexport type A = SpanName;\n",
      ),
    ).toEqual([]);

    expect(await lint(`${svc}/src/publish/publishOntology.ts`, valueOf('publish', 'spans'))).toEqual([]);

    expect(await lint(`${svc}/src/ontology/index.ts`, valueOf('ontology', 'spans'))).toEqual([]);
  });

  it('service/code-layout#modules: the module-border rule refuses each value import that runtimeImports does not list, and each module of src/ has a row in Code layout "Modules"', async () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../docs/service/code-layout.md', import.meta.url)), 'utf8');
    const section = doc.slice(doc.indexOf('### Modules'), doc.indexOf('### Seams'));
    const rows = [...section.matchAll(/^\| `(\w+)` +\|/gm)].map(([, module]) => module ?? '');

    expect(rows.sort()).toEqual([...modules].sort());
    expect(Object.keys(runtimeImports).sort()).toEqual([...modules, 'adapter'].sort());

    for (const from of modules) {
      for (const to of modules.filter((name) => name !== from)) {
        const found = await lint(`${svc}/src/${from}/index.ts`, valueOf(from, to));

        expect({ from, to, allowed: found.length === 0 }).toEqual({
          from,
          to,
          allowed: runtimeImports[from]?.includes(to),
        });
      }
    }

    expect(runtimeImports['db']).toEqual(['errors', 'spans', 'decimal']);
    expect(runtimeImports['spans']).toEqual(['errors']);
  });
});

describe('the grants file', () => {
  it('service/ontology-as-code#the-grants-file: the CLI, the service, and the twin take 1 grants file type and 1 parser', () => {
    const pkg = JSON.parse(readFileSync(`${svc}/package.json`, 'utf8')) as {
      exports: Record<string, { default?: string }>;
    };

    expect(pkg.exports['./convert']?.default).toBe('./dist/convert.js');
    expect(publishConvert.parseGrantsFile).toBe(ontologyIndex.parseGrantsFile);

    const declaring = [...allFiles(`${svc}/src`), ...allFiles(`${svc}/twin`), ...files('packages/cli/src')].filter(
      (file) =>
        /^(export )?(interface|type) GrantsFile\b|^(export )?function parseGrantsFile\b/m.test(
          readFileSync(file, 'utf8'),
        ),
    );

    expect(declaring).toEqual([`${svc}/src/ontology/grantsFile.ts`]);

    expect(readFileSync(`${svc}/src/ontology/stored.test-utils.ts`, 'utf8')).toMatch(
      /import \{[^}]*\bparseGrantsFile\b[^}]*\} from '\.\/index\.ts';/,
    );
  });
});
