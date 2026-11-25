import { describe, expect, it } from 'vitest';
import {
  cli,
  stubExchange,
  stubMetadata,
  replay,
  STUB,
  STUB_RID,
  stubConfig,
  stubFetch,
  stubOntologies,
  tempFolder,
  type Call,
  type Handler,
} from './cli.test-utils.ts';

const ACCOUNT = 'com.example.twin.Account';

const ACME = {
  rid: 'ri.ontology.main.ontology.6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7',
  apiName: 'acme',
  displayName: 'Acme',
  description: '',
};

const GLOBEX = {
  rid: 'ri.ontology.main.ontology.7a2d3b4c-5e6f-4071-9b82-a3c4d5e6f708',
  apiName: 'globex',
  displayName: 'Globex',
  description: '',
};

const FLAGS = ['--app', 'twin', '--url', STUB];
const env = { ONTOLOGY_TOKEN: 't' };
const CONFIG_PATH = '/api/ontology-service/v1/client-config';
const LIST_PATH = '/api/v2/ontologies';

const DATA_COMMANDS = [
  ['describe', ['describe']],
  ['objects', ['objects', ACCOUNT, '--page-size', '2', '--order-by', '{"name":"asc"}']],
  [
    'aggregate',
    [
      'aggregate',
      'com.example.twin.Engagement',
      '--select',
      '{"$count":"unordered","amount:sum":"unordered","amount:max":"unordered"}',
      '--group-by',
      '{"status":"exact"}',
    ],
  ],
  [
    'apply',
    [
      'apply',
      'com.example.twin.create-engagement',
      '--parameters',
      '{"engagementId":"eng-7","accountId":"acc-2","title":"Expansion","amount":22000}',
    ],
  ],
  ['history', ['history', ACCOUNT]],
] as const;

function ontologyAt(rid: string): Handler {
  const stubbed = replay(
    stubExchange('client', 1),
    stubExchange('client', 2),
    stubExchange('client', 11),
    stubExchange('client', 14),
    stubExchange('client', 15),
  );

  const base = `/api/v2/ontologies/${rid}`;

  return (call) => {
    const path = new URL(call.url).pathname;

    if (!path.startsWith(`${base}/`)) return undefined;

    if (path === `${base}/fullMetadata`) return Response.json(stubMetadata());

    if (path === `${base}/objectTypes/${ACCOUNT}/editsHistory`) return Response.json({ data: [], totalCount: 0 });

    return stubbed({ ...call, url: call.url.replace(rid, STUB_RID) });
  };
}

const pathOf = ({ url }: Call): string => new URL(url).pathname;
const calledPaths = (calls: readonly Call[]): string[] => calls.map(pathOf);

