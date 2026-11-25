import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONS_TSCONFIG, TWIN_FUNCTIONS, twinFunctionsApp, twinOntology } from './apps.test-utils.ts';
import {
  cli,
  once,
  ROOT,
  STUB,
  stubConfig,
  stubFetch,
  warm,
  withoutDescriptionWarnings,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const flags = ['--app', 'twin', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };
const PUBLISH = `${STUB}/api/ontology-service/v1/publish`;

const publishRoute: Handler = ({ method, url }) =>
  method === 'POST' && url === PUBLISH
    ? Response.json({ changes: [], metadata: { ontology: { rid: 'ri.ontology.main.ontology.stub' } } })
    : undefined;

interface Published {
  readonly discovered: Record<string, unknown>[];
  readonly bundle: string;
}

const published = (calls: readonly Call[]): Published | undefined =>
  (JSON.parse(calls.find(({ url }) => url === PUBLISH)?.body ?? 'null') as { functions?: Published } | null)?.functions;

const locator = (fn: Record<string, unknown> | undefined) =>
  (fn?.['locator'] as { typescript: { functionName: string; filePath: string } } | undefined)?.typescript;

const functionName = (fn: Record<string, unknown> | undefined) => locator(fn)?.functionName;
const filePath = (fn: Record<string, unknown> | undefined) => locator(fn)?.filePath;

const ANONYMOUS_TEST_FILE = [
  'import type { Client, Osdk } from "@osdk/client";',
  'import type { Edits } from "@osdk/functions";',
  'import { Account } from "@ontology/sdk";',
  '',
  'export default async function (client: Client, account: Osdk.Instance<Account>): Promise<Edits.Object<Account>[]> {',
  '  void client;',
  '  void account;',
  '  return [];',
  '}',
  'export const config = { apiName: "probeTestFile" };',
  '',
].join('\n');

const NAMED_TEST_FILE = [
  'import type { Client } from "@osdk/client";',
  '',
  'export default function probeTestFile(client: Client): string {',
  '  void client;',
  '  return "ok";',
  '}',
  '',
].join('\n');

async function validate(cwd: string): Promise<{ code: number; stderr: string; functions: Published | undefined }> {
  const fetch = stubFetch(stubConfig, publishRoute);

  const run = await cli(['validate', ...flags], { cwd, fetch, env });

  return { code: run.code, stderr: withoutDescriptionWarnings(run.stderr), functions: published(fetch.calls) };
}

const validateTwin = once(() => validate(twinFunctionsApp()));

const functionFile = (name: string, config: string) =>
  `import type { Client } from "@osdk/client";\nexport default function ${name}(client: Client, label: string): string {\n  return label;\n}\n${config}`;

const WRAPPED_CONFIGS = ['{ apiName: "other" } as const', '({ apiName: "other" }) satisfies { apiName: string }'];

const validateApiNames = once(async () => {
  const result = await validate(
    twinFunctionsApp({
      'functions/typescript-functions/src/functions/withConfig.ts': functionFile(
        'withConfig',
        'export const config = { apiName: "withConfig" };\n',
      ),
      'functions/typescript-functions/src/functions/fromFile.ts': functionFile('fromFile', ''),
    }),
  );

  const mismatch = await validate(
    twinFunctionsApp({
      'functions/typescript-functions/src/functions/__tests__/probeTestFile.test.ts': ANONYMOUS_TEST_FILE,
    }),
  );

  const wrapped: Awaited<ReturnType<typeof validate>>[] = [];

  for (const config of WRAPPED_CONFIGS)
    wrapped.push(
      await validate(
        twinFunctionsApp({
          'functions/typescript-functions/src/functions/fromFile.ts': functionFile(
            'fromFile',
            `export const config = ${config};\n`,
          ),
        }),
      ),
    );

  return { result, mismatch, wrapped };
});

beforeAll(async () => {
  await warm(validateTwin, validateApiNames);
}, 120_000);

describe('Function discovery', () => {
  it('ontology/functions/functions#discovery, service/cli#inputs: the CLI reads each Function with the TypeScript compiler, and writes the discovered Functions schema', async () => {
    const result = await validateTwin();

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const discovered = result.functions?.discovered ?? [];

    expect(discovered.map((fn) => functionName(fn))).toEqual([...TWIN_FUNCTIONS]);

    expect(discovered.map((fn) => filePath(fn))).toEqual([
      'functions/closeAccount.ts',
      'functions/probeVersionCheck.ts',
      'functions/setRelationship.ts',
    ]);

    const close = discovered[0];

    expect(close?.['inputs']).toEqual([
      {
        name: 'client',
        dataType: { type: 'client', client: { type: 'ontologySdkClient', ontologySdkClient: {} } },
        constraints: [],
        required: true,
      },
      {
        name: 'account',
        dataType: { type: 'object', object: { objectTypeId: 'com.example.twin.Account' } },
        required: true,
        constraints: [],
      },
      {
        name: 'reason',
        dataType: { type: 'optionalType', optionalType: { wrappedType: { type: 'string', string: {} } } },
        required: false,
        constraints: [],
      },
    ]);

    const setRel = discovered[2];

    const relTypes = setRel?.['customTypes'] as Record<
      string,
      { locator: { interfaceName: string }; fields: Record<string, unknown> }
    >;

    expect(Object.values(relTypes).map((t) => t.locator.interfaceName)).toEqual(['Relationship']);
  });

  it('ontology/functions/functions#code: a Function is the default export of 1 file, and a file with no default export Function gives no Function', async () => {
    const helper = 'export function helper(): string {\n  return "x";\n}\n';

    const arrow =
      'import type { Client } from "@osdk/client";\nconst arrow = (client: Client, label: string): string => label;\nexport default arrow;\n';

    const result = await validate(
      twinFunctionsApp({
        'functions/typescript-functions/src/functions/helper.ts': helper,
        'functions/typescript-functions/src/functions/arrow.ts': arrow,
        'functions/typescript-functions/src/functions/README.md': '# Functions\n',
      }),
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const names = result.functions?.discovered.map((fn) => functionName(fn));

    expect(names).toEqual(['arrow', ...TWIN_FUNCTIONS]);

    expect(result.functions?.discovered[0]?.['inputs']).toEqual([
      {
        name: 'client',
        dataType: { type: 'client', client: { type: 'ontologySdkClient', ontologySdkClient: {} } },
        constraints: [],
        required: true,
      },
      { name: 'label', dataType: { type: 'string', string: {} }, required: true, constraints: [] },
    ]);
  });

  it('ontology/functions/functions#code: the CLI discovers the Functions of functions/typescript-functions/src/functions/, and no file outside it', async () => {
    const outside =
      'import type { Client } from "@osdk/client";\nexport default function outside(client: Client): string {\n  return "x";\n}\nexport const config = { apiName: "outside" };\n';

    const result = await validate(twinFunctionsApp({ 'functions/typescript-functions/src/outside.ts': outside }));

    expect(result.code).toBe(0);
    expect(result.functions?.discovered).toHaveLength(3);

    expect(result.functions?.discovered.map((fn) => filePath(fn))).toEqual([
      'functions/closeAccount.ts',
      'functions/probeVersionCheck.ts',
      'functions/setRelationship.ts',
    ]);
  });

  it('ontology/functions/functions#code: the API name is the file name, and a config apiName that is not the file name stops validate', async () => {
    const { result, mismatch, wrapped } = await validateApiNames();

    expect(result.stderr).toBe('');

    const names = result.functions?.discovered.map((entry) => functionName(entry));

    expect(names).toEqual(['closeAccount', 'fromFile', 'probeVersionCheck', 'setRelationship', 'withConfig']);

    const fromFile = result.functions?.discovered.find((entry) => functionName(entry) === 'fromFile');

    expect(fromFile?.['inputs']).toEqual([
      {
        name: 'client',
        dataType: { type: 'client', client: { type: 'ontologySdkClient', ontologySdkClient: {} } },
        constraints: [],
        required: true,
      },
      { name: 'label', dataType: { type: 'string', string: {} }, required: true, constraints: [] },
    ]);

    expect(fromFile?.['output']).toEqual({ type: 'single', single: { dataType: { type: 'string', string: {} } } });
    expect(mismatch.code).toBe(1);

    expect(JSON.parse(mismatch.stderr)).toEqual({
      message:
        'functions/__tests__/probeTestFile.test.ts: the apiName of the config export, probeTestFile, must be the file name, probeTestFile.test, as Functions "Code" specifies. Change the apiName or the file name.',
    });

    expect(mismatch.functions).toBeUndefined();
    expect(wrapped).toHaveLength(WRAPPED_CONFIGS.length);

    for (const run of wrapped) {
      expect(run.code).toBe(1);

      expect(JSON.parse(run.stderr)).toEqual({
        message:
          'functions/fromFile.ts: the apiName of the config export, other, must be the file name, fromFile, as Functions "Code" specifies. Change the apiName or the file name.',
      });
    }
  });

  it('ontology/functions/functions#discovery: an interface that refers to itself stops validate with an error that names it, not a stack overflow', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      'export interface Item {',
      '  name: string;',
      '  parent?: Item;',
      '}',
      'export default function recursive(client: Client, item: Item): string {',
      '  return item.name;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/recursive.ts': source }),
    );

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stderr)).toEqual({
      message:
        'Function recursive, input item, field parent: the interface Item of functions/recursive.ts refers to itself. A Function input or output cannot hold a recursive type.',
    });

    expect(result.functions).toBeUndefined();
  });

  it('ontology/functions/functions#code, ontology/functions/edit-functions#provenance: an edit Function returns the edits of its Edits type, and the Edits type gives the edited Object Types', async () => {
    const result = await validateTwin();

    const close = result.functions?.discovered[0];

    expect(close?.['output']).toEqual({
      type: 'single',
      single: { dataType: { type: 'list', list: { elementsType: { type: 'ontologyEdit', ontologyEdit: {} } } } },
    });

    expect(close?.['ontologyProvenance']).toEqual({
      editedLinks: {},
      editedObjects: { 'com.example.twin.Account': {}, 'com.example.twin.Engagement': {} },
      editedInterfaces: {},
    });
  });

  it('ontology/functions/functions#discovery, ontology/functions/edit-functions#provenance: each editedLinks key is the Link Type API name', async () => {
    const linkEdit = [
      'import type { Client, Osdk } from "@osdk/client";',
      'import type { Edits } from "@osdk/functions";',
      'import { Account } from "@ontology/sdk";',
      '',
      'export default function probeEditFkLink(client: Client, account: Osdk.Instance<Account>): Edits.Link<Account, "engagements">[] {',
      '  return [];',
      '}',
      'export const config = { apiName: "probeEditFkLink" };',
      '',
    ].join('\n');

    const sdk = readFileSync(join(ROOT, 'packages/service/twin/functions/src/sdk.ts'), 'utf8');

    const withLink = sdk.replace(
      /(interface Common \{[\s\S]*?)links: None;/,
      '$1links: { engagements: { __OsdkLinkTargetType?: unknown; targetType: "com.example.twin.Engagement"; multiplicity: true } };',
    );

    expect(withLink).not.toBe(sdk);

    const result = await validate(
      twinFunctionsApp({
        'functions/typescript-functions/src/functions/probeEditFkLink.ts': linkEdit,
        'functions/typescript-functions/node_modules/@ontology/sdk/index.ts': withLink,
      }),
    );

    expect(result.stderr).toBe('');

    const ours = result.functions?.discovered.find((fn) => functionName(fn) === 'probeEditFkLink');

    expect(ours?.['ontologyProvenance']).toEqual({
      editedLinks: { accountToEngagements: {} },
      editedObjects: {},
      editedInterfaces: {},
    });
  });

  it('ontology/functions/functions#discovery: the editedLinks key of a many-to-many Link Type is its API name too', async () => {
    const m2m = [
      'defineLink({',
      '    apiName: "engagementSponsors",',
      '    many: { object: engagement, metadata: { apiName: "sponsors", displayName: "Sponsor", pluralDisplayName: "Sponsors", visibility: "NORMAL" } },',
      '    toMany: { object: account, metadata: { apiName: "sponsoredEngagements", displayName: "Sponsored Engagement", pluralDisplayName: "Sponsored Engagements", visibility: "NORMAL" } },',
      '    editsEnabled: true,',
      '});',
      '',
    ].join('\n');

    const linkEdit = [
      'import type { Client, Osdk } from "@osdk/client";',
      'import type { Edits } from "@osdk/functions";',
      'import { Account } from "@ontology/sdk";',
      '',
      'export default function probeEditLinks(client: Client, account: Osdk.Instance<Account>): Edits.Link<Account, "sponsoredEngagements">[] {',
      '  return [];',
      '}',
      'export const config = { apiName: "probeEditLinks" };',
      '',
    ].join('\n');

    const sdk = readFileSync(join(ROOT, 'packages/service/twin/functions/src/sdk.ts'), 'utf8');

    const withLink = sdk.replace(
      /(interface Common \{[\s\S]*?)links: None;/,
      '$1links: { sponsoredEngagements: { __OsdkLinkTargetType?: unknown; targetType: "com.example.twin.Engagement"; multiplicity: true } };',
    );

    expect(withLink).not.toBe(sdk);

    const result = await validate(
      twinFunctionsApp({
        'ontology/src/ontology.mts': `${twinOntology('0.7.0')}\n${m2m}`,
        'functions/typescript-functions/src/functions/probeEditLinks.ts': linkEdit,
        'functions/typescript-functions/node_modules/@ontology/sdk/index.ts': withLink,
      }),
    );

    expect(result.stderr).toBe('');

    const ours = result.functions?.discovered.find((fn) => functionName(fn) === 'probeEditLinks');

    expect(ours?.['ontologyProvenance']).toEqual({
      editedLinks: { engagementSponsors: {} },
      editedObjects: {},
      editedInterfaces: {},
    });
  });

  it('ontology/functions/functions#discovery: an input of string literals is a String with its literals in allowedValues, also when it is optional, aliased, 1 literal, or a list', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      'type Stage = "lead" | "engaged" | "won";',
      'export default function literals(client: Client, stage: "lead" | "engaged" | "won", aliased: Stage, single: "only", stages: Array<"lead" | "won">, after: string, flag: boolean, optionalStage?: "lead" | "won"): string {',
      '  return stage;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/literals.ts': source }),
    );

    expect(result.stderr).toBe('');

    const inputs = result.functions?.discovered.find((fn) => functionName(fn) === 'literals')?.['inputs'];
    const string = { type: 'string', string: {} };

    expect(inputs).toEqual([
      {
        name: 'client',
        dataType: { type: 'client', client: { type: 'ontologySdkClient', ontologySdkClient: {} } },
        constraints: [],
        required: true,
      },
      { name: 'stage', dataType: string, required: true, constraints: [], allowedValues: ['lead', 'engaged', 'won'] },
      { name: 'aliased', dataType: string, required: true, constraints: [], allowedValues: ['lead', 'engaged', 'won'] },
      { name: 'single', dataType: string, required: true, constraints: [], allowedValues: ['only'] },
      {
        name: 'stages',
        dataType: { type: 'list', list: { elementsType: string } },
        required: true,
        constraints: [],
        allowedValues: ['lead', 'won'],
      },
      { name: 'after', dataType: string, required: true, constraints: [] },
      { name: 'flag', dataType: { type: 'boolean', boolean: {} }, required: true, constraints: [] },
      {
        name: 'optionalStage',
        dataType: { type: 'optionalType', optionalType: { wrappedType: string } },
        required: false,
        constraints: [],
        allowedValues: ['lead', 'won'],
      },
    ]);
  });

  it('ontology/functions/functions#discovery: a string enum input is not a union of string literals, so validate stops', async () => {
    const source =
      'import type { Client } from "@osdk/client";\nexport enum Stage { Lead = "lead", Won = "won" }\nexport default function enumInput(client: Client, stage: Stage): string {\n  return stage;\n}\n';

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/enumInput.ts': source }),
    );

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stderr)).toEqual({
      message: 'Function enumInput, input stage: "Stage" is not a supported type.',
    });
  });

  it('ontology/functions/functions#discovery: a list of an interface is a list of a functionCustomType, with the fields and fieldMetadata of the interface', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      'import type { Integer } from "@osdk/functions";',
      'interface Row { rowId: string; label: string; count: Integer; note?: string; op: string }',
      'export default function applyRowProbes(client: Client, rows: Row[]): string {',
      '  return String(rows.length);',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/applyRowProbes.ts': source }),
    );

    expect(result.stderr).toBe('');

    const fn = result.functions?.discovered.find((discovered) => functionName(discovered) === 'applyRowProbes');
    const id = 'd13fa112-eb39-574f-8791-ebaaa7a823f8';

    expect((fn?.['inputs'] as { name: string }[] | undefined)?.find((input) => input.name === 'rows')).toMatchObject({
      name: 'rows',
      dataType: { type: 'list', list: { elementsType: { type: 'functionCustomType', functionCustomType: id } } },
    });

    const string = { type: 'string', string: {} };

    expect((fn?.['customTypes'] as Record<string, unknown> | undefined)?.[id]).toMatchObject({
      locator: { interfaceName: 'Row' },
      fields: {
        rowId: string,
        label: string,
        count: { type: 'integer', integer: {} },
        note: { type: 'optionalType', optionalType: { wrappedType: string } },
        op: string,
      },
      fieldMetadata: {
        rowId: { required: true },
        label: { required: true },
        count: { required: true },
        note: { required: false },
        op: { required: true },
      },
    });
  });

  it('ontology/functions/functions#discovery: a Decimal input, a Decimal[] input, an optional Decimal input, and a Decimal field of a struct list row each discover as decimal', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      'import type { Decimal } from "./decimal.ts";',
      'interface Line { lineId: string; unitPrice: Decimal; discount?: Decimal }',
      'export default function priceLines(client: Client, rate: Decimal, rates: Decimal[], lines: Line[], cap?: Decimal): string {',
      '  return rate;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({
        'functions/typescript-functions/src/functions/decimal.ts':
          'export type Decimal<T extends string = string> = T & { __decimalBrand?: void };\n',
        'functions/typescript-functions/src/functions/priceLines.ts': source,
      }),
    );

    expect(result.stderr).toBe('');

    const fn = result.functions?.discovered.find((discovered) => functionName(discovered) === 'priceLines');
    const decimal = { type: 'decimal', decimal: {} };
    const optionalDecimal = { type: 'optionalType', optionalType: { wrappedType: decimal } };
    const lineTypeId = Object.keys((fn?.['customTypes'] as Record<string, unknown> | undefined) ?? {})[0] ?? '';

    expect(fn?.['inputs']).toEqual([
      {
        name: 'client',
        dataType: { type: 'client', client: { type: 'ontologySdkClient', ontologySdkClient: {} } },
        constraints: [],
        required: true,
      },
      { name: 'rate', dataType: decimal, required: true, constraints: [] },
      { name: 'rates', dataType: { type: 'list', list: { elementsType: decimal } }, required: true, constraints: [] },
      {
        name: 'lines',
        dataType: {
          type: 'list',
          list: { elementsType: { type: 'functionCustomType', functionCustomType: lineTypeId } },
        },
        required: true,
        constraints: [],
      },
      { name: 'cap', dataType: optionalDecimal, required: false, constraints: [] },
    ]);

    expect((fn?.['customTypes'] as Record<string, unknown> | undefined)?.[lineTypeId]).toMatchObject({
      locator: { interfaceName: 'Line' },
      fields: { lineId: { type: 'string', string: {} }, unitPrice: decimal, discount: optionalDecimal },
      fieldMetadata: { lineId: { required: true }, unitPrice: { required: true }, discount: { required: false } },
    });
  });

  it('ontology/action-types/action-types#out-of-scope: a list of an inline object type stops discovery, and the message ends with is not a supported type.', async () => {
    const source =
      'import type { Client } from "@osdk/client";\nexport default function inlineRows(client: Client, rows: { rowId: string; label: string }[]): string {\n  return String(rows.length);\n}\n';

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/inlineRows.ts': source }),
    );

    expect(result.code).toBe(1);
    expect((JSON.parse(result.stderr) as { message: string }).message).toMatch(/is not a supported type\.$/);
    expect(result.functions).toBeUndefined();
  });

  it('ontology/functions/functions#discovery: allowedValues keep the order of the source, also when an earlier file names the literals in another order', async () => {
    const fn = (name: string, union: string) =>
      `import type { Client } from "@osdk/client";\nexport default function ${name}(client: Client, stage: ${union}): string {\n  return stage;\n}\n`;

    const result = await validate(
      twinFunctionsApp({
        'functions/typescript-functions/src/functions/a.ts': fn('a', '"won" | "lead"'),
        'functions/typescript-functions/src/functions/b.ts': fn('b', '"lead" | "won"'),
      }),
    );

    expect(result.stderr).toBe('');

    const allowed = (name: string) =>
      (
        result.functions?.discovered.find((found) => functionName(found) === name)?.['inputs'] as
          { allowedValues?: string[] }[] | undefined
      )?.[1]?.allowedValues;

    expect(allowed('a')).toEqual(['won', 'lead']);
    expect(allowed('b')).toEqual(['lead', 'won']);
  });

  it('ontology/functions/functions#discovery/10739002: a @param tag gives the description of the input, with the leading - removed', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      '/**',
      ' * Closes the deal.',
      ' * @param client - The client.',
      ' * @param dealId - The deal to close.',
      ' * @param note A note with no hyphen.',
      ' * @param reason - The first line,',
      ' *   and the second line.',
      ' * @param stage - The first tag.',
      ' * @param stage - The second tag.',
      ' * @param ghost - No input has this name.',
      ' */',
      'export default function closeDeal(client: Client, dealId: string, note: string, reason: string, stage: string, plain: string): string {',
      '  return dealId;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/closeDeal.ts': source }),
    );

    expect(result.stderr).toBe('');

    const fn = result.functions?.discovered.find((found) => functionName(found) === 'closeDeal');

    const descriptions = (fn?.['inputs'] as { name: string; description?: string }[] | undefined)?.map(
      ({ name, description }) => [name, description],
    );

    expect(descriptions).toEqual([
      ['client', undefined],
      ['dealId', 'The deal to close.'],
      ['note', 'A note with no hyphen.'],
      ['reason', 'The first line,\nand the second line.'],
      ['stage', 'The first tag.\nThe second tag.'],
      ['plain', undefined],
    ]);

    expect((fn?.['inputs'] as object[] | undefined)?.at(-1)).not.toHaveProperty('description');
    expect(fn?.['documentation']).toBe('Closes the deal.');
  });

  it('ontology/functions/functions#discovery/10739002: the CLI removes only the "- " separator, so a text that starts with a hyphen keeps it', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      '/**',
      ' * Reads the deal.',
      ' * @param a - text',
      ' * @param b -1 means none.',
      ' * @param c -- double',
      ' * @param d -',
      ' */',
      'export default function readDeal(client: Client, a: string, b: string, c: string, d: string): string {',
      '  return a;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/readDeal.ts': source }),
    );

    expect(result.stderr).toBe('');

    const fn = result.functions?.discovered.find((found) => functionName(found) === 'readDeal');

    expect(
      (fn?.['inputs'] as { name: string; description?: string }[] | undefined)?.map(({ name, description }) => [
        name,
        description,
      ]),
    ).toEqual([
      ['client', undefined],
      ['a', 'text'],
      ['b', '-1 means none.'],
      ['c', '-- double'],
      ['d', undefined],
    ]);
  });

  it('ontology/functions/functions#discovery/10739002: a @param tag with only a hyphen gives no description, and a source with CRLF line ends gives the descriptions of LF line ends', async () => {
    const lines = [
      'import type { Client } from "@osdk/client";',
      '/**',
      ' * Closes the deal.',
      ' * The second line.',
      ' * @param dealId -',
      ' * @param reason - The first line,',
      ' *   and the second line.',
      ' */',
      'export default function closeDeal(client: Client, dealId: string, reason: string): string {',
      '  return dealId;',
      '}',
      '',
    ];

    const discovered = async (lineEnd: string) => {
      const result = await validate(
        twinFunctionsApp({ 'functions/typescript-functions/src/functions/closeDeal.ts': lines.join(lineEnd) }),
      );

      expect(result.stderr).toBe('');

      const fn = result.functions?.discovered.find((found) => functionName(found) === 'closeDeal');

      return {
        inputs: (fn?.['inputs'] as { name: string; description?: string }[] | undefined)?.map(
          ({ name, description }) => [name, description],
        ),
        documentation: fn?.['documentation'],
      };
    };

    const lf = await discovered('\n');

    expect(lf).toEqual({
      inputs: [
        ['client', undefined],
        ['dealId', undefined],
        ['reason', 'The first line,\nand the second line.'],
      ],
      documentation: 'Closes the deal.\nThe second line.',
    });

    expect(await discovered('\r\n')).toEqual(lf);
  });

  it('ontology/functions/functions#discovery/10739002: a @param tag gives the description of a Query Function input in the same field', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      '/**',
      ' * The amount of a deal.',
      ' * @param dealId - The deal to read.',
      ' */',
      'export default async function dealAmount(client: Client, dealId: string): Promise<string> {',
      '  return dealId;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/dealAmount.ts': source }),
    );

    expect(result.stderr).toBe('');

    const fn = result.functions?.discovered.find((found) => functionName(found) === 'dealAmount');

    expect((fn?.['inputs'] as object[] | undefined)?.[1]).toEqual({
      name: 'dealId',
      dataType: { type: 'string', string: {} },
      required: true,
      constraints: [],
      description: 'The deal to read.',
    });
  });

  it('ontology/functions/query-functions#discovery: Promise<T | undefined> is an optional output, and an optional field of a struct output is an optional field', async () => {
    const result = await validate(
      twinFunctionsApp({
        'functions/typescript-functions/src/functions/decimal.ts':
          'export type Decimal<T extends string = string> = T & { __decimalBrand?: void };\n',
        'functions/typescript-functions/src/functions/amountLeft.ts': [
          'import type { Client } from "@osdk/client";',
          'import type { Decimal } from "./decimal.ts";',
          '/** The amount left. */',
          'export default async function amountLeft(client: Client): Promise<Decimal | undefined> {',
          '  return undefined;',
          '}',
          '',
        ].join('\n'),
        'functions/typescript-functions/src/functions/feedCheck.ts': [
          'import type { Client } from "@osdk/client";',
          'interface Check { mismatch: string; note?: string }',
          '/** The feed check. */',
          'export default async function feedCheck(client: Client): Promise<Check> {',
          '  return { mismatch: "0" };',
          '}',
          '',
        ].join('\n'),
      }),
    );

    expect(result.stderr).toBe('');

    const found = (name: string) => result.functions?.discovered.find((fn) => functionName(fn) === name);
    const string = { type: 'string', string: {} };

    expect(found('amountLeft')?.['output']).toEqual({
      type: 'single',
      single: { dataType: { type: 'optionalType', optionalType: { wrappedType: { type: 'decimal', decimal: {} } } } },
    });

    const check = found('feedCheck');
    const id = Object.keys((check?.['customTypes'] as Record<string, unknown> | undefined) ?? {})[0] ?? '';

    expect(check?.['output']).toEqual({
      type: 'single',
      single: { dataType: { type: 'functionCustomType', functionCustomType: id } },
    });

    expect((check?.['customTypes'] as Record<string, unknown> | undefined)?.[id]).toMatchObject({
      fields: { mismatch: string, note: { type: 'optionalType', optionalType: { wrappedType: string } } },
      fieldMetadata: { mismatch: { required: true }, note: { required: false } },
    });
  });

  it('ontology/functions/query-functions#outputs: an output of another union stops validate with a text that names the type and the Function', async () => {
    const source =
      'import type { Client } from "@osdk/client";\nexport default async function either(client: Client): Promise<string | number> {\n  return 1;\n}\n';

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/either.ts': source }),
    );

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stderr)).toEqual({
      message: 'Function either, output: "string | number" is not a supported type.',
    });

    expect(result.functions).toBeUndefined();
  });

  it.each([
    ['nullable', 'Promise<string | null>', 'string | null'],
    ['nullableOptional', 'Promise<string | null | undefined>', 'string | null | undefined'],
  ])(
    'ontology/functions/query-functions#outputs: the output %s is a union other than T | undefined, so validate stops with a text that names the type and the Function',
    async (name, returns, shown) => {
      const source = `import type { Client } from "@osdk/client";\nexport default async function ${name}(client: Client): ${returns} {\n  return null;\n}\n`;

      const result = await validate(
        twinFunctionsApp({ [`functions/typescript-functions/src/functions/${name}.ts`]: source }),
      );

      expect(result.code).toBe(1);

      expect(JSON.parse(result.stderr)).toEqual({
        message: `Function ${name}, output: "${shown}" is not a supported type.`,
      });

      expect(result.functions).toBeUndefined();
    },
  );

  it('ontology/functions/query-functions#outputs: a field of a struct output that is string | null keeps the optional field of the staging CLI, as the spec is silent on null', async () => {
    const source =
      'import type { Client } from "@osdk/client";\ninterface Row { note: string | null }\nexport default async function row(client: Client): Promise<Row> {\n  return { note: null };\n}\n';

    const result = await validate(twinFunctionsApp({ 'functions/typescript-functions/src/functions/row.ts': source }));

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('ontology/functions/query-functions#outputs: an optional list of edits is an edit Function output, so validate stops with a text that names the type and the Function', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      'import type { Edits } from "@osdk/functions";',
      'import { Account } from "@ontology/sdk";',
      'export default async function maybeEdits(client: Client): Promise<Edits.Object<Account>[] | undefined> {',
      '  return undefined;',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/maybeEdits.ts': source }),
    );

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stderr)).toMatchObject({
      message: expect.stringMatching(/^Function maybeEdits, output: ".*" is not a supported type\.$/),
    });

    expect(result.functions).toBeUndefined();
  });

  it('ontology/functions/functions#discovery: the compiler uses the tsconfig.json of the Functions folder, or else the one of its parent folder', async () => {
    const own = JSON.stringify({
      compilerOptions: (JSON.parse(FUNCTIONS_TSCONFIG) as { compilerOptions: unknown }).compilerOptions,
      files: ['closeAccount.ts'],
    });

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/tsconfig.json': own }),
    );

    expect(result.stderr).toBe('');
    expect(result.functions?.discovered.map((fn) => filePath(fn))).toEqual(['closeAccount.ts']);

    const none = await validate(twinFunctionsApp({ 'functions/typescript-functions/src/tsconfig.json': '' }));

    expect(none.code).toBe(1);

    expect(JSON.parse(none.stderr)).toEqual({
      message: 'The tsconfig.json of the Functions, src/tsconfig.json, is empty.',
    });

    expect(none.functions).toBeUndefined();
  });
});

