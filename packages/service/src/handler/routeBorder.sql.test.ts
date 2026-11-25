import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbFailure } from '../db/index.ts';
import { ApiError, type AsyncFallible } from '../errors/index.ts';
import { handle, handleTrusted, routes, type HandleInput, type RouteAnswer, type TrustedInput } from './index.ts';
import { startInstalled, type InstalledOntology } from './handler.test-utils.ts';
import { type CompiledOntology } from '../ontology/index.ts';
import {
  compileOrThrow,
  irOf,
  NS,
  ONTOLOGY_RID,
  stored,
  twinBlock,
  twinFunctions,
} from '../ontology/stored.test-utils.ts';
import {
  emptyDb,
  TEST_READER,
  testMcpSettings,
  testSettings,
  timeLeft,
  trustedSnapshot,
} from '../service.test-utils.ts';
import { createTestIssuer, ORGANIZATION, PERSON } from '../tokens.test-utils.ts';

const ACCOUNT = `${NS}Account`;
const REFUSED = new ApiError(409, 'Probe:Refused', { probe: 'border' }, { 'retry-after': '1' });

const FAILED: DbFailure = {
  kind: 'unavailable',
  error: Object.assign(new Error('connection lost'), { code: '08006' }),
};

let installed: InstalledOntology;
let ontology: CompiledOntology;
let input: HandleInput;
let workos: string;
let authkit: string;
let github: string;

beforeAll(async () => {
  const ir = irOf(twinBlock('0.6.3', ACCOUNT));

  installed = await startInstalled(ir, { ...twinFunctions('0.4.0'), discovered: [] });

  ontology = compileOrThrow(stored(ir));

  const issuer = await createTestIssuer(testSettings.auth);

  input = { ...installed.input, settings: testMcpSettings, keys: issuer.keys };

  workos = await issuer.workos();

  authkit = await issuer.authkit();

  github = await issuer.github();
});

afterAll(async () => {
  await installed?.stop();
});

async function seen(response: Response): Promise<unknown> {
  const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== 'date'));

  const body = (await response.text())
    .replace(/"errorInstanceId":"[^"]*"/g, '"errorInstanceId":"?"')
    .replace(/\\"errorInstanceId\\":\\"[^"\\]*\\"/g, '\\"errorInstanceId\\":\\"?\\"');

  return { status: response.status, headers, body };
}

type Failure = ApiError | DbFailure;

async function answerWhen(
  method: string,
  path: string,
  form: 'throw' | 'yield',
  failure: Failure,
  send: () => Promise<Response>,
): Promise<unknown> {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);

  if (!route) throw new Error(`No route ${method} ${path}.`);

  const thrown = 'kind' in failure ? failure.error : failure;

  const run =
    form === 'throw'
      ? () => Promise.reject(thrown)
      : async function* (): AsyncFallible<Response, Failure> {
          return yield failure;
        };

  // oxlint-disable-next-line landmines/no-test-doubles -- Compares the throw and yield forms of 1 chosen failure: a real route has 1 form only.
  const spy = vi.spyOn(route as { run: (...args: never[]) => RouteAnswer }, 'run').mockImplementation(run);

  try {
    const answer = await seen(await send());

    expect(spy, `${method} ${path} ran`).toHaveBeenCalled();

    return answer;
  } finally {
    spy.mockRestore();
  }
}

const FOUNDRY = '/api/v2/ontologies/{ontology}';
const at = (path: string) => `http://localhost${path.replace('{ontology}', ONTOLOGY_RID).replace('{action}', 'probe')}`;

const request = (method: string, path: string, token?: string, body?: unknown) =>
  new Request(at(path), {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });

const KINDS: [kind: string, method: string, path: string, send: () => Promise<Response>][] = [
  [
    'ontology',
    'GET',
    `${FOUNDRY}/fullMetadata`,
    () => handle(request('GET', `${FOUNDRY}/fullMetadata`, workos), input),
  ],
  [
    'ontology with writes',
    'POST',
    `${FOUNDRY}/actions/{action}/apply`,
    () => handle(request('POST', `${FOUNDRY}/actions/{action}/apply`, workos, { parameters: {} }), input),
  ],
  ['organization', 'GET', '/api/v2/ontologies', () => handle(request('GET', '/api/v2/ontologies', workos), input)],
  [
    'publish',
    'POST',
    '/api/ontology-service/v1/publish',
    () => handle(request('POST', '/api/ontology-service/v1/publish', github), input),
  ],
  [
    'mcp',
    'POST',
    '/api/mcp',
    () => handle(request('POST', '/api/mcp', authkit, { jsonrpc: '2.0', id: 1, method: 'ping' }), input),
  ],
  [
    'users',
    'GET',
    '/api/v2/admin/users/getCurrent',
    () => handle(request('GET', '/api/v2/admin/users/getCurrent', workos), input),
  ],
  [
    'token',
    'POST',
    '/multipass/api/oauth2/token',
    () =>
      handle(
        new Request(at('/multipass/api/oauth2/token'), { method: 'POST', body: 'grant_type=client_credentials' }),
        input,
      ),
  ],
  [
    'public',
    'GET',
    '/api/ontology-service/v1/client-config',
    () => handle(request('GET', '/api/ontology-service/v1/client-config'), input),
  ],
];

describe('service/code-layout#errors: a route of each kind answers the same when it yields its failure', () => {
  it.each(KINDS)('%s, with an ApiError', async (_kind, method, path, send) => {
    const thrown = await answerWhen(method, path, 'throw', REFUSED, send);

    expect(thrown).toMatchObject({ status: expect.any(Number) });

    expect(await answerWhen(method, path, 'yield', REFUSED, send)).toEqual(thrown);
  });

  it.each(KINDS)('%s, with a DbFailure', async (_kind, method, path, send) => {
    expect(await answerWhen(method, path, 'yield', FAILED, send)).toEqual(
      await answerWhen(method, path, 'throw', FAILED, send),
    );
  });

  it.each([
    ['a read', 'POST', `${FOUNDRY}/objectSets/loadObjects`, 'load_objects', { objectType: ACCOUNT }],
    ['a write', 'POST', `${FOUNDRY}/actions/{action}/apply`, 'apply_action', { actionType: 'probe', parameters: {} }],
  ])('the MCP runRoute of %s', async (_kind, method, path, tool, args) => {
    const send = () =>
      handle(
        request('POST', '/api/mcp', authkit, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
        input,
      );

    expect(await answerWhen(method, path, 'yield', REFUSED, send)).toEqual(
      await answerWhen(method, path, 'throw', REFUSED, send),
    );
  });

  it('handleTrusted', async () => {
    const path = `${FOUNDRY}/objectSets/loadObjects`;

    const trusted: TrustedInput = {
      db: trustedSnapshot(emptyDb),
      reader: TEST_READER,
      ontology,
      caller: { user: PERSON, kind: 'person', organization: ORGANIZATION, permissions: [] },
      checkWrite: timeLeft,
    };

    const send = () =>
      handleTrusted(
        new Request(`https://ontology-service.invalid${path.replace('{ontology}', ONTOLOGY_RID)}`, {
          method: 'POST',
          body: '{}',
        }),
        trusted,
      );

    expect(await answerWhen('POST', path, 'yield', REFUSED, send)).toEqual(
      await answerWhen('POST', path, 'throw', REFUSED, send),
    );
  });
});
