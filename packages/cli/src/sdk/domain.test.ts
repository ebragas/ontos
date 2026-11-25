import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempFolder } from '../cli.test-utils.ts';
import { readDomain } from './domain.ts';
import { settle } from '../fallible.ts';

const read = (files: Readonly<Record<string, string>>) => settle(readDomain(tempFolder(files)));

describe('domain/ discovery and import checks', () => {
  it('ontology/ontology-sdk/ontology-sdk#contract: gives undefined when domain/ or domain/index.ts does not exist', async () => {
    expect(await read({})).toEqual({ ok: true, value: undefined });

    expect(await read({ 'domain/money.ts': 'export const ZERO = 0;\n' })).toEqual({ ok: true, value: undefined });
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: gives undefined when domain/index.ts is a symlink', async () => {
    const folder = tempFolder({
      'outside.ts': 'export const ZERO = 0;\n',
      'domain/money.ts': 'export const ONE = 1;\n',
    });

    symlinkSync(join(folder, 'outside.ts'), join(folder, 'domain/index.ts'));

    expect(await settle(readDomain(folder))).toEqual({ ok: true, value: undefined });
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: collects non-test .ts files under domain/ in sorted path order and excludes test, helper, fixture, and non-ts files', async () => {
    const result = await read({
      'domain/index.ts': "export * from './money.ts';\nexport * from './sub/rule.ts';\n",
      'domain/money.ts': 'export const ZERO = 0;\n',
      'domain/sub/rule.ts':
        "import { ZERO } from '../money.ts';\nexport const isZero = (value: number) => value === ZERO;\n",
      'domain/money.test.ts': "import { describe } from 'vitest';\nvoid describe;\n",
      'domain/money.test-utils.ts': "import { expect } from 'vitest';\nvoid expect;\n",
      'domain/money.fixture.ts': "import { readFileSync } from 'node:fs';\nvoid readFileSync;\n",
      'domain/README.md': '# domain\n',
    });

    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.value?.map((file) => file.path)).toEqual(['index.ts', 'money.ts', 'sub/rule.ts']);
  });

  it('ontology/ontology-sdk/ontology-sdk#contract: allows relative imports inside domain/ and type-only imports from @osdk/client', async () => {
    const result = await read({
      'domain/index.ts': [
        "import type { Client } from '@osdk/client';",
        "import { type Client as ClientAlias } from '@osdk/client';",
        "export type { Client } from '@osdk/client';",
        "export * from './money.js';",
        'export type UsesClient = Client | ClientAlias;',
        '',
      ].join('\n'),
      'domain/money.ts': 'export const ZERO = 0;\n',
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ['third-party runtime import', "import { chunk } from 'lodash';\nexport const f = chunk;\n", '"lodash"'],
    ['side-effect bare import', "import 'reflect-metadata';\n", '"reflect-metadata"'],
    ['Node built-in import', "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n", '"node:fs"'],
    [
      'runtime @osdk/client import',
      "import { createClient } from '@osdk/client';\nexport const f = createClient;\n",
      '"@osdk/client"',
    ],
    [
      '@osdk/functions import',
      "import { UserFacingError } from '@osdk/functions';\nexport const f = UserFacingError;\n",
      '"@osdk/functions"',
    ],
    [
      '@ontology/sdk import',
      "import { Account } from '@ontology/sdk';\nexport const f = Account;\n",
      '"@ontology/sdk"',
    ],
    [
      'type-only @ontology/sdk import',
      "import type { Account } from '@ontology/sdk';\nexport type A = Account;\n",
      '"@ontology/sdk"',
    ],
    ['type-only non-peer import', "import type { ZodType } from 'zod';\nexport type Z = ZodType;\n", '"zod"'],
    ['re-export from external package', "export { chunk } from 'lodash';\n", '"lodash"'],
    ['dynamic import of external package', "export const load = () => import('lodash');\n", '"lodash"'],
    ['import type expression of external package', "export type Z = import('zod').ZodType;\n", '"zod"'],
    [
      'import = require of external package',
      "import lodash = require('lodash');\nexport const f = lodash;\n",
      '"lodash"',
    ],
  ])(
    'ontology/ontology-sdk/ontology-sdk#contract: refuses %s with a CliError naming the file and specifier',
    async (_label, source, specifier) => {
      const result = await read({
        'domain/index.ts': "export * from './money.ts';\n",
        'domain/money.ts': source,
      });

      expect(result.ok).toBe(false);

      if (result.ok) return;

      expect(result.error.message).toContain('domain/money.ts');
      expect(result.error.message).toContain(specifier);
    },
  );

  it('ontology/ontology-sdk/ontology-sdk#contract: refuses a relative import that leaves domain/ and a computed dynamic import', async () => {
    const escaping = await read({
      'domain/index.ts': "export * from '../lib/money.ts';\n",
    });

    expect(escaping.ok).toBe(false);

    if (escaping.ok) throw new Error('Expected readDomain to fail.');

    expect(escaping.error.message).toContain('domain/index.ts');
    expect(escaping.error.message).toContain('"../lib/money.ts"');
    expect(escaping.error.message).toContain('leaves domain/');

    const computed = await read({
      'domain/index.ts': 'export const load = (name: string) => import(name);\n',
    });

    expect(computed.ok).toBe(false);

    if (computed.ok) throw new Error('Expected readDomain to fail.');

    expect(computed.error.message).toContain('domain/index.ts');
    expect(computed.error.message).toContain('dynamic import()');
  });
});