describe('test files', () => {
  it('ontology/functions/functions#discovery: the CLI has no filter for test files, so a test file with a default export gives a Function', async () => {
    const source = ANONYMOUS_TEST_FILE.replace(/\nexport const config = \{[\s\S]*?\};\n/, '\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/__tests__/probeTestFile.test.ts': source }),
    );

    expect(result.stderr).toBe('');

    const found = result.functions?.discovered.find((fn) => filePath(fn)?.includes('__tests__'));

    expect(found).toMatchObject({
      locator: {
        type: 'typescript',
        typescript: { filePath: 'functions/__tests__/probeTestFile.test.ts', functionName: 'probeTestFile.test' },
      },
      ontologyProvenance: { editedLinks: {}, editedObjects: { 'com.example.twin.Account': {} }, editedInterfaces: {} },
    });
  });

  it('ontology/functions/functions#discovery: a named default export has the file name, else the CLI stops with an error that names the file and the rule', async () => {
    const result = await validate(
      twinFunctionsApp({
        'functions/typescript-functions/src/functions/__tests__/probeTestFile.test.ts': NAMED_TEST_FILE,
      }),
    );

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stderr)).toEqual({
      message:
        'functions/__tests__/probeTestFile.test.ts: the default export function probeTestFile must have the name of its file, probeTestFile.test, as Functions "Discovery" specifies. Rename the function or the file.',
    });

    expect(result.functions).toBeUndefined();
  });
});

