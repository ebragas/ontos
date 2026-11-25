import type { OntologyFullMetadata, QueryTypeV2 } from '@osdk/foundry.ontologies';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { GrantsFile } from './index.ts';
import type { DiscoveredFunction, PublishedFunctions } from '../publish/index.ts';
import { grantsOf, NS, twinFunctions, twinIr, USE } from './stored.test-utils.ts';
import { startMetadata, type MetadataService } from '../metadata.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const IR = twinIr('0.4.0');

const string = { type: 'string', string: {} };
const decimal = { type: 'decimal', decimal: {} };
const account = { type: 'object', object: { objectTypeId: ACCOUNT } };
const list = (elementsType: object) => ({ type: 'list', list: { elementsType } });
const optional = (wrappedType: object) => ({ type: 'optionalType', optionalType: { wrappedType } });
const struct = (fields: Record<string, object>) => ({ type: 'anonymousCustomType', anonymousCustomType: { fields } });

function queryFunction(
  functionName: string,
  documentation: string,
  output: object,
  inputs: object[] = [],
): DiscoveredFunction {
  return {
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [{ name: 'client', dataType: { type: 'client', client: {} } }, ...inputs],
    output: { type: 'single', single: { dataType: output } },
    customTypes: {},
    documentation,
  } as DiscoveredFunction;
}

function amountLeft(description: string): DiscoveredFunction {
  return queryFunction('amountLeft', 'The amount left on an account, as a Decimal.', optional(decimal), [
    { name: 'account', dataType: account, description },
    { name: 'note', dataType: optional(string), description: 'A note.' },
    { name: 'labels', dataType: list(string) },
    { name: 'limit', dataType: decimal },
  ]);
}

function functionsWith(accountDescription: string): PublishedFunctions {
  const twin = twinFunctions('0.4.0');

  const summary = queryFunction(
    'accountSummary',
    'A summary of the accounts.',
    struct({ label: string, note: optional(string), accounts: list(account), amounts: list(decimal) }),
  );

  const secret = queryFunction('secretSummary', 'A summary that only an admin sees.', string);

  return { ...twin, discovered: [...twin.discovered, amountLeft(accountDescription), summary, secret] };
}

const FUNCTIONS = functionsWith('The account to read.');

const GRANTS: GrantsFile = (() => {
  const twin = grantsOf(IR);

  return {
    ...twin,
    permissions: { ...twin.permissions, 'twin:secret': { description: 'Read secret summaries' } },
    queryTypes: { amountLeft: USE, accountSummary: USE, secretSummary: 'twin:secret' },
    defaultRoles: { admin: [...(twin.defaultRoles['admin'] ?? []), 'twin:secret'], member: [USE] },
  };
})();

const RID = expect.stringMatching(/^ri\.function-registry\.main\.function\.[0-9a-f-]{36}$/);
const nullable = (type: object) => ({ type: 'union', unionTypes: [type, { type: 'null' }] });
const ACCOUNT_TYPE = { type: 'object', objectApiName: ACCOUNT, objectTypeApiName: ACCOUNT };

const AMOUNT_LEFT: QueryTypeV2 = {
  apiName: 'amountLeft',
  description: 'The amount left on an account, as a Decimal.',
  rid: RID,
  version: '0.0.0',
  typeReferences: {},
  parameters: {
    account: { description: 'The account to read.', dataType: ACCOUNT_TYPE, required: true },
    note: { description: 'A note.', dataType: nullable({ type: 'string' }), required: false },
    labels: { dataType: nullable({ type: 'array', subType: { type: 'string' } }), required: false },
    limit: { dataType: { type: 'string' }, required: true },
  },
  output: nullable({ type: 'string' }),
} as QueryTypeV2;

const ACCOUNT_SUMMARY: QueryTypeV2 = {
  apiName: 'accountSummary',
  description: 'A summary of the accounts.',
  rid: RID,
  version: '0.0.0',
  typeReferences: {},
  parameters: {},
  output: {
    type: 'struct',
    fields: [
      { name: 'label', fieldType: { type: 'string' } },
      { name: 'note', fieldType: nullable({ type: 'string' }) },
      { name: 'accounts', fieldType: { type: 'array', subType: ACCOUNT_TYPE } },
      { name: 'amounts', fieldType: { type: 'array', subType: { type: 'string' } } },
    ],
  },
} as QueryTypeV2;

