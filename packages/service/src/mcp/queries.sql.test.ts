import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { startActions, type ActionsService, type SendOptions } from '../actions/actions.test-utils.ts';
import { actionOf, withFunctions } from '../functions/functions.test-utils.ts';
import { NS, ONTOLOGY_RID, twinIr, USE } from '../ontology/stored.test-utils.ts';
import { claimsOf } from '../people.test-utils.ts';
import { asPerson } from '../policiesPeople.test-utils.ts';
import type { DiscoveredFunction } from '../publish/index.ts';
import { splitGrants } from '../roles.test-utils.ts';
import { CANARY, routeSpans } from '../routeHarness.test-utils.ts';

const TOOLS = 'service/ontology-mcp#tools';
const ACCESS = 'service/authentication#access';
const ACCOUNT = `${NS}Account`;
const ENGAGEMENT = `${NS}Engagement`;
const ONTOLOGY = `/api/v2/ontologies/${ONTOLOGY_RID}`;
const ADMIN = 'twin:admin';
const TITLES = 'twin:titles';
const ROLES = { admin: ['ontology:install', ADMIN, USE, TITLES], member: [USE, TITLES], auditor: [TITLES] };

const string = { type: 'string', string: {} };
const decimal = { type: 'decimal', decimal: {} };
const integer = { type: 'integer', integer: {} };
const date = { type: 'date', date: {} };
const objectOf = (objectTypeId: string) => ({ type: 'object', object: { objectTypeId } });
const list = (elementsType: object) => ({ type: 'list', list: { elementsType } });
const optional = (wrappedType: object) => ({ type: 'optionalType', optionalType: { wrappedType } });
const struct = (fields: Record<string, object>) => ({ type: 'anonymousCustomType', anonymousCustomType: { fields } });

interface Input {
  readonly name: string;
  readonly dataType: object;
  readonly description?: string;
}

function query(
  functionName: string,
  documentation: string,
  output: object,
  inputs: readonly Input[] = [],
): DiscoveredFunction {
  return {
    locator: { type: 'typescript', typescript: { functionName } },
    inputs: [{ name: 'client', dataType: { type: 'client', client: {} } }, ...inputs],
    output: { type: 'single', single: { dataType: output } },
    customTypes: {},
    documentation,
  } as DiscoveredFunction;
}

const QUERIES = [
  query('engagementTitle', 'The title of an Engagement.\nIt reads as the caller.', string, [
    { name: 'engagement', dataType: objectOf(ENGAGEMENT), description: 'The Engagement to read.' },
  ]),
  query('accountName', 'The name of an Account.', string, [{ name: 'account', dataType: objectOf(ACCOUNT) }]),
  query('echo', 'The text of its input.', string, [{ name: 'text', dataType: string }]),
  query(
    'scenario',
    'The runway of a balance.',
    optional(list(struct({ days: integer, balance: decimal, runwayDate: optional(date) }))),
    [
      { name: 'balance', dataType: decimal, description: 'The balance today.' },
      { name: 'note', dataType: optional(string) },
      { name: 'engagements', dataType: list(objectOf(ENGAGEMENT)) },
    ],
  ),
  query('secretSummary', 'A summary that only an admin sees.', string),
];

const SOURCE = `
export const functions = {
  applyEdits: async () => [],
  echo: async (_client, text) => text,
  scenario: async (_client, balance, _note, engagements) => [{ days: engagements.length, balance }],
  secretSummary: async () => 'secret',
};
`;

type Person = 'admin' | 'member' | 'auditor';

function asCaller(person: Person): SendOptions {
  return person === 'auditor'
    ? asPerson({ sub: 'user_auditor', role: 'auditor' }, ROLES)
    : { claims: claimsOf(person) };
}

let service: ActionsService;
let consoleLog: MockInstance<typeof console.log>;

beforeAll(async () => {
  const { ir, functions } = await withFunctions(
    [{ apiName: 'applyEdits', inputs: [], edits: [ACCOUNT, ENGAGEMENT] }],
    SOURCE,
    twinIr('0.7.0'),
  );

  const split = splitGrants(ir);

  const grants = {
    ...split,
    permissions: { ...split.permissions, [TITLES]: { description: 'Read the titles of Engagements' } },
    actionTypes: { ...split.actionTypes, [actionOf('applyEdits')]: ADMIN },
    queryTypes: { engagementTitle: TITLES, accountName: ADMIN, echo: USE, scenario: USE, secretSummary: ADMIN },
    defaultRoles: { admin: ROLES.admin, member: ROLES.member },
  };

  service = await startActions(ir, { ...functions, discovered: [...functions.discovered, ...QUERIES] }, grants);
});