describe('the Function bundle', () => {
  it('ontology/functions/functions#discovery: a Function that needs a module of Node.js gives no bundle, and validate stops', async () => {
    const source = [
      'import type { Client } from "@osdk/client";',
      'import { readFileSync } from "fs";',
      'export default function readsFile(client: Client, path: string): string {',
      '  return readFileSync(path, "utf8");',
      '}',
      '',
    ].join('\n');

    const result = await validate(
      twinFunctionsApp({ 'functions/typescript-functions/src/functions/readsFile.ts': source }),
    );

    expect(result.code).toBe(1);

    expect(JSON.parse(result.stderr)).toEqual({
      message:
        'The Function bundle imports fs. A Function bundle holds each package that it uses, and no native module.',
    });

    expect(result.functions).toBeUndefined();
  });

  it('ontology/functions/functions#discovery: the CLI bundles all Functions into 1 module that imports nothing, and exports functions and createClient', async () => {
    const result = await validateTwin();

    const bundle = result.functions?.bundle ?? '';

    expect(bundle).not.toMatch(/^\s*import\s/m);
    expect(bundle).not.toMatch(/\brequire\(/);

    const module = (await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`)) as {
      functions: Record<string, unknown>;
      createClient: unknown;
    };

    expect(Object.keys(module).sort()).toEqual(['createClient', 'functions']);
    expect(Object.keys(module.functions)).toEqual([...TWIN_FUNCTIONS]);
    expect(Object.values(module.functions).every((fn) => typeof fn === 'function')).toBe(true);
    expect(typeof module.createClient).toBe('function');
  });
});