let service: MetadataService;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  service = await startMetadata(IR, FUNCTIONS, 'test', GRANTS);
});

afterAll(async () => {
  await service.stop();
});

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => {
  consoleLog.mockRestore();
});

describe('the query types of the Ontology metadata', () => {
  it('ontology/functions/query-functions#ontology-metadata: fullMetadata lists each Query Function that the caller can see under queryTypes, by its API name, as QueryTypeV2, and no edit Function', async () => {
    const { status, body } = await service.get('fullMetadata');

    expect(status).toBe(200);

    expect((body as OntologyFullMetadata).queryTypes).toEqual({
      amountLeft: AMOUNT_LEFT,
      accountSummary: ACCOUNT_SUMMARY,
    });
  });

  it('ontology/functions/query-functions#ontology-metadata: a Decimal is string, an optional input, output, and struct field is union of the type and null with the type first, an Object is object, and a list is array', async () => {
    const { queryTypes } = (await service.get('fullMetadata')).body as OntologyFullMetadata;

    expect([queryTypes['amountLeft']?.parameters['limit']?.dataType, queryTypes['amountLeft']?.output]).toEqual([
      { type: 'string' },
      nullable({ type: 'string' }),
    ]);

    expect(queryTypes['amountLeft']?.parameters['note']?.dataType).toEqual({
      type: 'union',
      unionTypes: [{ type: 'string' }, { type: 'null' }],
    });

    expect(queryTypes['accountSummary']?.output).toMatchObject({
      fields: expect.arrayContaining([{ name: 'note', fieldType: nullable({ type: 'string' }) }]),
    });

    expect(queryTypes['amountLeft']?.parameters['account']?.dataType).toEqual(ACCOUNT_TYPE);

    expect(queryTypes['amountLeft']?.parameters['labels']?.dataType).toEqual(
      nullable({ type: 'array', subType: { type: 'string' } }),
    );
  });

  it('ontology/functions/query-functions#ontology-metadata: the description of each input is the text of its @param tag, and an input with no tag has none', async () => {
    const parameters =
      ((await service.get('fullMetadata')).body as OntologyFullMetadata).queryTypes['amountLeft']?.parameters ?? {};

    expect(
      Object.fromEntries(Object.entries(parameters).map(([name, parameter]) => [name, parameter.description])),
    ).toEqual({ account: 'The account to read.', note: 'A note.', labels: undefined, limit: undefined });
  });
});

describe('the metadata routes of query types', () => {
  it('service/http-api#metadata-routes: GET queryTypes pages each Query Function of the view, in code point order, as GET actionTypes pages', async () => {
    expect(await service.get('queryTypes')).toEqual({ status: 200, body: { data: [ACCOUNT_SUMMARY, AMOUNT_LEFT] } });

    const first = await service.get('queryTypes?pageSize=1');

    expect(first).toEqual({ status: 200, body: { data: [ACCOUNT_SUMMARY], nextPageToken: expect.any(String) } });

    expect(
      await service.get(`queryTypes?pageSize=1&pageToken=${(first.body as { nextPageToken: string }).nextPageToken}`),
    ).toEqual({ status: 200, body: { data: [AMOUNT_LEFT] } });
  });

  it('service/http-api#metadata-routes: GET queryTypes/{queryApiName} gives 1 QueryTypeV2, also with the version 0.0.0', async () => {
    expect(await service.get('queryTypes/amountLeft')).toEqual({ status: 200, body: AMOUNT_LEFT });

    expect(await service.get('queryTypes/amountLeft?version=0.0.0')).toEqual({ status: 200, body: AMOUNT_LEFT });
  });

  it('service/http-api#metadata-routes: a version that is not 0.0.0 gets 404 QueryVersionNotFound, also the number of the Ontology version', async () => {
    for (const version of ['0.0.1', '1.0.0']) {
      expect(await service.get(`queryTypes/amountLeft?version=${version}`)).toEqual({
        status: 404,
        body: {
          errorCode: 'NOT_FOUND',
          errorName: 'QueryVersionNotFound',
          errorInstanceId: expect.any(String),
          parameters: { apiName: 'amountLeft', version },
        },
      });
    }
  });

  it('service/http-api#metadata-routes: an unknown or hidden name with a version gets QueryNotFound first', async () => {
    for (const name of ['noSuchQuery', 'secretSummary']) {
      expect(await service.get(`queryTypes/${name}?version=1.0.0`)).toMatchObject({
        status: 404,
        body: { errorName: 'QueryNotFound', parameters: { query: name } },
      });
    }
  });

  it('service/http-api#metadata-routes: an unknown name, a hidden Query Function, and an edit Function get the same 404 QueryNotFound, and the same body and request log but for the name', async () => {
    const answers = [];

    for (const name of ['noSuchQuery', 'secretSummary', 'closeAccount']) {
      consoleLog.mockClear();

      const { status, body } = await service.get(`queryTypes/${name}`);

      const lines = consoleLog.mock.calls.map(([line]) =>
        String(line)
          .replaceAll(name, '<name>')
          .replaceAll(/"(errorInstanceId|traceId)":"[^"]*"/g, '"$1":"<id>"'),
      );

      answers.push({
        status,
        body: JSON.stringify(body)
          .replaceAll(name, '<name>')
          .replace(/"errorInstanceId":"[^"]*"/, '"errorInstanceId":"<id>"'),
        lines,
      });
    }

    expect(answers[0]).toMatchObject({ status: 404, body: expect.stringContaining('"errorName":"QueryNotFound"') });
    expect(answers[0]?.lines.join('\n')).toContain('"query":"<name>"');
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });
});