afterAll(() => service?.stop());

beforeEach(() => {
  consoleLog = vi.spyOn(console, 'log');
});

afterEach(() => {
  consoleLog.mockRestore();
});

async function call(person: Person, name: string, args: object): Promise<CallToolResult> {
  const answer = await service.tool(name, args, asCaller(person));

  return (answer.body as { result: CallToolResult }).result;
}

const INSTANCE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function masked(person: Person, name: string, args: object): Promise<unknown> {
  return JSON.parse(JSON.stringify(await call(person, name, args)).replace(INSTANCE_ID, '<id>')) as unknown;
}

async function runRoute(person: Person, name: string, body: object): Promise<unknown> {
  const { text } = await service.call('POST', `${ONTOLOGY}/queries/${name}/execute`, body, asCaller(person));

  return JSON.parse(text.replace(INSTANCE_ID, '<id>')) as unknown;
}

async function workerSpans(): Promise<string[]> {
  return (await routeSpans())
    .map((span) => span.name)
    .filter((name) => ['function run', 'worker call', 'function body'].includes(name));
}

describe('describe_query', () => {
  it(`${TOOLS}: with no name, lists each Query Function of the caller's view with its API name and full description, and no edit Function`, async () => {
    expect((await call('admin', 'describe_query', {})).structuredContent).toEqual({
      queries: [
        'accountName: The name of an Account.',
        'echo: The text of its input.',
        'engagementTitle: The title of an Engagement.\nIt reads as the caller.',
        'scenario: The runway of a balance.',
        'secretSummary: A summary that only an admin sees.',
      ],
    });
  });

  it(`${TOOLS}: with a name, gives each input with its type, required flag, and description, and the output type, with "Decimal" for a Decimal`, async () => {
    const result = await call('admin', 'describe_query', { query: 'scenario' });

    expect(result.isError).toBeFalsy();

    expect(result.structuredContent).toEqual({
      apiName: 'scenario',
      description: 'The runway of a balance.',
      inputs: [
        { id: 'balance', type: 'Decimal', required: true, description: 'The balance today.' },
        { id: 'note', type: 'String', required: false },
        { id: 'engagements', type: `list of ${ENGAGEMENT}`, required: false },
      ],
      output: 'list of { days: Integer, balance: Decimal, runwayDate?: Date } or null',
    });

    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it(`${TOOLS}: agrees with GET queryTypes/{queryApiName} on each input, its required flag, and the output, except for "Decimal"`, async () => {
    const { queries } = (await call('admin', 'describe_query', {})).structuredContent as { queries: string[] };

    for (const name of queries.map((line) => line.split(':')[0] ?? '')) {
      const described = (await call('admin', 'describe_query', { query: name })).structuredContent as {
        inputs: { id: string; type: string; required: boolean }[];
        output: string;
      };

      const { text } = await service.call('GET', `${ONTOLOGY}/queryTypes/${name}`, undefined, {
        claims: claimsOf('admin'),
      });

      const metadata = JSON.parse(text) as {
        parameters: Record<string, { dataType: DataType; required: boolean }>;
        output: DataType;
      };

      const asMetadata = (type: string) => type.replaceAll('Decimal', 'String');

      const inputs = Object.fromEntries(
        described.inputs.map(({ id, type, required }) => [id, { type: asMetadata(type), required }]),
      );

      expect(inputs, name).toEqual(
        Object.fromEntries(
          Object.entries(metadata.parameters).map(([id, { dataType, required }]) => [
            id,
            { type: textOf(dataType), required },
          ]),
        ),
      );

      expect(asMetadata(described.output), name).toBe(textOf(metadata.output, true));
    }
  });
});

interface DataType {
  readonly type: string;
  readonly subType?: DataType;
  readonly objectApiName?: string;
  readonly unionTypes?: readonly DataType[];
  readonly fields?: readonly { readonly name: string; readonly fieldType: DataType }[];
}

function textOf(dataType: DataType, output = false): string {
  const [first, second] = dataType.unionTypes ?? [];

  if (dataType.type === 'union' && first && second?.type === 'null')
    return output ? `${textOf(first)} or null` : textOf(first);

  if (dataType.type === 'object') return dataType.objectApiName ?? '';

  if (dataType.type === 'array' && dataType.subType) return `list of ${textOf(dataType.subType)}`;

  if (dataType.type === 'struct') {
    const fields = (dataType.fields ?? []).map(
      ({ name, fieldType }) => `${name}${fieldType.type === 'union' ? '?' : ''}: ${textOf(fieldType)}`,
    );

    return `{ ${fields.join(', ')} }`;
  }

  return `${dataType.type.charAt(0).toUpperCase()}${dataType.type.slice(1)}`;
}

describe('execute_query', () => {
  it(`${TOOLS}: runs the run route, and gives its { value }, as structuredContent and as the same JSON text`, async () => {
    const result = await call('member', 'execute_query', { query: 'echo', parameters: { text: 'hello' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ value: 'hello' });

    expect(result.structuredContent).toEqual(await runRoute('member', 'echo', { parameters: { text: 'hello' } }));

    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });

  it(`${TOOLS}: with null for a list input, gives the value of the run route, as for [] and for no value`, async () => {
    const answers = [];

    for (const engagements of [null, [], undefined]) {
      const parameters = { balance: '5', ...(engagements === undefined ? {} : { engagements }) };

      const result = await call('member', 'execute_query', { query: 'scenario', parameters });

      expect(result.structuredContent).toEqual(await runRoute('member', 'scenario', { parameters }));

      answers.push(result.structuredContent);
    }

    expect(answers).toStrictEqual(Array.from({ length: 3 }, () => ({ value: [{ days: 0, balance: '5' }] })));
  });

  it.each([
    ['an unknown name', 'noSuchQuery', { parameters: {} }],
    ['no parameters', 'echo', {}],
  ])(
    `${TOOLS} service/ontology-mcp#errors: with %s, gives the error body of the run route as a tool error`,
    async (_case, name, body) => {
      const result = await call('member', 'execute_query', { query: name, ...body });

      expect(result.isError).toBe(true);

      const route = await runRoute('member', name, body);

      expect(route).toMatchObject({ errorCode: expect.any(String) });
      expect({ ...result.structuredContent, errorInstanceId: '<id>' }).toEqual(route);
    },
  );

  it(`${TOOLS} service/ontology-mcp#errors: with a wrong input type, gives the body of 400 InvalidQueryParameterValue of the run route as a tool error`, async () => {
    const result = await call('member', 'execute_query', { query: 'echo', parameters: { text: 5 } });

    expect(result.isError).toBe(true);

    const route = await runRoute('member', 'echo', { parameters: { text: 5 } });

    expect(route).toEqual({
      errorCode: 'INVALID_ARGUMENT',
      errorName: 'InvalidQueryParameterValue',
      errorInstanceId: '<id>',
      parameters: { parameterDataType: { type: 'string' }, parameterId: 'text', parameterValue: 5 },
    });

    expect({ ...result.structuredContent, errorInstanceId: '<id>' }).toEqual(route);
  });

  it('service/observability#traces service/observability#logs: no span and no log line holds an input or the value of execute_query', async () => {
    const result = await call('member', 'execute_query', { query: 'echo', parameters: { text: CANARY } });

    expect(result.structuredContent).toEqual({ value: CANARY });

    const spans = await routeSpans();

    expect(spans.map((span) => span.name)).toContain('function run');
    expect(JSON.stringify(spans.map((span) => [span.name, span.attributes]))).not.toContain(CANARY);

    const lines = consoleLog.mock.calls.map(([line]) => String(line));

    expect(lines.some((line) => line.includes('"tools/call"'))).toBe(true);
    expect(lines.join('\n')).not.toContain(CANARY);
  });
});

describe('the business map of describe_object_type with no objectType', () => {
  it(`${TOOLS}: puts each Query Function under each Object Type that an input takes, else in the other Query Functions, with the first line of its description`, async () => {
    const map = (await call('admin', 'describe_object_type', {})).structuredContent as {
      objectTypes: Record<string, { queryFunctions: string[] }>;
      otherQueryFunctions: string[];
    };

    expect(map.objectTypes[ACCOUNT]?.queryFunctions).toEqual(['accountName: The name of an Account.']);

    expect(map.objectTypes[ENGAGEMENT]?.queryFunctions).toEqual([
      'engagementTitle: The title of an Engagement.',
      'scenario: The runway of a balance.',
    ]);

    expect(map.otherQueryFunctions).toEqual([
      'echo: The text of its input.',
      'secretSummary: A summary that only an admin sees.',
    ]);
  });
});

describe('a caller without the permissions of a Query Function', () => {
  const hidden = ['accountName', 'secretSummary', 'applyEdits'];

  it(`${ACCESS} ${TOOLS}: does not see it in describe_query or the business map, and no answer names the hidden Account`, async () => {
    const list = await call('member', 'describe_query', {});

    expect(list.structuredContent).toEqual({
      queries: [
        'echo: The text of its input.',
        'engagementTitle: The title of an Engagement.\nIt reads as the caller.',
        'scenario: The runway of a balance.',
      ],
    });

    const map = await call('member', 'describe_object_type', {});

    expect(map.structuredContent).toMatchObject({
      objectTypes: {
        [ENGAGEMENT]: {
          queryFunctions: ['engagementTitle: The title of an Engagement.', 'scenario: The runway of a balance.'],
        },
      },
      otherQueryFunctions: ['echo: The text of its input.'],
    });

    const described = await Promise.all(
      ['echo', 'engagementTitle', 'scenario'].map((name) => call('member', 'describe_query', { query: name })),
    );

    expect(JSON.stringify([list, map, described])).not.toMatch(/Account|account|secretSummary|applyEdits/);
  });

  it.each(['describe_query', 'execute_query'])(
    `${ACCESS} ${TOOLS}: %s answers a hidden Query Function and an edit Function as an unknown name, and runs no Function code`,
    async (tool) => {
      const args = (name: string) => (tool === 'describe_query' ? { query: name } : { query: name, parameters: {} });

      const unknown = await masked('member', tool, args('noSuchQuery'));

      expect(unknown).toMatchObject({
        isError: true,
        structuredContent: { errorName: 'QueryNotFound', parameters: { query: 'noSuchQuery' } },
      });

      for (const name of hidden)
        expect(await masked('member', tool, args(name)), name).toEqual(
          JSON.parse(JSON.stringify(unknown).replaceAll('noSuchQuery', name)),
        );

      expect(await masked('admin', tool, args('applyEdits'))).toEqual(
        JSON.parse(JSON.stringify(unknown).replaceAll('noSuchQuery', 'applyEdits')),
      );

      expect(await workerSpans()).toEqual([]);

      expect(
        (await call('admin', 'execute_query', { query: 'secretSummary', parameters: {} })).structuredContent,
      ).toEqual({ value: 'secret' });
    },
  );

  it(`${ACCESS} ${TOOLS}: a caller who holds the permission of engagementTitle but not the permission of Engagement does not see it, and its name gets the answer of an unknown name with no Function code run`, async () => {
    expect((await call('auditor', 'describe_query', {})).structuredContent).toEqual({ queries: [] });

    expect((await call('auditor', 'describe_object_type', {})).structuredContent).toEqual({
      objectTypes: {},
      linkTypes: {},
      otherActionTypes: [],
      otherQueryFunctions: [],
    });

    for (const tool of ['describe_query', 'execute_query']) {
      const args = (name: string) =>
        tool === 'describe_query' ? { query: name } : { query: name, parameters: { engagement: 'eng-1' } };

      const unknown = await masked('auditor', tool, args('noSuchQuery'));

      expect(unknown).toMatchObject({ isError: true, structuredContent: { errorName: 'QueryNotFound' } });

      expect(await masked('auditor', tool, args('engagementTitle')), tool).toEqual(
        JSON.parse(JSON.stringify(unknown).replaceAll('noSuchQuery', 'engagementTitle')),
      );
    }

    expect(await workerSpans()).toEqual([]);

    expect((await call('member', 'describe_query', { query: 'engagementTitle' })).isError).toBeFalsy();
  });
});