describe('the Ontology of a data command', () => {
  it.each(DATA_COMMANDS)(
    'service/cli#ontology: with 1 listed Ontology, %s uses its RID, not the product RID',
    async (_, args) => {
      const fetch = stubFetch(stubOntologies(ACME), stubConfig, ontologyAt(ACME.rid));

      const run = await cli([...args, ...FLAGS], { fetch, env });

      expect(run.error).toBeUndefined();
      expect(run.code).toBe(0);
      expect(ACME.rid).not.toBe(STUB_RID);

      const paths = calledPaths(fetch.calls);

      expect(paths.slice(0, 2)).toEqual([CONFIG_PATH, LIST_PATH]);
      expect(fetch.calls[1]?.headers['authorization']).toBe('Bearer t');
      expect(paths.filter((path) => path === LIST_PATH)).toHaveLength(1);

      const dataPaths = paths.slice(2);

      expect(dataPaths.length).toBeGreaterThan(0);
      expect(dataPaths.filter((path) => !path.startsWith(`${LIST_PATH}/${ACME.rid}/`))).toEqual([]);
    },
  );

  it.each(DATA_COMMANDS)(
    'service/cli#ontology: with 2 listed Ontologies and no --ontology, %s stops after List Ontologies and lists the API names',
    async (_, args) => {
      const fetch = stubFetch(stubOntologies(ACME, GLOBEX), stubConfig, ontologyAt(ACME.rid), ontologyAt(GLOBEX.rid));

      const run = await cli([...args, ...FLAGS], { fetch, env });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message:
          'The Organization has more than 1 Ontology, so pass --ontology <apiName> with 1 of these: acme, globex.',
        ontologies: ['acme', 'globex'],
      });

      expect(calledPaths(fetch.calls)).toEqual([CONFIG_PATH, LIST_PATH]);
    },
  );

  it.each(DATA_COMMANDS)('service/cli#ontology: --ontology picks 1 of 2 listed Ontologies for %s', async (_, args) => {
    const fetch = stubFetch(stubOntologies(ACME, GLOBEX), stubConfig, ontologyAt(GLOBEX.rid));

    const run = await cli([...args, '--ontology', 'globex', ...FLAGS], { fetch, env });

    expect(run.error).toBeUndefined();
    expect(run.code).toBe(0);

    const dataPaths = calledPaths(fetch.calls).slice(2);

    expect(dataPaths.length).toBeGreaterThan(0);
    expect(dataPaths.filter((path) => !path.startsWith(`${LIST_PATH}/${GLOBEX.rid}/`))).toEqual([]);
  });

  it('service/cli#ontology: apply with --ontology sends its POST to the chosen Ontology', async () => {
    const fetch = stubFetch(stubOntologies(ACME, GLOBEX), stubConfig, ontologyAt(GLOBEX.rid));
    const [, args] = DATA_COMMANDS[3];

    const run = await cli([...args, '--ontology', 'globex', ...FLAGS], { fetch, env });

    expect(run.code).toBe(0);

    expect(fetch.calls.filter(({ method }) => method === 'POST').map(pathOf)).toEqual([
      `${LIST_PATH}/${GLOBEX.rid}/actions/com.example.twin.create-engagement/apply`,
    ]);
  });

  it.each([
    ['1 listed Ontology', [ACME], ['acme']],
    ['2 listed Ontologies', [ACME, GLOBEX], ['acme', 'globex']],
  ] as const)(
    'service/cli#ontology: an --ontology value that is not in the list stops the command, with %s',
    async (_, listed, names) => {
      const fetch = stubFetch(stubOntologies(...listed), stubConfig, ontologyAt(ACME.rid), ontologyAt(GLOBEX.rid));

      const run = await cli([...DATA_COMMANDS[3][1], '--ontology', 'nope', ...FLAGS], { fetch, env });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message: `The Organization has no Ontology with the API name nope. It has these: ${names.join(', ')}.`,
        ontologies: names,
      });

      expect(calledPaths(fetch.calls)).toEqual([CONFIG_PATH, LIST_PATH]);
    },
  );

  it.each([
    ['no flag', []],
    ['--ontology', ['--ontology', 'acme']],
  ] as const)(
    'service/cli#ontology: with no listed Ontology and %s, the error says that an admin must install one, and names ontology install',
    async (_, flag) => {
      const fetch = stubFetch(stubOntologies(), stubConfig);

      const run = await cli([...DATA_COMMANDS[3][1], ...flag, ...FLAGS], { fetch, env });

      expect(run.code).toBe(1);

      expect(run.error).toEqual({
        message:
          'The Organization has no Ontology. An admin of the Organization must install one: ontos install <product> --api-name <name> --display-name <name>',
      });

      expect(calledPaths(fetch.calls)).toEqual([CONFIG_PATH, LIST_PATH]);
    },
  );

  it('a command that reads no Ontology data refuses --ontology', async () => {
    const fetch = stubFetch(stubConfig);

    const run = await cli(['validate', '--ontology', 'acme', ...FLAGS], { fetch, env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual({ message: 'ontos validate does not take --ontology.' });
    expect(fetch.calls).toEqual([]);
  });

  it('service/cli#ontology: a token with no Organization prints the error body of the service, and tells the person to join or create an Organization', async () => {
    const body = {
      errorCode: 'PERMISSION_DENIED',
      errorName: 'OntologyService:NoOrganization',
      errorInstanceId: '1c5f8a2e-1b4d-4e1a-9f3a-2d7c6b5a4e3f',
      parameters: {},
    };

    const noOrganization: Handler = (call) =>
      pathOf(call) === LIST_PATH ? Response.json(body, { status: 403 }) : undefined;

    const fetch = stubFetch(noOrganization, stubConfig);

    const run = await cli(['describe', ...FLAGS], { fetch, env });

    expect(run.code).toBe(1);

    expect(run.error).toEqual({
      ...body,
      message:
        'This token has no Organization. Run ontos login --app twin --env staging. If you belong to none, join or create an Organization.',
    });
  });

  it('service/cli#ontology: another 403 prints the error body of the service with no added message', async () => {
    const body = {
      errorCode: 'PERMISSION_DENIED',
      errorName: 'Default:PermissionDenied',
      errorInstanceId: '1c5f8a2e-1b4d-4e1a-9f3a-2d7c6b5a4e3f',
      parameters: {},
    };

    const denied: Handler = (call) => (pathOf(call) === LIST_PATH ? Response.json(body, { status: 403 }) : undefined);

    const run = await cli(['describe', ...FLAGS], { fetch: stubFetch(denied, stubConfig), env });

    expect(run.code).toBe(1);
    expect(run.error).toEqual(body);
  });

  it('service/cli#ontology: a .env that names an Ontology changes nothing', async () => {
    const cwd = tempFolder({ '.env': `ONTOLOGY_RID=${ACME.rid}\nONTOLOGY_API_NAME=acme\n` });
    const two = stubFetch(stubOntologies(ACME, GLOBEX), stubConfig, ontologyAt(ACME.rid));

    const stopped = await cli(['describe', ...FLAGS], { fetch: two, env, cwd });

    expect(stopped.code).toBe(1);

    expect(stopped.error).toEqual({
      message: 'The Organization has more than 1 Ontology, so pass --ontology <apiName> with 1 of these: acme, globex.',
      ontologies: ['acme', 'globex'],
    });

    expect(calledPaths(two.calls)).toEqual([CONFIG_PATH, LIST_PATH]);

    const one = stubFetch(stubOntologies(GLOBEX), stubConfig, ontologyAt(GLOBEX.rid));

    const read = await cli(['describe', ...FLAGS], { fetch: one, env, cwd });

    expect(read.error).toBeUndefined();
    expect(read.code).toBe(0);
    expect(calledPaths(one.calls)).toEqual([CONFIG_PATH, LIST_PATH, `${LIST_PATH}/${GLOBEX.rid}/fullMetadata`]);
  });
});