function changedAmountLeft(change: (fn: DiscoveredFunction) => DiscoveredFunction): PublishedFunctions {
  return {
    ...FUNCTIONS,
    discovered: FUNCTIONS.discovered.map((fn) =>
      (fn as DiscoveredFunction).locator.typescript?.functionName === 'amountLeft'
        ? change(fn as DiscoveredFunction)
        : fn,
    ),
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );
}

const versionOf = (answer: { status: number; body: unknown }) => [
  answer.status,
  (answer.body as { version?: number }).version,
];

describe('a publish that changes only a Query Function', () => {
  let versionOne: string;

  beforeAll(async () => {
    versionOne = canonical(((await service.get('fullMetadata')).body as OntologyFullMetadata).queryTypes);
  });

  it('service/publish#versions ontology/ontology-sdk/ontology-sdk#ontology-sdk-package: the same publish run again makes no new version, and returns the same metadata, so the same ontologyHash', async () => {
    const [again, third] = [await service.publish(FUNCTIONS), await service.publish(FUNCTIONS)];

    expect([versionOf(again), versionOf(third)]).toEqual([
      [200, 1],
      [200, 1],
    ]);

    const metadataOf = (answer: { body: unknown }) =>
      JSON.stringify((answer.body as { metadata: OntologyFullMetadata }).metadata);

    expect(metadataOf(third)).toBe(metadataOf(again));
  });

  it('service/publish#versions: a change of only a @param text, a doc comment, an output, or an input of a Query Function makes a new version, each time', async () => {
    const changes: [string, PublishedFunctions][] = [
      ['@param text', functionsWith('The account whose amount the query reads.')],
      ['doc comment', changedAmountLeft((fn) => ({ ...fn, documentation: 'The amount left, as a Decimal string.' }))],
      [
        'output',
        changedAmountLeft(
          (fn) => ({ ...fn, output: { type: 'single', single: { dataType: decimal } } }) as DiscoveredFunction,
        ),
      ],
      ['input', changedAmountLeft((fn) => ({ ...fn, inputs: fn.inputs.slice(0, -1) }))],
    ];

    const versions = [];

    for (const [, functions] of changes) versions.push(versionOf(await service.publish(functions)));

    expect(versions).toEqual([
      [200, 2],
      [200, 3],
      [200, 4],
      [200, 5],
    ]);

    const { queryTypes } = (await service.get('fullMetadata')).body as OntologyFullMetadata;

    expect([queryTypes['amountLeft']?.version, Object.keys(queryTypes['amountLeft']?.parameters ?? {}).sort()]).toEqual(
      ['0.0.0', ['account', 'labels', 'note']],
    );
  });

  it('ontology/functions/query-functions#ontology-metadata: the first version and a later version of the same app have byte-equal queryTypes, with no Ontology version inside', async () => {
    const later = await service.publish(FUNCTIONS);

    expect(versionOf(later)).toEqual([200, 6]);

    expect(canonical(((await service.get('fullMetadata')).body as OntologyFullMetadata).queryTypes)).toBe(versionOne);
  });
});
